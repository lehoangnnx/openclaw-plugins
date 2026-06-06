# @lehoangnnx/openclaw-googlechat-history

An [OpenClaw](https://github.com/openclaw/openclaw) **tool plugin** that lets the
agent read **allowlisted** Google Chat spaces — history, members, and metadata —
via the Chat API. It fills the gap where an HTTP-endpoint Chat app only receives
messages it is **@mentioned** in, so the agent normally cannot see the rest of a
space's conversation.

Runs **alongside** the official `@openclaw/googlechat` channel plugin; it does not
modify it.

## Tools

| Tool | Chat API | Auth |
| ---- | -------- | ---- |
| `googlechat_history` | `spaces.messages.list` | app **or** user (see auth modes) |
| `googlechat_members` | `spaces.members.list` | service account (`chat.bot`) |
| `googlechat_space_info` | `spaces.get` | service account (`chat.bot`) |

Plus an optional **auto-context** hook that injects recent history before replies.

**Every read is allowlist-gated (deny-by-default).** See Security.

## Security model — read this

- **Allowlist limits the AGENT, not the credential.** `allowedSpaces` (deny-by-
  default) means the agent/AI can only read spaces you explicitly list — but the
  underlying OAuth/service-account credential is **not** narrowed per-space
  (Google has no per-space scope). Treat tokens as secrets.
- **`authMode: "user"`** reads as *you* (`chat.messages.readonly`). It needs **no
  admin approval** (Internal OAuth app + self-consent), but the refresh token can
  see **every space you belong to** — so the allowlist + token hygiene are your
  protection. Use Fly secrets, restrict host access, rotate the token.
- **`authMode: "app"`** reads as the Chat app (`chat.app.messages.readonly`). The
  credential is naturally scoped to spaces the **bot is a member of**, but the
  scope **requires a one-time Workspace-admin approval**.
- `googlechat_members` / `googlechat_space_info` use `chat.bot` (the scope the
  channel already uses) — no extra approval — and only see spaces the bot is in.

## Install

```bash
openclaw plugins install clawhub:lehoangnnx/googlechat-history
openclaw gateway restart
```

```json5
{
  plugins: { allow: ["googlechat-history"] },
  tools: { allow: ["googlechat_history", "googlechat_members", "googlechat_space_info"] }
}
```

## Configure

### Auth mode `user` (no admin needed) — recommended when you are not an admin

1. Google Cloud Console → **OAuth consent screen → User type = Internal** → add
   scope `https://www.googleapis.com/auth/chat.messages.readonly`. Keep it
   **Internal** (not External/Testing) so the refresh token does not expire in 7 days.
2. **Credentials → Create OAuth client ID → Desktop app** → copy client id + secret.
3. Get a refresh token (one-time consent, runs locally):

   ```bash
   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
     node scripts/get-refresh-token.mjs
   ```

   Open the printed URL, sign in **as yourself** (a member of the spaces), approve.
4. Store the three values as secrets (env or config). Then:

   ```json5
   {
     plugins: { entries: { "googlechat-history": { config: {
       authMode: "user",
       allowedSpaces: ["spaces/AAQAxxxx"],   // ONLY these are readable
       // user: { clientId, clientSecret, refreshToken }  // or GOOGLE_CHAT_OAUTH_* env
     }}}}
   }
   ```

   Env fallback: `GOOGLE_CHAT_OAUTH_CLIENT_ID`, `GOOGLE_CHAT_OAUTH_CLIENT_SECRET`,
   `GOOGLE_CHAT_OAUTH_REFRESH_TOKEN`.

### Auth mode `app` (requires admin approval)

```json5
{
  plugins: { entries: { "googlechat-history": { config: {
    authMode: "app",                          // default
    serviceAccountFile: "/data/credentials/googlechat-service-account.json",
    allowedSpaces: ["spaces/AAQAxxxx"]
  }}}}
}
```

The service account / Chat app must be a **member of the space**, and a Workspace
admin must authorize `chat.app.messages.readonly` for the app
(<https://support.google.com/a?p=chat-app-auth>).

> `googlechat_members` / `googlechat_space_info` always use the service account, so
> set `serviceAccountFile` (or the env equivalents) if you want those tools — even
> in `user` mode.

## Config reference

| Key | Notes |
| --- | ----- |
| `authMode` | `"app"` (default) or `"user"`. |
| `allowedSpaces` | string[] of `spaces/<id>`. **Deny-by-default**: empty/unset → nothing readable. |
| `serviceAccountFile` | service-account JSON path (app reads + members/space-info). |
| `user.clientId` / `user.clientSecret` / `user.refreshToken` | user-auth creds (env fallback `GOOGLE_CHAT_OAUTH_*`). |
| `autoContext.enabled` | inject recent history before replies (default false). |
| `autoContext.messageCount` | messages to inject (default 15, max 50). |

## `googlechat_history` params

| Param | Type | Notes |
| ----- | ---- | ----- |
| `space` | string | optional; omit to use the current space. Must be allowlisted. |
| `pageSize` | integer 1–1000 | optional (Chat API default 25) |
| `filter` | string | optional, e.g. `createTime > "2026-06-01T00:00:00Z"` |
| `orderBy` | `"ASC"` \| `"DESC"` | optional; ASC = oldest first (default) |
| `pageToken` | string | optional, for pagination |

## Auto-context (optional)

Prepends the last N messages of the current **allowlisted** space before each
reply. Off by default; fail-safe (errors / non-allowlisted / unresolved space are
skipped silently). Non-bundled plugins must be granted the hook permissions:

```json5
{
  plugins: { entries: { "googlechat-history": {
    hooks: { allowPromptInjection: true, allowConversationAccess: true },
    config: { autoContext: { enabled: true, messageCount: 15 } }
  } } }
}
```

It resolves the space id from the turn's channel/session context; if that does not
expose a `spaces/<id>`, it no-ops — use the `googlechat_history` tool instead.
Verify live after enabling.

## Develop

```bash
pnpm install
pnpm build
pnpm typecheck
openclaw plugins install ./
openclaw gateway restart
```

> Pin `openclaw.compat` / `openclaw.build` in `package.json` to the OpenClaw
> release you run, and align the `typebox` version with your installed OpenClaw SDK.

## License

MIT © Nguyen Le Hoang
