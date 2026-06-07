# Google Chat Mention

An OpenClaw tool plugin that lets the agent post a Google Chat message which
**@mentions** specific people — or everyone — in a space.

## Why this exists

The bundled `googlechat` channel sends replies as plain text and runs them
through `sanitizeForPlainText`, which strips Chat's mention syntax
(`<users/123…>`). So the normal reply path **cannot tag anyone**.

This plugin bypasses that path: it calls `spaces.messages.create` directly with
the raw mention syntax, so Google Chat renders a real @mention. It is an
**additive** action — the agent's normal reply is unchanged; the agent calls
`googlechat_mention` only when a message needs to actually notify someone.

## Auth — reuses your existing service account

No new secret. It reads the **same** Google Chat service account the
`googlechat` channel and `googlechat-history` plugin already use, in this order:

1. `GOOGLE_CHAT_SERVICE_ACCOUNT` (inline JSON, env)
2. plugin config `serviceAccountFile`, else `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` (path, env)

Scope: `https://www.googleapis.com/auth/chat.bot` (no Workspace-admin approval
needed — same scope the channel already sends with). The Chat app must be a
**member** of the space, and you can only mention users who are members of it.

## Config

```jsonc
{
  "plugins": {
    "entries": {
      "googlechat-mention": {
        "config": {
          // Optional — only if you are not using the GOOGLE_CHAT_SERVICE_ACCOUNT* env.
          "serviceAccountFile": "/path/to/sa.json",
          // Optional — defaults to the googlechat channel's allowlist (one source of truth).
          "allowedSpaces": ["spaces/AAQAxxxx"]
        }
      }
    }
  }
}
```

Spaces are **deny-by-default**. If `allowedSpaces` is unset, the plugin inherits
the enabled `channels.googlechat.groups` spaces (while `groupPolicy: "allowlist"`).

## Tool: `googlechat_mention`

| Param | Required | Meaning |
| --- | --- | --- |
| `text` | yes | Message body. Mentions are prepended to it. |
| `mentions` | yes | Array. Each entry is a **display name** (resolved against space members), a **user id** (`users/123…` or the bare number), or `all` (everyone). |
| `space` | no | `spaces/AAQA…` or `AAQA…`. Omit to use the current space. Must be allowlisted. |
| `thread` | no | Thread resource name to reply within. Omit to start a new thread. |

Behavior:

- Display names resolve against the space's **human members** (case-insensitive).
  Unmatched or ambiguous names return an error that lists the known members, so
  the agent can retry with a precise name or id — it never silently tags the
  wrong person.
- `all` → `<users/all>` (named spaces only; not 1:1 DMs).
- Duplicate mentions are de-duplicated.

### Example

> "Tag Bình and let him know the deploy is done."

```json
{
  "text": "deploy lên Fly đã xong ✅",
  "mentions": ["Bình"]
}
```

→ posts `<users/123…> deploy lên Fly đã xong ✅`, rendering a real @Bình mention.

## Build

```bash
npm run build      # tsup → dist/
npm run typecheck
```

## Limits

- Service-account (app) auth cannot mention by **email** — use a display name or
  `users/<id>`. (Email mentions require user-auth.)
- The app only sees / can mention members of spaces it has joined.
