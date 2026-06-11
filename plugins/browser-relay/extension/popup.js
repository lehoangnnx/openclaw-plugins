// Popup UI: live relay status, tab counts, recent traffic, and manual controls.
// All state lives in the service worker; the popup is a thin view that polls it.

const byId = (id) => document.getElementById(id)

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
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
  // Newest first.
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
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getRelayStatus' })
    if (status) setStatus(status)
  } catch {
    // Service worker may be briefly asleep; next tick retries.
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getLogs', limit: 40 })
    renderLogs((res && res.logs) || [])
  } catch {
    // ignore
  }
}

byId('reconnect').addEventListener('click', async () => {
  const btn = byId('reconnect')
  btn.disabled = true
  try {
    await chrome.runtime.sendMessage({ type: 'reconnectNow' })
  } catch {
    // ignore
  }
  setTimeout(() => {
    btn.disabled = false
    void refresh()
  }, 700)
})

byId('attach').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'toggleActiveTab' })
  } catch {
    // ignore
  }
  setTimeout(refresh, 400)
})

byId('options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

void loadConfig()
void refresh()
setInterval(refresh, 1500)
