---
summary: "Load + configure the OpenClaw Browser Relay Chrome extension"
title: "Browser Relay — Extension setup"
---

# Browser Relay — Chrome extension setup

This is the **per-Chrome** (layer C) setup. The gateway must already have the
plugin installed and configured — see [DEPLOY.md](../DEPLOY.md) for the full
picture (plugin install + `OPENCLAW_BROWSER_RELAY_TOKEN` + `tools.alsoAllow +=
"browser_fast"` + optional remote reverse proxy).

## What this extension does

It attaches to your real Chrome tabs using `chrome.debugger` and pipes CDP to the
gateway's relay, so an OpenClaw agent can drive your **everyday, logged-in** browser
(cookies/SSO/MFA intact). The agent uses the `browser_fast` tool; for relay tabs it
can navigate, observe, click/type, read, and close the tabs it opened.

## Load (unpacked)

1. Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select this `extension/` directory (from the cloned
   `openclaw-plugins` repo, or `node_modules/@lehoangnnx/openclaw-browser-relay/extension`).
4. Pin the extension.

## Configure (Options)

Right-click the icon → **Options**, then set:

- **Relay URL** — leave blank for a local gateway (defaults to
  `http://127.0.0.1:18792`); for a remote gateway use its base, e.g.
  `https://gateway.example.com/browser-relay`.
- **Port** — `18792` (or your `OPENCLAW_BROWSER_RELAY_PORT`).
- **Token** — the gateway's `OPENCLAW_BROWSER_RELAY_TOKEN`.

Click **Save**. The Options page validates reachability + auth.

## Use

- **Badge `ON`** = connected and ready.
- For an autonomous task you don't need to do anything — `browser_fast` opens a tab
  itself. Click the icon on a tab only when you want the agent to act on a page you
  **already have open** (e.g. behind a login you completed in that exact tab).
- Tabs the agent opened are closed when it calls `done`; an idle reaper closes any
  leftovers after ~3 minutes. Tabs **you** attached are never closed.

## Badge states

| Badge | Meaning |
|-------|---------|
| `ON`  | Connected; agent can drive the tab(s). |
| `…`   | Connecting / reconnecting to the relay. |
| `!`   | Relay unreachable or token wrong — check the gateway is up and the Token/URL/Port in Options. |

## Updating the extension

Pull the repo, then Chrome → `chrome://extensions` → **Reload** on the extension.
A manifest-permission change may require **Remove** + **Load unpacked** again.

## Security (read this)

`chrome.debugger` shows a persistent "started debugging this browser" banner — this
is expected and cannot be hidden; it signals the extension is attached. When attached,
the agent can click/type/navigate and read whatever that tab's logged-in session can
access — this is **not** isolated. Prefer a dedicated Chrome profile, keep the
gateway/relay private (loopback locally, or token + private network/proxy remotely),
and only attach tabs you're comfortable handing to the agent.
