# Design: `googlechat-gif` plugin — let Oppy send GIFs in Google Chat

Date: 2026-06-12
Status: Approved design, pending implementation plan

## Goal

Let the agent **Oppy** (`work-orchestrator`) proactively attach an animated GIF in
its Google Chat spaces/DMs, restrained the way it already uses emoji. Today the
bundled Google Chat channel can send any media file, but there is no way for the
agent to *find* a GIF. This plugin adds that missing piece as a single tool.

Out of scope: reactions (separate upstream bug, tracked elsewhere) and stickers
(no Google Chat API support).

## Provider decision

- **Giphy** (`api.giphy.com/v1/gifs/search`). Chosen over Tenor because **Google is
  shutting Tenor down on 2026-06-30** (deprecated 2026-01-13, no new clients since
  2026-01) — a dead end for a new build. Verified against
  https://developers.google.com/tenor/guides/quickstart and shutdown reporting.
- Giphy **beta API key** is sufficient for a personal bot (rate-limited, max
  `limit=50`). Production approval only needed for high volume.
- `rating` content filter (`g` | `pg` | `pg-13` | `r`) defaults to `g` (safe for a
  work space).

## Architecture

New plugin `plugins/googlechat-gif` in the `openclaw-plugins` monorepo, modeled
directly on `plugins/googlechat-mention`. One registered tool: **`send_gif`**.

`send_gif` is a **one-shot** tool: it searches Giphy, downloads the GIF bytes, and
uploads + posts the GIF to the current Google Chat space itself, using the
`chat.bot` service account (the same credentials the `googlechat` channel,
`googlechat-history`, and `googlechat-mention` already use — no new Google secret).
The GIF arrives as its **own message from the "Oppy" Chat app**, separate from
Oppy's normal text reply. No caption.

### Components (files)

1. `src/giphy-api.ts` — Giphy search client.
   - `searchGif(query, { apiKey, rating, limit })` → `{ url, title }` or a typed
     "no results" outcome.
   - `GET https://api.giphy.com/v1/gifs/search?api_key=&q=&limit=&rating=`.
   - Rendition preference, first that exists and is under the size cap:
     `images.downsized_medium` → `images.fixed_height` → `images.original`
     (uses each rendition's `size` field when present to pre-filter).
   - Picks at random among the top N results (default N=8) so repeated calls vary.

2. `src/chat-send.ts` — Google Chat attachment send via `chat.bot`.
   - Reuses the auth pattern from `googlechat-mention/src/chat-api.ts`:
     `GoogleAuth({ scopes: [chat.bot] })`, cached per credential, service account
     resolved from plugin `serviceAccountFile` → env `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`
     → inline `GOOGLE_CHAT_SERVICE_ACCOUNT`.
   - `uploadAttachment(space, filename, bytes, contentType)`:
     `POST https://chat.googleapis.com/upload/v1/{space}/attachments:upload?uploadType=multipart`
     → returns `attachmentUploadToken`.
   - `sendGifMessage(space, attachmentUploadToken, contentName)`:
     `POST https://chat.googleapis.com/v1/{space}/messages` with `attachment`.
   - Reuses `formatChatApiError` style (403 → "Chat app is not a member of the space").

3. `src/index.ts` — `definePluginEntry`, registers `send_gif`.
   - Params (typebox): `query: string` (required), `space?: string` (optional;
     defaults to the ambient current space from delivery context, same resolution
     as `googlechat-mention`).
   - Flow: resolve space → **deny-by-default allowlist** (explicit
     `config.allowedSpaces` wins; otherwise inherit the enabled
     `channels.googlechat.groups` while `groupPolicy: "allowlist"` — one source of
     truth, copied from mention) → `searchGif` → download bytes (cap from
     `channels.googlechat.mediaMaxMb` ?? 20 MB) → `uploadAttachment` →
     `sendGifMessage` → return a short confirmation to the model.

4. `openclaw.plugin.json` — manifest.
   - `contracts.tools: ["send_gif"]`, `toolMetadata.send_gif.optional: true`,
     `activation.onStartup: true`.
   - `configSchema`: `giphyApiKey?` (falls back to env `GIPHY_API_KEY`),
     `rating?` (default `"g"`), `serviceAccountFile?`, `allowedSpaces?`.

5. `package.json`, `tsconfig.json`, `README.md` — mirror `googlechat-mention`
   (deps `google-auth-library`, `typebox`; tsup esm build; `openclaw` peer).

## Data flow

```
Oppy decides a GIF fits
  → send_gif(query="ăn mừng deadline")        [optional space]
    → resolve space + allowlist check          (deny-by-default, inherited)
    → Giphy search (rating=g, limit=8, pick random of top N)
    → download chosen rendition bytes          (≤ mediaMaxMb)
    → upload attachment to space               (chat.bot service account)
    → create message with attachment           (posts as "Oppy" app)
    → return "sent" to the model
```

## Error handling

Every failure returns an **actionable text result** so Oppy can gracefully fall
back to plain emoji/text instead of erroring the turn:

- Missing `giphyApiKey` → explain config/env `GIPHY_API_KEY`.
- No search results → "no GIF found for <query>" → model falls back.
- Missing/denied space → explicit refusal (mirrors mention plugin wording).
- Giphy `429` (rate limit) → surface, skip.
- All renditions over the size cap → skip with a note.

## Behavior change (Oppy `SOUL.md`)

Add a short rule near the existing emoji guidance: Oppy **may proactively** attach a
GIF via `send_gif` when it fits the moment (celebration, congrats, light teasing,
emotional reaction), **restrained** like the current "emoji mức vừa" rule — not on
every message, safe rating by default, and skip silently if no good GIF matches.
Applied to the live agent the same way other agent instruction edits are (directly
on the Fly gateway; not committed to the runtime-managed git).

## Deployment (Fly)

1. Build + push `googlechat-gif` to the `openclaw-plugins` repo.
2. Add `plugin plugins/googlechat-gif` to `ops/openclaw-packages.txt`.
3. Set `GIPHY_API_KEY` as a Fly secret (via `ops/.env`).
4. Bump `OPENCLAW_PLUGINS_REF` in `ops/fly.toml` to the new commit → `fly deploy`.
5. Apply the `SOUL.md` change to the live `work-orchestrator` agent.

## Testing

Unit tests with mocked `fetch` (vitest, table-driven, repo style):

- `giphy-api`: rendition preference order, size-cap filtering, `rating` passthrough,
  random-of-top-N selection (seeded/index-based to stay deterministic), no-results
  outcome.
- `chat-send`: multipart upload request shape, message create payload, `403`/`429`
  error formatting.

No live Giphy/Google calls in unit tests; a manual real-send check happens during
Fly verification.

## Open questions

None. (Provider, one-shot send, separate message, no caption, proactive-but-
restrained behavior all confirmed with the user 2026-06-12.)
