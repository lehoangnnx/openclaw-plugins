import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createBrowserFastTool } from "./browser-fast-tool.js";

const DEFAULT_RELAY_PORT = 18792;

/** Loopback CDP relay port. The extension dials `/extension`; the `browser` tool connects to `/cdp`. */
function resolveRelayPort(): number {
  const raw = process.env.OPENCLAW_BROWSER_RELAY_PORT?.trim();
  if (!raw) {
    return DEFAULT_RELAY_PORT;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_RELAY_PORT;
}

/**
 * Bind address for the relay server. Defaults to loopback. Set a non-loopback
 * address (e.g. `0.0.0.0`) only to expose `/extension` for remote setups
 * (Fly/Cloudflare, WSL2). The `/cdp` face must stay loopback-reachable for the
 * in-process `browser` tool; remote exposure of `/cdp` is hardened in Phase 1.
 */
function resolveRelayBindHost(): string | undefined {
  const raw = process.env.OPENCLAW_BROWSER_RELAY_BIND_HOST?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** Loopback CDP face the `browser` tool connects to via a cdpUrl profile. */
function relayCdpUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Long-lived relay service. It only opens a listening port when a shared token
 * is configured, so a bare install never exposes a listener; the token gate
 * lives in the relay auth module (`resolveRelaySharedSecret`).
 */
function createBrowserRelayService(): OpenClawPluginService {
  const port = resolveRelayPort();
  return {
    id: "browser-relay",
    start: async () => {
      const { resolveRelaySharedSecret } = await import("./relay/extension-relay-auth.js");
      if (!resolveRelaySharedSecret()) {
        return;
      }
      const { ensureChromeExtensionRelayServer } = await import("./relay/extension-relay.js");
      await ensureChromeExtensionRelayServer({
        cdpUrl: relayCdpUrl(port),
        bindHost: resolveRelayBindHost(),
      });
    },
    stop: async () => {
      const { stopChromeExtensionRelayServer } = await import("./relay/extension-relay.js");
      await stopChromeExtensionRelayServer({ cdpUrl: relayCdpUrl(port) }).catch(() => {});
    },
  };
}

/** Reload policy: restart this plugin when `browser-relay` config changes. */
export const browserRelayReload = { restartPrefixes: ["browser-relay"] };

/** Register the Browser Relay service with the host. */
export function registerBrowserRelayPlugin(api: OpenClawPluginApi): void {
  const port = resolveRelayPort();
  api.registerService(createBrowserRelayService());

  // Coarse-grained fast tool. The factory is sync (only the light tool module is
  // imported eagerly); the heavy relay module stays lazy — resolveServer dynamic
  // -imports it at call time, after the service has started and a tab is attached.
  api.registerTool(
    () =>
      createBrowserFastTool({
        resolveServer: async () => {
          const { getChromeExtensionRelayServer } = await import("./relay/extension-relay.js");
          return getChromeExtensionRelayServer(port);
        },
      }),
    { name: "browser_fast" },
  );
}
