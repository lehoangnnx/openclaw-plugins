# Deploying Browser Relay to another OpenClaw gateway

This plugin lets an OpenClaw agent drive a user's **real, logged-in Chrome** through
a companion MV3 extension over a CDP relay. Deploying it has **three layers**:

```
A. Plugin on the gateway      B. Gateway config            C. Extension per Chrome
   (clone + build + install)     (token, alsoAllow,            (load unpacked +
                                  profile, [proxy])              Options: url/port/token)
```

Miss any one and it won't work. Layers A+B are per-gateway (once); layer C is per user/machine.

---

## Layer A — Install the plugin (git clone + build)

The gateway clones this repo at a pinned ref, builds it, and registers the plugin path.
This mirrors the reference Fly setup (`ops/Dockerfile` + `ops/openclaw-packages.txt`).

```bash
git clone https://github.com/lehoangnnx/openclaw-plugins.git
cd openclaw-plugins
git checkout <commit-or-tag>          # pin a ref for reproducible deploys
npm ci && npm run build               # builds all plugins (tsup -> dist/)

# Register the built plugin with the gateway:
openclaw plugins install "$(pwd)/plugins/browser-relay" --link --force
```

- `--link` keeps it pointing at the built dir (re-pull + rebuild to upgrade).
- In a containerized gateway, bake this at image-build time (clone at `OPENCLAW_PLUGINS_REF`,
  `npm ci && npm run build`, then run the `plugins install` on boot). See
  `ops/Dockerfile` + `ops/start-openclaw.sh` in the reference deployment.
- The plugin ships its own runtime dep (`ws`) and its `extension/` + `skills/` directories.

---

## Layer B — Configure the gateway

### 1. Shared token (required — the relay won't open a port without it)

```bash
export OPENCLAW_BROWSER_RELAY_TOKEN="<a-strong-secret>"
# optional: OPENCLAW_BROWSER_RELAY_PORT (default 18792)
#           OPENCLAW_BROWSER_RELAY_BIND_HOST (default loopback; set 0.0.0.0 only for remote)
```

`OPENCLAW_GATEWAY_TOKEN` / `CLAWDBOT_GATEWAY_TOKEN` are also accepted as the secret.

### 2. Expose the `browser_fast` tool to agents (easy to miss)

OpenClaw gates tools with an allowlist. The plugin's manifest already declares
`contracts.tools: ["browser_fast"]`, but each agent still needs the tool **allowed**.
Add it to `tools.alsoAllow` in `openclaw.json` — globally (covers agents with no
per-agent list) or per agent:

```jsonc
{
  "tools": {
    "alsoAllow": ["browser", "browser_fast", /* …existing… */]
  }
}
```

> Edit `openclaw.json` as the gateway's runtime user (don't let it become root-owned),
> write atomically, keep file mode private. Codex/agent tool lists are fixed at
> **session start** — open a NEW conversation after the change.

### 3. Browser profile for the `browser` fallback tool (optional but recommended)

`browser_fast` is self-contained, but the standard `browser` tool (used for
download/pdf/raw-evaluate) reaches the relay via a `cdpUrl` profile:

```bash
openclaw browser create-profile --name relay --cdp-url http://127.0.0.1:18792 --color "#00AA00"
```

### 4. Restart the gateway

So the relay service starts and the config reloads. Confirm boot logs list the
`browser-relay` plugin and show **no** `must declare contracts.tools` error.

### 5. Remote gateway only — reverse proxy the extension uplink

If the gateway runs elsewhere than the browser (e.g. cloud), the extension dials
in over `wss://`. Keep `/cdp` loopback; expose only `/extension` (WS) and
`/json/version`. Caddy example (see `ops/Caddyfile`):

```caddyfile
handle /browser-relay/extension* {
    uri strip_prefix /browser-relay
    reverse_proxy 127.0.0.1:18792
}
handle /browser-relay/json/version {
    uri strip_prefix /browser-relay
    reverse_proxy 127.0.0.1:18792
}
```

The relay trusts direct loopback for `/cdp` and requires the token for proxied
(`/extension`) requests. For a local gateway (same machine as Chrome), skip this —
the extension talks to `http://127.0.0.1:18792` directly.

---

## Layer C — Per user (each Chrome)

1. **Load the extension** (unpacked): Chrome → `chrome://extensions` → enable
   Developer mode → **Load unpacked** → select this package's `extension/`
   directory (from the cloned repo, or `node_modules/@lehoangnnx/openclaw-browser-relay/extension`).
   Pin it.
2. **Options** (right-click icon → Options): set
   - **Relay URL** — blank for a local gateway (`http://127.0.0.1:18792`), or your
     remote base e.g. `https://gateway.example.com/browser-relay`.
   - **Port** — `18792` (or your `OPENCLAW_BROWSER_RELAY_PORT`).
   - **Token** — the same `OPENCLAW_BROWSER_RELAY_TOKEN`.
3. Badge **ON** = connected. The agent can now `browser_fast` navigate/observe/act,
   and auto-opens a tab when none is attached. Click the icon to attach a tab you
   already have open (e.g. behind a login you completed there).

---

## Verify end-to-end

- Badge **ON**, stable.
- New conversation → agent uses `browser_fast` (`navigate` → `observe`/`read` →
  act → `done`). It should open a tab, act, and `done` closes the tabs it opened.
- Gateway logs: relay `/json/version` returns 200 with the token; no contract error.

## Security

`chrome.debugger` shows a persistent "started debugging this browser" banner — this
is expected and signals attachment. The relay accepts only token-bearing requests.
The agent can act on whatever the attached tab's session can access, so prefer a
dedicated Chrome profile and keep the relay/gateway private (loopback locally, or
token + private network / proxy remotely). `browser.evaluateEnabled=false` disables
raw page-JS evaluation if you don't need the `browser` fallback's `evaluate`.

## Upgrade

Push changes to the repo, re-pull at the new ref, `npm run build`, re-run
`openclaw plugins install … --link --force`, restart the gateway. Extension-only
changes additionally need each user to **Reload** the unpacked extension.
```
