// Popup UI: live relay status, attached tabs, recent traffic, and controls.
// All state lives in the service worker; the popup is a thin view that polls it
// and sends control messages (stop & clean up, per-tab release, reconnect).

const byId = (id) => document.getElementById(id)

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

async function send(type, extra) {
  try {
    return await chrome.runtime.sendMessage({ type, ...(extra || {}) })
  } catch {
    return null
  }
}

// Mirror the service worker's relay-URL derivation so the popup shows where the
// extension is dialing (blank base = local loopback on the relay port).
async function loadConfig() {
  try {
    const s = await chrome.storage.local.get(['relayBaseUrl', 'relayPort'])
    const n = Number.parseInt(String(s.relayPort || ''), 10)
    const port = Number.isFinite(n) && n > 0 && n <= 65535 ? n : 18792
    const base = String(s.relayBaseUrl || '')
      .trim()
      .replace(/\/+$/, '')
    const httpBase = base || `http://127.0.0.1:${port}`
    byId('relay-url').textContent = `${httpBase}/extension`
  } catch {
    // storage unavailable — leave blank
  }
}

function setStatus(state) {
  const pill = byId('status')
  if (state.connected) {
    pill.textContent = 'Connected'
    pill.dataset.kind = 'ok'
  } else if (state.reconnecting) {
    pill.textContent = 'Connecting…'
    pill.dataset.kind = 'warn'
  } else {
    pill.textContent = 'Offline'
    pill.dataset.kind = 'off'
  }
  byId('stat-attached').textContent = String(state.attachedTabs ?? 0)
  byId('stat-agent').textContent = String(state.agentTabs ?? 0)
}

function renderTabs(list) {
  const ul = byId('tabs')
  ul.textContent = ''
  if (!list.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'No attached tabs'
    ul.appendChild(li)
    return
  }
  for (const t of list) {
    const li = document.createElement('li')
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.dataset.agent = String(Boolean(t.isAgent))
    tag.textContent = t.isAgent ? 'agent' : 'user'
    const ti = document.createElement('span')
    ti.className = 'ti'
    ti.textContent = t.title || `tab ${t.tabId}`
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = '✕'
    x.title = t.isAgent ? 'Detach & close' : 'Detach'
    x.addEventListener('click', async () => {
      x.disabled = true
      await send('releaseTab', { tabId: t.tabId })
      setTimeout(refresh, 300)
    })
    li.append(tag, ti, x)
    ul.appendChild(li)
  }
}

function renderLogs(logs) {
  const ul = byId('logs')
  ul.textContent = ''
  if (!logs.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'No activity yet'
    ul.appendChild(li)
    return
  }
  for (const e of logs.slice().reverse()) {
    const li = document.createElement('li')
    const dir = document.createElement('span')
    dir.className = 'dir'
    dir.textContent = e.dir
    const m = document.createElement('span')
    m.className = 'm'
    m.textContent = e.method
    const t = document.createElement('span')
    t.className = 't'
    t.textContent = fmtTime(e.ts)
    li.append(dir, m, t)
    ul.appendChild(li)
  }
}

async function refresh() {
  const status = await send('getRelayStatus')
  if (status) setStatus(status)
  const tabsRes = await send('getTabList')
  renderTabs((tabsRes && tabsRes.tabs) || [])
  const logsRes = await send('getLogs', { limit: 30 })
  renderLogs((logsRes && logsRes.logs) || [])
}

byId('stop').addEventListener('click', async () => {
  const btn = byId('stop')
  btn.disabled = true
  byId('hint').textContent = 'cleaning…'
  const r = await send('releaseAll')
  byId('hint').textContent = r && r.ok ? `detached ${r.detached}, closed ${r.closed}` : ''
  setTimeout(() => {
    btn.disabled = false
    void refresh()
    setTimeout(() => {
      byId('hint').textContent = ''
    }, 2500)
  }, 500)
})

byId('reconnect').addEventListener('click', async () => {
  const btn = byId('reconnect')
  btn.disabled = true
  await send('reconnectNow')
  setTimeout(() => {
    btn.disabled = false
    void refresh()
  }, 700)
})

byId('attach').addEventListener('click', async () => {
  await send('toggleActiveTab')
  setTimeout(refresh, 400)
})

byId('options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

void loadConfig()
void refresh()
setInterval(refresh, 1500)
