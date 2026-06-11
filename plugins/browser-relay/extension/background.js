import {
  buildRelayWsUrl,
  isLastRemainingTab,
  isMissingTabError,
  isRetryableReconnectError,
  reconnectDelayMs,
} from './background-utils.js'

const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let relayGatewayToken = ''
/** @type {string|null} */
let relayConnectRequestId = null

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// Per-tab operation locks prevent double-attach races.
/** @type {Set<number>} */
const tabOperationLocks = new Set()

// Tabs currently in a detach/re-attach cycle after navigation.
/** @type {Set<number>} */
const reattachPending = new Set()

// Tabs the agent itself opened (via Target.createTarget). Only these may be
// closed by Target.closeTarget — the agent must never close a user's own tab.
/** @type {Set<number>} */
const agentTabs = new Set()

// Fixed-size ring buffer of recent relay traffic, surfaced in the popup for
// diagnostics without opening the service-worker devtools.
const LOG_CAP = 200
/** @type {Array<{ts:number, dir:string, method:string}>} */
const logRing = new Array(LOG_CAP)
let logSeq = 0
function pushLog(dir, method) {
  logRing[logSeq % LOG_CAP] = { ts: Date.now(), dir, method }
  logSeq++
}
function getLogBuffer(limit = 100) {
  const n = Math.min(limit, Math.min(logSeq, LOG_CAP))
  const out = []
  for (let i = logSeq - n; i < logSeq; i++) {
    const e = logRing[((i % LOG_CAP) + LOG_CAP) % LOG_CAP]
    if (e) out.push(e)
  }
  return out
}

// True when the last connect attempt could not even reach the relay (preflight
// failed). Shortens reconnect backoff so we re-attach fast once the relay comes
// back, instead of waiting out the full 30s ramp.
let serverUnreachable = false

// Reconnect state for exponential backoff.
let reconnectAttempt = 0
let reconnectTimer = null

const TAB_VALIDATION_ATTEMPTS = 2
const TAB_VALIDATION_RETRY_DELAY_MS = 1000

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function validateAttachedTab(tabId) {
  try {
    await chrome.tabs.get(tabId)
  } catch {
    return false
  }

  for (let attempt = 0; attempt < TAB_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      })
      return true
    } catch (err) {
      if (isMissingTabError(err)) {
        return false
      }
      if (attempt < TAB_VALIDATION_ATTEMPTS - 1) {
        await sleep(TAB_VALIDATION_RETRY_DELAY_MS)
      }
    }
  }

  return false
}

