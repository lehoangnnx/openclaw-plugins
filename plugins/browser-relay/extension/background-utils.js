export function reconnectDelayMs(
  attempt,
  opts = { baseMs: 1000, maxMs: 30000, jitterMs: 1000, random: Math.random },
) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : 1000;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 30000;
  const jitterMs = Number.isFinite(opts.jitterMs) ? opts.jitterMs : 1000;
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const safeAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  const backoff = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  return backoff + Math.max(0, jitterMs) * random();
}

export async function deriveRelayToken(gatewayToken, port) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`openclaw-extension-relay-v1:${port}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Convert an http(s) base URL to its ws(s) equivalent (trailing slash trimmed). */
export function httpBaseToWs(httpBaseUrl) {
  const base = String(httpBaseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (base.startsWith("https://")) return "wss://" + base.slice("https://".length);
  if (base.startsWith("http://")) return "ws://" + base.slice("http://".length);
  if (base.startsWith("wss://") || base.startsWith("ws://")) return base;
  throw new Error(`Relay URL must start with http(s):// or ws(s):// (got ${base || "empty"})`);
}

export async function buildRelayWsUrl(httpBaseUrl, port, gatewayToken) {
  const token = String(gatewayToken || "").trim();
  if (!token) {
    throw new Error(
      "Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)",
    );
  }
  // The token is derived against the relay's INTERNAL listening port (18792),
  // which stays the same even when the relay is reached remotely through a
  // reverse proxy on 443 — so derivation must not use the public port.
  const relayToken = await deriveRelayToken(token, port);
  const wsBase = httpBaseToWs(httpBaseUrl);
  return `${wsBase}/extension?token=${encodeURIComponent(relayToken)}`;
}

export function isRetryableReconnectError(err) {
  const message = err instanceof Error ? err.message : String(err || "");
  if (message.includes("Missing gatewayToken")) {
    return false;
  }
  return true;
}

export function isMissingTabError(err) {
  const message = (err instanceof Error ? err.message : String(err || "")).toLowerCase();
  return (
    message.includes("no tab with id") ||
    message.includes("no tab with given id") ||
    message.includes("tab not found")
  );
}

export function isLastRemainingTab(allTabs, tabIdToClose) {
  if (!Array.isArray(allTabs)) {
    return true;
  }
  return allTabs.filter((tab) => tab && tab.id !== tabIdToClose).length === 0;
}
