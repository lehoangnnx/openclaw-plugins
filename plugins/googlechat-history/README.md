# @lehoangnnx/openclaw-googlechat-history

An [OpenClaw](https://github.com/openclaw/openclaw) **tool plugin** that lets the
agent read past messages from a Google Chat space via the Chat API
(`spaces.messages.list`). This fills the gap where an HTTP-endpoint Chat app only
receives messages it is **@mentioned** in — so the agent normally cannot see the
rest of a space's conversation.

It runs **alongside** the official `@openclaw/googlechat` channel plugin and does
not modify it.

## Install

```bash
openclaw plugins install clawhub:lehoangnnx/googlechat-history
openclaw gateway restart
```

Enable the plugin and its optional tool in `openclaw.json`:

```json5
{
  plugins: { allow: ["googlechat-history"] },
  tools: { allow: ["googlechat_history"] },
  // Optional: only if you don't already export GOOGLE_CHAT_SERVICE_ACCOUNT_FILE
  // plugins: { entries: { "googlechat-history": { config: { serviceAccountFile: "/data/credentials/googlechat-service-account.json" } } } }
}
```

## Credentials

The plugin mints an app-auth token from a Google **service account**, resolved in
this order:

1. plugin config `serviceAccountFile`
2. env `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` (path)
3. env `GOOGLE_CHAT_SERVICE_ACCOUNT` (inline JSON)

### Google-side requirements

- The service account / Chat app must be a **member of the space**.
- The app must be allowed to use the scope
  `https://www.googleapis.com/auth/chat.app.messages.readonly`
  (a Workspace admin may need to authorize it for the app).
- App authentication returns **public** space messages only (not private).

See the [Chat API list messages docs](https://developers.google.com/workspace/chat/list-messages).

## Tool: `googlechat_history`

| Param | Type | Notes |
| ----- | ---- | ----- |
| `space` | string (required) | `spaces/AAQAxxxx` or `AAQAxxxx` |
| `pageSize` | integer (1–100) | optional |
| `filter` | string | optional Chat API filter, e.g. `createTime > "2026-06-01T00:00:00Z"` |
| `pageToken` | string | optional, for pagination |

Returns a text list of `[time] sender: text`, plus a `nextPageToken` when more
pages exist.

## Develop

```bash
pnpm install
pnpm build
pnpm typecheck

# Local install against your gateway
openclaw plugins install ./   # from this directory
openclaw gateway restart
openclaw plugins inspect googlechat-history --runtime --json
```

> Pin `openclaw.compat` / `openclaw.build` in `package.json` to the OpenClaw
> release you run, and align the `typebox` version with your installed OpenClaw
> SDK if the build complains about the schema type.

## License

MIT © Nguyen Le Hoang