// Relay connection config. `relayBaseUrl` blank = local loopback (default,
// unchanged behavior). A non-blank value (e.g. https://host/browser-relay)
// routes to a remote relay behind a reverse proxy; `relayPort` is then only the
// relay's internal port, used to derive the token.
async function getRelayConfig() {
  const stored = await chrome.storage.local.get(['relayBaseUrl', 'relayPort'])
  const n = Number.parseInt(String(stored.relayPort || ''), 10)
  const port = !Number.isFinite(n) || n <= 0 || n > 65535 ? DEFAULT_PORT : n
  const baseUrl = String(stored.relayBaseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  const httpBase = baseUrl || `http://127.0.0.1:${port}`
  return { httpBase, port }
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(['gatewayToken'])
  const token = String(stored.gatewayToken || '').trim()
  return token || ''
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

// ── Agent tab group + "agent is driving" indicator ──
// Agent-created tabs are corralled into one labeled, colored tab group so the
// user sees at a glance which tabs OpenClaw controls. While the relay is
// connected and at least one agent tab exists, the group title animates a
// spinner — an honest, always-visible signal that the agent may be acting.
const AGENT_GROUP_TITLE = 'OpenClaw Agent'
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let agentGroupId = null
let groupQueue = Promise.resolve()
let spinnerTimer = null
let spinnerFrame = 0
let spinnerStatic = false

function groupTitleMatches(title) {
  const t = String(title || '')
  // Tolerate the spinner prefix so we still recover the group after a restart.
  return t === AGENT_GROUP_TITLE || t.endsWith(` ${AGENT_GROUP_TITLE}`)
}

// Serialize group operations: concurrent chrome.tabs.group calls would each
// spawn a separate group. Reuse a cached or by-title-recovered group so the
// agent's tabs stay in one place across service-worker restarts.
function addToAgentGroup(tabId) {
  groupQueue = groupQueue.then(async () => {
    try {
      if (agentGroupId != null) {
        try {
          await chrome.tabGroups.get(agentGroupId)
        } catch {
          agentGroupId = null
        }
      }
      if (agentGroupId == null) {
        const groups = await chrome.tabGroups.query({}).catch(() => [])
        const existing = groups.find((g) => groupTitleMatches(g.title))
        if (existing) agentGroupId = existing.id
      }
      const gid = await chrome.tabs.group(
        agentGroupId != null ? { tabIds: tabId, groupId: agentGroupId } : { tabIds: tabId },
      )
      agentGroupId = gid
      await chrome.tabGroups.update(gid, { title: AGENT_GROUP_TITLE, color: 'blue' }).catch(() => {})
    } catch {
      // Grouping is best-effort cosmetics; never block automation on it.
    }
  })
  return groupQueue
}

// Spinner runs only while the relay WS is open (which keeps the MV3 service
// worker alive) AND the agent owns at least one tab.
function refreshIndicator() {
  const active = Boolean(relayWs && relayWs.readyState === WebSocket.OPEN) && agentTabs.size > 0
  if (active) startSpinner()
  else stopSpinner()
}

function startSpinner() {
  if (spinnerTimer) return
  // Animate only while actually driving (a CDP command in the last ~15s). When
  // the agent owns tabs but is idle, show a static title — so the spinner means
  // "working now", not "spinning forever after a finished task".
  spinnerTimer = setInterval(() => {
    if (agentGroupId == null) return
    const now = Date.now()
    let driving = false
    for (const [tabId, tab] of tabs.entries()) {
      if (agentTabs.has(tabId) && tab.lastActivityAt && now - tab.lastActivityAt < 15000) {
        driving = true
        break
      }
    }
    if (driving) {
      const frame = SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]
      void chrome.tabGroups.update(agentGroupId, { title: `${frame} ${AGENT_GROUP_TITLE}` }).catch(() => {})
      spinnerStatic = false
    } else if (!spinnerStatic) {
      void chrome.tabGroups.update(agentGroupId, { title: AGENT_GROUP_TITLE }).catch(() => {})
      spinnerStatic = true
    }
  }, 200)
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = null
  }
  if (agentGroupId != null) {
    void chrome.tabGroups.update(agentGroupId, { title: AGENT_GROUP_TITLE }).catch(() => {})
  }
}

// Persist attached tab state to survive MV3 service worker restarts.
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({
      persistedTabs: tabEntries,
      nextSession,
      agentTabs: [...agentTabs],
    })
  } catch {
    // chrome.storage.session may not be available in all contexts.
  }
}

// Rehydrate tab state on service worker startup. Fast path — just restores
// maps and badges. Relay reconnect happens separately in background.
async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession', 'agentTabs'])
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession)
    }
    for (const id of stored.agentTabs || []) agentTabs.add(id)
    const entries = stored.persistedTabs || []
    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: 'connected',
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
        lastActivityAt: Date.now(),
      })
      tabBySession.set(entry.sessionId, entry.tabId)
      setBadge(entry.tabId, 'on')
    }
    // Retry once so transient busy/navigation states do not permanently drop
    // a still-attached tab after a service worker restart.
    for (const entry of entries) {
      const valid = await validateAttachedTab(entry.tabId)
      if (!valid) {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        agentTabs.delete(entry.tabId)
        setBadge(entry.tabId, 'off')
      }
    }
    // Drop ownership for agent tabs the user closed while the worker was dead.
    for (const id of [...agentTabs]) {
      try {
        await chrome.tabs.get(id)
      } catch {
        agentTabs.delete(id)
      }
    }
    // Recover the cached agent group id so the spinner resumes after a restart.
    if (agentTabs.size > 0) {
      try {
        const groups = await chrome.tabGroups.query({})
        const existing = groups.find((g) => groupTitleMatches(g.title))
        if (existing) agentGroupId = existing.id
      } catch {
        // tabGroups may be unavailable; spinner stays off until next open.
      }
    }
  } catch {
    // Ignore rehydration errors.
  }
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const { httpBase, port } = await getRelayConfig()
    const gatewayToken = await getGatewayToken()
    const wsUrl = await buildRelayWsUrl(httpBase, port, gatewayToken)

    // Fast preflight: is the relay reachable? /json/version is the one HTTP path
    // exposed publicly alongside the /extension WS; an unauthenticated HEAD may
    // return 401, but any non-network response still proves reachability.
    try {
      await fetch(`${httpBase}/json/version`, { method: 'HEAD', signal: AbortSignal.timeout(3000) })
      serverUnreachable = false
    } catch (err) {
      serverUnreachable = true
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    relayGatewayToken = gatewayToken
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || '')))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    // Bind permanent handlers. Guard against stale socket: if this WS was
    // replaced before its close fires, the handler is a no-op.
    ws.onclose = () => {
      if (ws !== relayWs) return
      onRelayClosed('closed')
    }
    ws.onerror = () => {
      if (ws !== relayWs) return
      onRelayClosed('error')
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
  } finally {
    relayConnectPromise = null
  }
}

