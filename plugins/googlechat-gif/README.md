# Google Chat GIF (`googlechat-gif`)

Adds one agent tool, `send_gif`, that searches Giphy and posts an animated GIF
into an **allowlisted** Google Chat space. The GIF is sent as the Chat app's own
message via the `chat.bot` service account — the same credentials the `googlechat`
channel already uses.

## Config

`plugins.entries.googlechat-gif.config`:

- `giphyApiKey` — Giphy API key (or env `GIPHY_API_KEY`). A beta key is enough.
- `rating` — `g` | `pg` | `pg-13` | `r` (default `g`).
- `serviceAccountFile` — chat.bot service account JSON (or env
  `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` / inline `GOOGLE_CHAT_SERVICE_ACCOUNT`).
- `allowedSpaces` — explicit space allowlist; unset inherits the googlechat
  channel allowlist (deny-by-default).

## Tool

`send_gif(query, space?)` — search Giphy for `query` and post the chosen GIF to
`space` (defaults to the current Google Chat space). One call sends one GIF.
