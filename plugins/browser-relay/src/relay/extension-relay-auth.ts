/**
 * Relay auth for the browser-relay plugin.
 *
 * This is a plugin-owned rewrite of OpenClaw core's removed
 * `src/browser/extension-relay-auth.ts`. The original derived the relay token
 * from the gateway's `gateway.auth.token` via OpenClaw config + SecretRef
 * resolution. The plugin must not import core config internals, so it resolves a
 * shared secret from its own environment instead and keeps the same HMAC derive
 * scheme + accepted-token contract the relay server depends on.
 *
 * Phase 2 (multi-tenant) replaces the single shared-secret model here with a
 * per-tenant token registry (SQLite): `resolveRelayAcceptedTokensForPort`
 * becomes a registry lookup keyed by tenant, not a single process secret.
 */
import { createHmac } from "node:crypto";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
const OPENCLAW_RELAY_BROWSER = "OpenClaw/extension-relay";

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Shared relay secret. Preference order:
 *   1. OPENCLAW_BROWSER_RELAY_TOKEN — plugin-specific, recommended.
 *   2. OPENCLAW_GATEWAY_TOKEN / CLAWDBOT_GATEWAY_TOKEN — what the extension
 *      Options page historically calls the "Gateway token", kept as a fallback
 *      so existing extension setups keep working.
 *
 * Returns null when nothing is configured; callers use this to avoid opening a
 * listening port for an unconfigured install.
 */
export function resolveRelaySharedSecret(): string | null {
  return (
    trimToUndefined(process.env.OPENCLAW_BROWSER_RELAY_TOKEN) ??
    trimToUndefined(process.env.OPENCLAW_GATEWAY_TOKEN) ??
    trimToUndefined(process.env.CLAWDBOT_GATEWAY_TOKEN) ??
    null
  );
}

function deriveRelayAuthToken(secret: string, port: number): string {
  return createHmac("sha256", secret).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

/**
 * Tokens the relay accepts for a given port. The derived per-port token is used
 * by the CDP consumer side (the `browser` tool, via
 * `getChromeExtensionRelayAuthHeaders`); the raw shared secret is what the
 * extension Options page sends. Both are accepted.
 */
export async function resolveRelayAcceptedTokensForPort(port: number): Promise<string[]> {
  const secret = resolveRelaySharedSecret();
  if (!secret) {
    throw new Error(
      "browser-relay requires a shared token (set OPENCLAW_BROWSER_RELAY_TOKEN or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  const derived = deriveRelayAuthToken(secret, port);
  return derived === secret ? [derived] : [derived, secret];
}

/** The primary (derived) relay token for a port. */
export async function resolveRelayAuthTokenForPort(port: number): Promise<string> {
  const [primary] = await resolveRelayAcceptedTokensForPort(port);
  if (!primary) {
    throw new Error("browser-relay: no relay token resolved");
  }
  return primary;
}

/**
 * Probe whether an already-listening relay on `baseUrl` is this plugin's relay
 * (vs. an unrelated process on the same port). Used during startup to safely
 * reuse an existing relay. Carries no core dependency.
 */
export async function probeAuthenticatedOpenClawRelay(params: {
  baseUrl: string;
  relayAuthHeader: string;
  relayAuthToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS,
  );
  try {
    const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
    const res = await fetch(versionUrl, {
      signal: controller.signal,
      headers: { [params.relayAuthHeader]: params.relayAuthToken },
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { Browser?: unknown };
    const browserName = typeof body?.Browser === "string" ? body.Browser.trim() : "";
    return browserName === OPENCLAW_RELAY_BROWSER;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
