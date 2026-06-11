// Self-contained feed/post extractor for the OpenClaw browser tool.
// Pass this file's ENTIRE contents verbatim as the `fn` argument to
// act:evaluate. It collects the currently-rendered posts/cards on the page
// and returns: { count, selector, items: [{ i, text, links }] }.
//
// Tune the two constants below for the target site BEFORE passing it:
//   SEL — CSS selector for one post/card. Facebook (pages, groups, feeds) and
//         many feeds use '[role="article"]'. Twitter/X uses '[data-testid="tweet"]'.
//   MAX — how many posts to return per call.
// Feeds are virtualized/infinite-scroll: call this, then scroll and call again,
// deduping by the returned text, until you have enough posts (see SKILL.md).
() => {
  const SEL = '[role="article"]'
  const MAX = 20
  const PER = 2000

  // Standalone social-UI lines to drop so the post body reads cleanly: reaction
  // buttons, contributor badges, bare counts, and relative timestamps (5d, 22h).
  const NOISE =
    /^(like|reply|share|comment|comments|follow|edited|see more|see original|see translation|most relevant|newest|all comments|top fan|author|rising contributor|all-star contributor|top contributor|·|\d+|\d+\s*(comments?|shares?|reactions?|replies)|\d+[smhdwy]|just now|yesterday)$/i

  const clean = (raw) =>
    String(raw || '')
      .split('\n')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s && !NOISE.test(s))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

  const nodes = [...document.querySelectorAll(SEL)]
  const items = []
  const seen = new Set()
  for (const el of nodes) {
    const text = clean(el.innerText || '')
    if (text.length < 20) continue
    const key = text.slice(0, 120)
    if (seen.has(key)) continue // dedupe re-rendered / virtualized duplicates
    seen.add(key)
    const links = []
    for (const a of el.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || ''
      if (href && !href.startsWith('javascript:')) links.push(href)
    }
    items.push({ i: items.length + 1, text: text.slice(0, PER), links: links.slice(0, 8) })
    if (items.length >= MAX) break
  }
  return { count: items.length, selector: SEL, items }
}
