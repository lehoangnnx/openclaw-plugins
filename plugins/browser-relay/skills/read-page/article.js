// Self-contained readability extractor for the OpenClaw browser tool.
// Pass this file's ENTIRE contents verbatim as the `fn` argument to
// act:evaluate. It runs in the page and returns:
//   { title, url, method: 'walker'|'scoring'|'body-fallback', content }
// where `content` is clean Markdown of the page's main article/body
// (link-density junk like nav/sidebars/ads stripped), clamped to ~50k chars.
() => {
  const MAX = 50000

  const clean = (s) =>
    String(s || '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

  // ---- Path 1: DOM walker → Markdown (good structure, keeps links/headings) ----
  const walk = (root) => {
    let out = ''
    const visit = (node, depth) => {
      if (!node || depth > 40) return
      if (node.nodeType === 3) {
        out += node.textContent.replace(/\s+/g, ' ')
        return
      }
      if (node.nodeType !== 1) return
      const el = node
      const tag = el.tagName ? el.tagName.toLowerCase() : ''
      const view = el.ownerDocument && el.ownerDocument.defaultView
      const style = view ? view.getComputedStyle(el) : null
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return
      if (['script', 'style', 'noscript', 'svg', 'template', 'nav', 'footer', 'aside', 'form'].includes(tag)) return
      if (/^h[1-6]$/.test(tag)) {
        out += '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + clean(el.textContent) + '\n\n'
        return
      }
      if (tag === 'p') {
        out += '\n\n' + clean(el.textContent) + '\n\n'
        return
      }
      if (tag === 'li') {
        out += '\n- ' + clean(el.textContent)
        return
      }
      if (tag === 'br') {
        out += '\n'
        return
      }
      if (tag === 'a') {
        const href = el.getAttribute('href') || ''
        const txt = clean(el.textContent)
        if (txt) out += href ? `[${txt}](${href})` : txt
        return
      }
      if (tag === 'img') {
        const alt = el.getAttribute('alt') || ''
        const src = el.getAttribute('src') || ''
        if (src) out += `![${alt}](${src})`
        return
      }
      if (tag === 'pre' || tag === 'code') {
        out += '\n```\n' + el.textContent + '\n```\n'
        return
      }
      // Recurse — pierce shadow roots so web-component content is captured too.
      const kids = el.shadowRoot
        ? [...el.shadowRoot.childNodes, ...el.childNodes]
        : el.childNodes
      for (const k of kids) visit(k, depth + 1)
    }
    visit(root, 0)
    return clean(out)
  }

  // ---- Path 2: Readability-style scoring (robust on blog/news/forum layouts) ----
  // Score on textContent (cheap, no layout); only the winner pays for innerText.
  const score = () => {
    let best = null
    let bestScore = 0
    let scanned = 0
    const cands = document.querySelectorAll('article, main, [role=main], section, div')
    for (const el of cands) {
      if (scanned > 4000) break
      const raw = el.textContent || ''
      if (raw.length < 200) continue
      scanned++
      const ps = el.querySelectorAll('p').length
      let linkLen = 0
      for (const a of el.querySelectorAll('a')) linkLen += (a.textContent || '').length
      let s = ps * 3 + Math.min(raw.length / 100, 30) + (raw.match(/[,，、]/g) || []).length
      if (raw.length > 0 && linkLen / raw.length > 0.5) s *= 0.3
      const id = ((el.className || '') + ' ' + (el.id || '')).toLowerCase()
      if (/article|content|main|post|body|story/.test(id)) s *= 1.4
      if (/sidebar|comment|footer|nav|menu|ad|banner|promo/.test(id)) s *= 0.3
      if (s > bestScore) {
        bestScore = s
        best = el
      }
    }
    return best && bestScore >= 10 ? clean(best.innerText) : ''
  }

  const root =
    document.querySelector('main, article, [role=main], #content, .content') || document.body
  const walker = walk(root)
  const scored = score()

  let content
  let method
  if (walker.length >= scored.length || walker.length > 800) {
    content = walker
    method = 'walker'
  } else {
    content = scored
    method = 'scoring'
  }
  if (content.length < 200) {
    content = clean(document.body ? document.body.innerText : '')
    method = 'body-fallback'
  }

  const ogTitle = document.querySelector('meta[property="og:title"]')
  const h1 = document.querySelector('h1')
  const title = (ogTitle && ogTitle.content) || (h1 && h1.innerText) || document.title || ''

  return { title: clean(title), url: location.href, method, content: content.slice(0, MAX) }
}