// Relay closed — update badges, reject pending requests, auto-reconnect.
// Debugger sessions are kept alive so they survive transient WS drops.
function onRelayClosed(reason) {
  relayWs = null
  relayGatewayToken = ''
  relayConnectRequestId = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  reattachPending.clear()

  // Relay dropped — kill the "agent active" spinner; it is no longer honest.
  stopSpinner()

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      })
    }
  }

  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  // When the relay is unreachable, cap backoff low so we re-attach quickly once
  // it returns; for other errors use the normal ramp to avoid hammering.
  const delay = serverUnreachable
    ? reconnectDelayMs(reconnectAttempt, { baseMs: 500, maxMs: 3000, jitterMs: 1000, random: Math.random })
    : reconnectDelayMs(reconnectAttempt)
  reconnectAttempt++

  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      console.log('Reconnected successfully')
      await reannounceAttachedTabs()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`)
      if (!isRetryableReconnectError(err)) {
        return
      }
      scheduleReconnect()
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
}

// Re-announce all attached tabs to the relay after reconnect.
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue

    // Retry once here as well; reconnect races can briefly make an otherwise
    // healthy tab look unavailable.
    const valid = await validateAttachedTab(tabId)
    if (!valid) {
      tabs.delete(tabId)
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach/detach)',
      })
      continue
    }

    // Send fresh attach event to relay.
    // Split into two try-catch blocks so debugger failures and relay send
    // failures are handled independently. Previously, a relay send failure
    // would fall into the outer catch and set the badge to 'on' even though
    // the relay had no record of the tab — causing every subsequent browser
    // tool call to fail with "no tab connected" until the next reconnect cycle.
    let targetInfo
    try {
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      targetInfo = info?.targetInfo
    } catch {
      // Target.getTargetInfo failed. Preserve at least targetId from
      // cached tab state so relay receives a stable identifier.
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined
    }

    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to detach)',
      })
    } catch {
      // Relay send failed (e.g. WS closed in the gap between ensureRelayConnection
      // resolving and this loop executing). The tab is still valid — leave badge
      // as 'connecting' so the reconnect/keepalive cycle will retry rather than
      // showing a false-positive 'on' that hides the broken state from the user.
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      })
    }
  }

  await persistState()
  refreshIndicator()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  pushLog(
    '↑',
    payload?.method === 'forwardCDPEvent'
      ? `evt:${payload?.params?.method || '?'}`
      : payload?.method || payload?.type || (payload?.id != null ? 'res' : '?'),
  )
  ws.send(JSON.stringify(payload))
}

function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  sendToRelay({
    type: 'req',
    id: relayConnectRequestId,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'chrome-relay-extension',
        version: '1.0.0',
        platform: 'chrome-extension',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      nonce: nonce || undefined,
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  })
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Relay request timeout (30s)'))
    }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      sendToRelay(command)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.type === 'event' && msg.event === 'connect.challenge') {
    try {
      ensureGatewayHandshakeStarted(msg.payload)
    } catch (err) {
      console.warn('gateway connect handshake start failed', err instanceof Error ? err.message : String(err))
      relayConnectRequestId = null
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.type === 'res' && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null
    if (!msg.ok) {
      const detail = msg?.error?.message || msg?.error || 'gateway connect failed'
      console.warn('gateway connect handshake rejected', String(detail))
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    pushLog('↓', `cmd:${String(msg?.params?.method || '?')}`)
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sid = nextSession++
  const sessionId = `cb-tab-${sid}`
  const attachOrder = sid

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder, lastActivityAt: Date.now() })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  await persistState()

  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  // Send detach events for child sessions first.
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.detachedFromTarget',
            params: { sessionId: childSessionId, reason: 'parent_detached' },
          },
        })
      } catch {
        // Relay may be down.
      }
      childSessionToTab.delete(childSessionId)
    }
  }

  // Send detach event for main session.
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // May already be detached.
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })

  await persistState()
}

// Idle cleanup window: an agent tab with no CDP command for this long is
// treated as "task finished" — released (debugger detached) and closed.
const IDLE_CLOSE_MS = 3 * 60 * 1000

// Release an agent tab: detach (clears the debugger banner / relay mode), then
// close it — unless the user is actively viewing it, in which case keep it open.
async function reapAgentTab(tabId, reason) {
  agentTabs.delete(tabId)
  await detachTab(tabId, reason)
  try {
    const info = await chrome.tabs.get(tabId)
    if (info.active) return // user is looking at it — detach only, keep the tab
    const allTabs = await chrome.tabs.query({})
    if (!isLastRemainingTab(allTabs, tabId)) await chrome.tabs.remove(tabId)
  } catch {
    // Tab already gone.
  }
}

// Manual "stop & clean up": detach every attached tab; close the agent-created
// ones. Tabs the user attached themselves are detached but never closed.
async function releaseAllTabs() {
  let detached = 0
  let closed = 0
  for (const tabId of [...tabs.keys()]) {
    const wasAgent = agentTabs.delete(tabId)
    await detachTab(tabId, 'manual-release')
    detached++
    if (wasAgent) {
      try {
        const allTabs = await chrome.tabs.query({})
        if (!isLastRemainingTab(allTabs, tabId)) {
          await chrome.tabs.remove(tabId)
          closed++
        }
      } catch {
        // Tab already gone.
      }
    }
  }
  refreshIndicator()
  return { detached, closed }
}

// Release a single tab (popup per-tab control): detach, and close it too if the
// agent owns it.
async function releaseTab(tabId) {
  const wasAgent = agentTabs.delete(tabId)
  await detachTab(tabId, 'manual-release')
  if (wasAgent) {
    try {
      const allTabs = await chrome.tabs.query({})
      if (!isLastRemainingTab(allTabs, tabId)) await chrome.tabs.remove(tabId)
    } catch {
      // Tab already gone.
    }
  }
  refreshIndicator()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  // Prevent concurrent operations on the same tab.
  if (tabOperationLocks.has(tabId)) return
  tabOperationLocks.add(tabId)

  try {
    if (reattachPending.has(tabId)) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach/detach)',
      })
      return
    }

    const existing = tabs.get(tabId)
    if (existing?.state === 'connected') {
      await detachTab(tabId, 'toggle')
      return
    }

    // User is manually connecting — cancel any pending reconnect.
    cancelReconnect()

    tabs.set(tabId, { state: 'connecting' })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: connecting to local relay…',
    })

    try {
      await ensureRelayConnection()
      await attachTab(tabId)
    } catch (err) {
      tabs.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
      })
      void maybeOpenHelpOnce()
      const message = err instanceof Error ? err.message : String(err)
      console.warn('attach failed', message, nowStack())
    }
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Target.createTarget opens a brand-new tab, so it must run BEFORE the
  // attached-tab gate below — otherwise the very first open (no tabs attached
  // yet) fails with "No attached tab". The new tab is auto-attached, which is
  // what makes fully autonomous open work (no manual toolbar click needed).
  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    // Track ownership before attach so close-gating and cleanup stay correct
    // even if a quick close races the attach below.
    agentTabs.add(tab.id)
    void addToAgentGroup(tab.id)
    await new Promise((r) => setTimeout(r, 100))
    try {
      const attached = await attachTab(tab.id)
      refreshIndicator()
      return { targetId: attached.targetId }
    } catch (err) {
      // Attach failed — roll back so we never leave an orphan agent tab.
      agentTabs.delete(tab.id)
      try {
        await chrome.tabs.remove(tab.id)
      } catch {
        // Tab already gone.
      }
      throw err
    }
  }

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  // Stamp activity so the idle reaper and the spinner know this tab is in use.
  const activeEntry = tabs.get(tabId)
  if (activeEntry) activeEntry.lastActivityAt = Date.now()

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    // Safety: the agent may only close tabs it opened itself (via
    // Target.createTarget). Never close a user's own tab, even if attached.
    if (!agentTabs.has(toClose)) {
      return {
        success: false,
        error: 'Refusing to close a tab the agent did not open. Only agent-opened tabs can be closed.',
      }
    }
    try {
      const allTabs = await chrome.tabs.query({})
      if (isLastRemainingTab(allTabs, toClose)) {
        console.warn('Refusing to close the last tab: this would kill the browser process')
        return { success: false, error: 'Cannot close the last tab' }
      }
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    agentTabs.delete(toClose)
    refreshIndicator()
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // Relay may be down.
  }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // User explicitly cancelled or DevTools replaced the connection — respect their intent
  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  // Check if tab still exists — distinguishes navigation from tab close
  let tabInfo
  try {
    tabInfo = await chrome.tabs.get(tabId)
  } catch {
    // Tab is gone (closed) — normal cleanup
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  const oldSessionId = oldTab?.sessionId
  const oldTargetId = oldTab?.targetId

  if (oldSessionId) tabBySession.delete(oldSessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: 'navigation-reattach' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attaching after navigation…',
  })

  // Extend re-attach window from 2.5 s to ~7.7 s (5 attempts).
  // SPAs and pages with heavy JS can take >2.5 s before the Chrome debugger
  // is attachable, causing all three original attempts to fail and leaving
  // the badge permanently off after every navigation.
  const delays = [200, 500, 1000, 2000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]))

    if (!reattachPending.has(tabId)) return

    try {
      await chrome.tabs.get(tabId)
    } catch {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      return
    }

    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN

    try {
      // When relay is down, still attach the debugger but skip sending the
      // relay event. reannounceAttachedTabs() will notify the relay once it
      // reconnects, so the tab stays tracked across transient relay drops.
      await attachTab(tabId, { skipAttachedEvent: !relayUp })
      reattachPending.delete(tabId)
      if (!relayUp) {
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({
          tabId,
          title: 'OpenClaw Browser Relay: attached, waiting for relay reconnect…',
        })
      }
      return
    } catch {
      // continue retries
    }
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attach failed (click to retry)',
  })
}

// Tab lifecycle listeners — clean up stale entries.
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId)
  const wasAgent = agentTabs.delete(tabId)
  if (!tabs.has(tabId)) {
    if (wasAgent) refreshIndicator()
    return
  }
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }
  void persistState()
  refreshIndicator()
}))

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(() => {
  const tab = tabs.get(removedTabId)
  if (!tab) return
  if (agentTabs.delete(removedTabId)) agentTabs.add(addedTabId)
  tabs.delete(removedTabId)
  tabs.set(addedTabId, tab)
  if (tab.sessionId) {
    tabBySession.set(tab.sessionId, addedTabId)
  }
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === removedTabId) {
      childSessionToTab.set(childSessionId, addedTabId)
    }
  }
  setBadge(addedTabId, 'on')
  void persistState()
}))

// Register debugger listeners at module scope so detach/event handling works
// even when the relay WebSocket is down.
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

// Toolbar click now opens the popup (manifest action.default_popup); the popup
// triggers manual attach/detach of the active tab via the toggleActiveTab
// message. connectOrToggleForActiveTab stays the single entry point for both.

// Refresh badge after navigation completes — service worker may have restarted
// during navigation, losing ephemeral badge state.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(() => {
  if (frameId !== 0) return
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

// Refresh badge when user switches to an attached tab.
chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

// MV3 keepalive via chrome.alarms — more reliable than setInterval across
// service worker restarts. Checks relay health and refreshes badges.
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise

  // Refresh badges (ephemeral in MV3).
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
    }
  }

  // Idle reaper: an agent tab with no CDP command for IDLE_CLOSE_MS is treated
  // as a finished task — release the debugger (clears the banner / relay mode)
  // and close it (unless the user is viewing it). Stops agent tabs piling up.
  const idleNow = Date.now()
  for (const [tabId, tab] of [...tabs.entries()]) {
    if (tab.state !== 'connected' || !agentTabs.has(tabId)) continue
    if (!tab.lastActivityAt || idleNow - tab.lastActivityAt <= IDLE_CLOSE_MS) continue
    await reapAgentTab(tabId, 'idle-timeout')
  }

  // If relay is down and no reconnect is in progress, trigger one.
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log('Keepalive: WebSocket unhealthy, triggering reconnect')
      await ensureRelayConnection().catch(() => {
        // ensureRelayConnection may throw without triggering onRelayClosed
        // (e.g. preflight fetch fails before WS is created), so ensure
        // reconnect is always scheduled on failure.
        if (!reconnectTimer) {
          scheduleReconnect()
        }
      })
    }
  }
})

// Rehydrate state on service worker startup. Split: rehydration is the gate
// (fast), relay reconnect runs in background (slow, non-blocking).
const initPromise = rehydrateState()

initPromise.then(() => {
  // Always maintain the relay connection, even with no attached tabs, so the
  // agent can autonomously open the first tab via Target.createTarget without
  // any manual toolbar click.
  ensureRelayConnection().then(() => {
    reconnectAttempt = 0
    return reannounceAttachedTabs()
  }).catch(() => {
    scheduleReconnect()
  })
})

// Shared gate: all state-dependent handlers await this before accessing maps.
async function whenReady(fn) {
  await initPromise
  return fn()
}

// Popup status / control channel.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getRelayStatus') {
    const connected = Boolean(relayWs && relayWs.readyState === WebSocket.OPEN)
    let attached = 0
    for (const t of tabs.values()) if (t.state === 'connected') attached++
    sendResponse({
      connected,
      reconnecting: Boolean(reconnectTimer || relayConnectPromise),
      attachedTabs: attached,
      agentTabs: agentTabs.size,
    })
    return false
  }
  if (msg?.type === 'getTabList') {
    Promise.all(
      [...tabs.keys()].map(async (tabId) => {
        const t = tabs.get(tabId)
        let title = ''
        try {
          const info = await chrome.tabs.get(tabId)
          title = info.title || info.url || ''
        } catch {
          // tab gone
        }
        return { tabId, state: t?.state, isAgent: agentTabs.has(tabId), title }
      }),
    ).then((list) => {
      try { sendResponse({ tabs: list }) } catch { /* channel closed */ }
    })
    return true
  }
  if (msg?.type === 'getLogs') {
    sendResponse({ logs: getLogBuffer(typeof msg.limit === 'number' ? msg.limit : 100) })
    return false
  }
  if (msg?.type === 'toggleActiveTab') {
    connectOrToggleForActiveTab()
      .then(() => {
        try { sendResponse({ ok: true }) } catch { /* channel closed */ }
      })
      .catch((e) => {
        try { sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }) } catch { /* channel closed */ }
      })
    return true
  }
  if (msg?.type === 'reconnectNow') {
    cancelReconnect()
    ensureRelayConnection()
      .then(() => reannounceAttachedTabs())
      .then(() => {
        try { sendResponse({ ok: true }) } catch { /* channel closed */ }
      })
      .catch((e) => {
        scheduleReconnect()
        try { sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }) } catch { /* channel closed */ }
      })
    return true
  }
  if (msg?.type === 'releaseAll') {
    releaseAllTabs()
      .then((r) => {
        try { sendResponse({ ok: true, ...r }) } catch { /* channel closed */ }
      })
      .catch((e) => {
        try { sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }) } catch { /* channel closed */ }
      })
    return true
  }
  if (msg?.type === 'releaseTab' && typeof msg.tabId === 'number') {
    releaseTab(msg.tabId)
      .then(() => {
        try { sendResponse({ ok: true }) } catch { /* channel closed */ }
      })
      .catch((e) => {
        try { sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }) } catch { /* channel closed */ }
      })
    return true
  }
  return false
})

// Relay check handler for the options page. The service worker has
// host_permissions and bypasses CORS preflight, so the options page
// delegates token-validation requests here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'relayCheck') return false
  const { url, token } = msg
  const headers = token ? { 'x-openclaw-relay-token': token } : {}
  fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      const contentType = String(res.headers.get('content-type') || '')
      let json = null
      if (contentType.includes('application/json')) {
        try {
          json = await res.json()
        } catch {
          json = null
        }
      }
      sendResponse({ status: res.status, ok: res.ok, contentType, json })
    })
    .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }))
  return true
})
