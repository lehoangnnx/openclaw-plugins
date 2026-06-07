# Google Chat Mention

An OpenClaw tool plugin that lets the agent **@mention** people in its normal
Google Chat reply, by resolving display names into Chat mention tokens
(`<users/123…>`) the agent pastes into its reply text.

## Why this exists (and why resolve, not send)

Google Chat has two outbound paths in OpenClaw:

- The **message-tool / outbound-adapter** path runs text through
  `sanitizeForPlainText`, which strips `<users/123…>` — so a mention sent that
  way is lost.
- The **normal auto-reply** path (the agent's final reply) does **not** sanitize.
  So if the agent's reply text literally contains `<users/123…>`, Google Chat
  renders a real @mention.

This plugin therefore does **not** send anything. It exposes a tool that resolves
people into `<users/id>` tokens; the agent pastes those tokens into its own reply.
Result: **one message**, a real @mention, and the channel's typing indicator
edits into that single reply (no stray "is typing…" placeholder, no duplicate
message).

## Auth — reuses your existing service account

No new secret. It reads the **same** Google Chat service account the `googlechat`
channel and `googlechat-history` plugin already use, in this order:

1. `GOOGLE_CHAT_SERVICE_ACCOUNT` (inline JSON, env)
2. plugin config `serviceAccountFile`, else `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` (path, env)

Scope: `chat.bot`. The only Chat API call it makes is `spaces.members.list`
(to map a display name → user id); resolving an explicit id, `me`, or `all`
makes no API call at all. The Chat app must be a member of the space to list it.

## Tool: `googlechat_mention`

Input:

| Param | Required | Meaning |
| --- | --- | --- |
| `mentions` | yes | Array. Each entry is a **display name** (resolved against members), a **user id** (`users/123…` or the number), `me`/`requester` (the person being replied to), or `all`. |
| `space` | no | `spaces/AAQA…`. Omit to use the current space. Must be allowlisted. Only needed when resolving display names. |

Output: the resolved `<users/id>` token(s). The agent then writes them **verbatim**
into its reply, e.g.:

```text
<users/115804…> em check nhanh giá vàng hôm nay…
```

which Google Chat renders as `@Name em check nhanh…`.

Display names resolve against **human members** (case-insensitive). Unmatched or
ambiguous names return an error listing the known members, so the agent retries
with a precise name or id instead of tagging the wrong person. Spaces are
**deny-by-default**, inheriting the `googlechat` channel allowlist unless
`allowedSpaces` is set.

## Build

```bash
npm run build      # tsup → dist/
npm run typecheck
```

## Limits

- Service-account (app) auth cannot resolve by **email** — use a display name,
  `users/<id>`, or `me`.
- The app only sees members of spaces it has joined.
- The agent must paste the token into its reply; the tool itself never sends a
  message.
