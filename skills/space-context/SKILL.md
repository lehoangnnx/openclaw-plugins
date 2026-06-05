---
name: space-context
description: Pull Google Chat space history before answering questions about that space.
---

# Space Context

Use this skill when the user asks about what was said, decided, or shared in a
Google Chat **space** — especially history the bot did not receive directly
(messages where it was not @mentioned).

## When to use

- "What did we discuss in this space?"
- "Summarize the last N messages here."
- "Did anyone mention X earlier in this space?"

## How

1. Identify the current space id from the conversation context (`spaces/<id>`).
2. Call the `googlechat_history` tool with that `space`. For a time window, pass a
   `filter` such as `createTime > "2026-06-01T00:00:00Z"`.
3. Page with `pageToken` if the result returns one and you need more.
4. Summarize the retrieved messages; cite senders and timestamps when relevant.

## Requirements

- The `googlechat-history` plugin must be installed and the `googlechat_history`
  tool allowlisted (`tools.allow`).
- The bot must be a member of the space, and only **public** messages are
  returned via app authentication.

If the tool is unavailable or returns nothing, say so plainly instead of
guessing the space's history.
