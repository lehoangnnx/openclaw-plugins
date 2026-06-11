---
name: read-page-content
description: Extract clean readable text/markdown from a web page or a feed of posts (articles, blogs, social feeds like Facebook/X) using the browser tool — far cleaner than a raw snapshot.
metadata:
  openclaw:
    emoji: 📄
---

# Read page content

Turn a live web page into clean, readable text instead of a noisy accessibility
snapshot. Two modes:

- **Article mode** — one page's main content (news, blog, docs) → clean Markdown.
- **Feed mode** — a list of repeated posts/cards (Facebook page, X timeline,
  search results) → an array of per-post text, with infinite-scroll support.

Both work by running a small extraction script in the page via the `browser`
tool's `act → evaluate`. This is the right tool when a `snapshot` comes back as
unreadable DOM soup, or when you need the prose/text of posts rather than their
interactive structure.

## Prerequisites

- The target page must be open in the `browser` tool. To read your **real,
  logged-in** browser (past login walls, e.g. a Facebook page only you can see),
  drive it through the **relay** browser profile so the agent controls your
  actual Chrome via the companion extension.
- `browser.evaluateEnabled` must be true (it is the default). If it is disabled
  in config, `act:evaluate` returns a 403 and this skill cannot run.
- Extraction scripts live next to this file: `{baseDir}/article.js` and
  `{baseDir}/posts.js`. Read the one you need and pass its **entire contents**
  as the `fn` argument — they are self-contained `() => {…}` functions.

## Article mode

1. Open the page: `browser` `{ action: "open", url: "<url>", profile: "relay" }`.
2. Read `{baseDir}/article.js`.
3. Call the browser tool:
   `{ action: "act", request: { kind: "evaluate", fn: "<contents of article.js>" } }`
4. The result is `{ title, url, method, content }`. `content` is clean Markdown
   (≤50k chars). `method` tells you which extractor won (`walker` / `scoring` /
   `body-fallback`) — useful if output looks thin.
5. **When you have what you need, close the tab you opened** — see "Close the
   tab when done" below.

## Feed mode (multiple posts, e.g. "read 10 Facebook posts")

Feeds are virtualized: only the posts near the viewport exist in the DOM, so you
**scroll and re-extract**, accumulating unique posts until you have enough.

1. Open the page (relay profile), e.g. the Facebook page's URL.
2. Read `{baseDir}/posts.js`. Confirm/adjust the `SEL` constant at the top for
   the site (see table below). Facebook posts are `[role="article"]`.
3. Loop until you have N unique posts:
   - Evaluate `posts.js` → collect `items` (each `{ i, text, links }`).
   - Merge into your running list, **deduping by `text`** (the same post
     re-renders as you scroll).
   - If you still need more, scroll to load additional posts, then re-extract.
4. Return the first N unique posts' `text` to the user.
5. **Close the tab when done** — see "Close the tab when done" below.

**Scroll + wait in one call** (paste as `fn`; it scrolls, waits 1.5s for lazy
content, and reports the new page height so you can detect "end of feed"):

```js
() => new Promise((resolve) => {
  const before = document.body.scrollHeight
  window.scrollTo(0, before)
  setTimeout(() => resolve({ before, after: document.body.scrollHeight }), 1500)
})
```

If `after === before` across two scrolls, you have reached the end — stop.

## Site selector hints (Feed mode `SEL`)

| Site | `SEL` |
|------|-------|
| Facebook (page/feed posts) | `[role="article"]` |
| X / Twitter | `[data-testid="tweet"]` |
| Reddit | `shreddit-post, [data-testid="post-container"]` |
| Generic blog/news list | `article` |

If unsure, first run a probe to count candidates and pick a selector:
`{ action: "act", request: { kind: "evaluate", fn: "() => ['[role=\\"article\\"]','article','[data-testid=\\"tweet\\"]'].map(s=>({s,n:document.querySelectorAll(s).length}))" } }`

## Close the tab when done

This skill opens a tab in the user's **real** browser, so clean up after
yourself. Once you've extracted everything you need, close it:

`browser` `{ action: "close", targetId: "<the targetId returned by open>" }`

(or simply `{ action: "close" }` to close the current agent tab). Closing
releases the `chrome.debugger` banner and keeps the user's browser tidy.
Skip closing only if the user explicitly asked to leave the page open.
(The relay also auto-releases idle agent tabs as a backstop, but closing
promptly when finished is the right behavior.)

## Notes

- Output is clamped (article ≤50k chars; per post ≤2k, ≤20 posts/call) to avoid
  flooding context. For long feeds, summarize per batch as you scroll.
- These scripts only read the DOM — they never click, type, or submit.
- Login-walled or anti-bot pages work because the relay profile is your real
  authenticated session; a fresh headless browser would be blocked.
