# @lehoangnnx/openclaw-browser-relay

Let OpenClaw drive your **real, logged-in browser** (your everyday Chrome profile, with its cookies/SSO/MFA) via a companion **Chrome MV3 extension** over a local **CDP relay** — Accio-style.

OpenClaw shipped a built-in browser-relay path and then removed it in favor of `existing-session` via Chrome DevTools MCP. That replacement still needs Chrome started with `--remote-debugging-port`, which **Chrome 136+ blocks on the default profile** — so you cannot drive your everyday browser without relaunching it with a separate profile. This plugin restores the extension approach (`chrome.debugger`), which is **not** subject to that restriction, and repackages the battle-tested relay as a standalone plugin.

## How it works

```
Your Chrome (real profile) ──chrome.debugger/CDP──┐
  Extension service worker ──dials /extension (WS)─┤
                                                   ▼
              Relay server (this plugin, registerService)
                 /extension  ⇄  /cdp  (bridges CDP frames)
                                   ▲
   OpenClaw `browser` tool ──connectOverCDP──┘  (cdpUrl profile → http://127.0.0.1:18792)
```

The plugin adds a coarse-grained **`browser_fast`** agent tool (Accio-style): each
action — `navigate / open_tab / observe / read / click / type / scroll / press_key /
hover / find / screenshot / done / …` — is **one relay round-trip** (a single injected
script), so relay-driven browsing stays fast even over a remote link. A bundled
`browser-fast` skill steers the agent to use it. The standard `browser` tool still
works against the relay via a `cdpUrl` profile, as a fallback for download/pdf/raw
`evaluate`.

**Deploying to a gateway? See [DEPLOY.md](./DEPLOY.md)** for the full recipe
(install + gateway config incl. the `tools.alsoAllow` step + per-user extension).

## Status

- **Phase 0 — done:** recovered relay + extension, repackaged as a plugin (loopback).
- **Phase 1 — done:** remote transport (extension dials your gateway over `wss://`
  via a reverse proxy; `/cdp` stays loopback) + full `browser_fast` agent tool +
  `browser-fast` skill + autonomous tab open/close (`done`).
- Phase 2 (planned): multi-tenant (per-user pairing tokens in SQLite; relay rooms; isolation).
- Phase 3 (planned): SaaS hardening (per-tenant `evaluate` gate, rate limits, audit, security review).

The quick **Setup** below is for a single local gateway; for any real deployment
(local or remote, any gateway) follow **[DEPLOY.md](./DEPLOY.md)** — it covers the
mandatory `tools.alsoAllow += "browser_fast"` step and the remote reverse proxy.

## Setup (Phase 0, local)

1. Configure a shared token (the relay opens a port only when this is set):

   ```bash
   export OPENCLAW_BROWSER_RELAY_TOKEN="<a-strong-secret>"
   # optional: OPENCLAW_BROWSER_RELAY_PORT (default 18792), OPENCLAW_BROWSER_RELAY_BIND_HOST
   ```

2. Install/enable the plugin in OpenClaw, then restart the gateway so the relay service starts.

3. Load the extension (unpacked): Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select this package's `extension/` directory. Pin it. Open its **Options** and set the **Port** (default `18792`) and **Gateway token** (the same secret as above).

4. Create a `browser` profile that points at the relay:

   ```bash
   openclaw browser create-profile --name relay --cdp-url http://127.0.0.1:18792 --color "#00AA00"
   ```

5. Open the tab you want OpenClaw to control and click the extension icon (badge shows `ON`). Then:

   ```bash
   openclaw browser --browser-profile relay tabs
   openclaw browser --browser-profile relay snapshot --interactive
   ```

   Agents: call `browser` with `profile="relay"`.

## Security

- `chrome.debugger` shows a persistent "started debugging this browser" banner in normal Chrome — this is expected and cannot be hidden; it signals the extension is attached.
- The relay accepts only requests bearing the shared token. Keep the gateway/relay private (loopback in Phase 0).
- The `browser` tool's `evaluate` runs arbitrary page JS and is steerable by prompt injection; disable with `browser.evaluateEnabled=false` if not needed.

## Attribution

The relay server (`src/relay/extension-relay.ts`) and the MV3 extension (`extension/`) are recovered from the OpenClaw repository prior to commit `476d948732` (PR #47893, which removed the Chrome extension path), then adapted: the auth layer was rewritten to drop OpenClaw core config/secret coupling, and the loopback/ws helpers were vendored locally.
