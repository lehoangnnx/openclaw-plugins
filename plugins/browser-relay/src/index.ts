import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { browserRelayReload, registerBrowserRelayPlugin } from "./plugin-registration.js";

/**
 * Browser Relay plugin entry. Hosts the local CDP relay that a companion Chrome
 * MV3 extension dials into, so OpenClaw can drive the user's real, logged-in
 * browser through the existing `browser` tool (via a cdpUrl profile that points
 * at the relay's loopback `/cdp` face). No new agent tool is added.
 */
export default definePluginEntry({
  id: "browser-relay",
  name: "Browser Relay",
  description:
    "Drive your real, logged-in browser via a companion Chrome extension over a local CDP relay.",
  reload: browserRelayReload,
  register: registerBrowserRelayPlugin,
});
