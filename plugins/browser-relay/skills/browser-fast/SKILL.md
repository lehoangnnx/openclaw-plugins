---
name: browser-fast
description: Control or read the user's real, logged-in browser through the Browser Relay using the fast one-round-trip browser_fast tool — for navigating, observing, clicking, typing, scrolling, and extracting page text/posts/reviews. Prefer this over browser act:evaluate for any relay tab.
metadata:
  openclaw:
    emoji: ⚡
---

# Fast relay browser control (browser_fast)

When you need to drive or read the user's **real, logged-in** browser (the tab
attached via the OpenClaw Browser Relay extension), use the **`browser_fast`**
tool. Each action is a single relay round-trip, so it is far faster than the
`browser` tool's snapshot/`act:evaluate` loop — which fans out into dozens of
CDP round-trips over the remote link. **Do not use `browser` `act:evaluate` or
repeated `snapshot` on a relay tab; use `browser_fast`.**

## The loop

1. **Go to the page** — `browser_fast { action: "navigate", url }` (current tab)
   or `{ action: "open_tab", url }` (new tab).
2. **Observe** — `browser_fast { action: "observe" }` returns numbered
   interactive elements (`[1] button "Add to cart"`, …). Add
   `{ screenshot: true }` to also get a viewport image.
3. **Act by index** — `click`, `type` (with `text`), `scroll`, `hover`,
   `press_key` using the `index` from observe (or a `selector`).
4. **Read text** — `browser_fast { action: "read" }` returns the page as clean
   Markdown. Use this to extract article/post/review text in **one call**
   instead of writing extraction scripts.

## Reading a list (reviews, posts, search results)

Prefer **one** `read` for the visible content. If the list is virtualized /
infinite-scroll and you need more, alternate `scroll` (`direction: "down"`) and
`read`, accumulating until you have enough — but keep it to as few calls as
possible (each call is a round-trip). Do **not** fall back to per-item
`act:evaluate` scraping.

## Other actions

- `find` `{ keyword }` — locate text on the page and scroll the first hit into view.
- `screenshot` — viewport image. `viewport` — size/scroll info. `zoom` `{ zoomLevel }`.
- `list_tabs` / `activate_tab` / `close_tab` `{ targetId }` — manage relay tabs.

## When to fall back to `browser`

Only for what `browser_fast` cannot do: file downloads, PDF generation, raw
`evaluate` of custom JS, or complex multi-frame work. For ordinary
navigate/observe/click/type/read on a relay tab, always use `browser_fast`.

## Prerequisites

The tab must be attached via the Browser Relay extension (toolbar badge **ON**).
If `browser_fast` reports "extension not connected" or "no attached tab", tell
the user to open/attach the extension on the page they want controlled.
