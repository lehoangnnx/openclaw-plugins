import { deriveRelayToken } from './background-utils.js'
import { classifyRelayCheckException, classifyRelayCheckResponse } from './options-validation.js'

const DEFAULT_PORT = 18792

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

// Blank base URL = local loopback (default). A non-blank value such as
// https://openclaw-lehoang.fly.dev/browser-relay routes to a remote relay
// behind a reverse proxy; the port is still the relay's INTERNAL listening
// port, used only to derive the relay token.
function effectiveHttpBase(baseUrl, port) {
  const trimmed = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  return trimmed || `http://127.0.0.1:${port}`
}

function updateRelayUrl(baseUrl, port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `${effectiveHttpBase(baseUrl, port)}/extension`
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(baseUrl, port, token) {
  const url = `${effectiveHttpBase(baseUrl, port)}/json/version`
  const trimmedToken = String(token || '').trim()
  if (!trimmedToken) {
    setStatus('error', 'Gateway token required. Save your gateway token to connect.')
    return
  }
  try {
    const relayToken = await deriveRelayToken(trimmedToken, port)
    // Delegate the fetch to the background service worker to bypass CORS
    // preflight on the custom x-openclaw-relay-token header.
    const res = await chrome.runtime.sendMessage({
      type: 'relayCheck',
      url,
      token: relayToken,
    })
    const result = classifyRelayCheckResponse(res, port)
    if (result.action === 'throw') throw new Error(result.error)
    setStatus(result.kind, result.message)
  } catch (err) {
    const result = classifyRelayCheckException(err, port)
    setStatus(result.kind, result.message)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayBaseUrl', 'relayPort', 'gatewayToken'])
  const baseUrl = String(stored.relayBaseUrl || '').trim()
  const port = clampPort(stored.relayPort)
  const token = String(stored.gatewayToken || '').trim()
  document.getElementById('base-url').value = baseUrl
  document.getElementById('port').value = String(port)
  document.getElementById('token').value = token
  updateRelayUrl(baseUrl, port)
  await checkRelayReachable(baseUrl, port, token)
}

async function save() {
  const baseUrlInput = document.getElementById('base-url')
  const portInput = document.getElementById('port')
  const tokenInput = document.getElementById('token')
  const baseUrl = String(baseUrlInput.value || '')
    .trim()
    .replace(/\/+$/, '')
  const port = clampPort(portInput.value)
  const token = String(tokenInput.value || '').trim()
  await chrome.storage.local.set({ relayBaseUrl: baseUrl, relayPort: port, gatewayToken: token })
  baseUrlInput.value = baseUrl
  portInput.value = String(port)
  tokenInput.value = token
  updateRelayUrl(baseUrl, port)
  await checkRelayReachable(baseUrl, port, token)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()
