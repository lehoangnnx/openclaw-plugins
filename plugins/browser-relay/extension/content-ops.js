/**
 * Coarse-grained `Extension.*` commands — the "fast path".
 *
 * Each function runs as ONE injected script in the page via
 * chrome.scripting.executeScript and returns structured data, so a whole
 * observation/action collapses into a single relay round-trip instead of the
 * dozens of fine-grained CDP calls Playwright issues. This is what keeps a
 * remote (laptop -> gateway) browser task fast: round-trip count dominates over
 * a high-latency link, and these commands cut it ~10x.
 *
 * DOM-only ops (markElements/extractContent/click/input) need NO debugger
 * attach. captureViewport uses CDP Page.captureScreenshot, so it requires the
 * tab to be attached first (background ensures that).
 *
 * Ported/trimmed from the Accio Browser Relay extension's content_script ops.
 */

/** chrome.scripting.executeScript returns [{ result }]; pull the single frame's value. */
function unwrapScriptResult(results, label) {
  const first = Array.isArray(results) ? results[0] : undefined;
  if (!first) {
    throw new Error(`${label}: no injection result`);
  }
  return first.result;
}

// ── Content extraction (DOM -> Markdown) ──

export async function extExtractContent(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title =
        document.title ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.querySelector("h1")?.textContent?.trim() ||
        "";

      const main = document.querySelector('main, article, [role="main"], #content, .content');
      const root = main || document.body;

      function toMarkdown(el) {
        const lines = [];
        const walk = (node) => {
          if (node.nodeType === 3) {
            const t = node.textContent.replace(/\s+/g, " ").trim();
            if (t) lines.push(t);
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName;
          try {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") return;
          } catch {
            /* ignore */
          }
          if (/^H[1-6]$/.test(tag)) {
            lines.push("\n" + "#".repeat(+tag[1]) + " " + node.textContent.trim());
          } else if (tag === "P") {
            lines.push("\n" + node.innerText.replace(/\s+/g, " ").trim());
          } else if (tag === "LI") {
            lines.push("- " + node.innerText.replace(/\s+/g, " ").trim());
          } else if (tag === "A" && node.href) {
            lines.push(`[${node.textContent.trim()}](${node.href})`);
          } else if (tag === "IMG" && node.alt) {
            lines.push(`![${node.alt}](${node.src})`);
          } else if (tag === "PRE" || tag === "CODE") {
            lines.push("\n```\n" + node.textContent.trim() + "\n```");
          } else if (tag === "BR") {
            lines.push("\n");
          } else if (tag === "TABLE") {
            lines.push("\n" + node.innerText.replace(/\t/g, " | ").trim());
          } else {
            for (const child of node.childNodes) walk(child);
            if (node.shadowRoot) {
              for (const child of node.shadowRoot.childNodes) walk(child);
            }
          }
        };
        walk(el);
        return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      }

      return {
        title: title.trim(),
        url: location.href,
        content: toMarkdown(root).slice(0, 50000),
      };
    },
  });
  return unwrapScriptResult(results, "Extension.extractContent");
}

// ── Interactive element marking (set-of-marks) ──

export async function extMarkElements(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (options) => {
      const INTERACTIVE_SELECTOR = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[contenteditable="true"]',
        "[onclick]",
        '[tabindex]:not([tabindex="-1"])',
      ].join(",");

      const SKIP_TAGS = new Set([
        "HTML",
        "HEAD",
        "BODY",
        "SCRIPT",
        "STYLE",
        "NOSCRIPT",
        "SVG",
        "PATH",
        "META",
        "LINK",
      ]);

      function deepElementFromPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (el?.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(x, y);
          if (inner && inner !== el) return inner;
        }
        return el;
      }

      function isDescendantOrSelf(node, target) {
        let cur = node;
        while (cur) {
          if (cur === target) return true;
          if (cur.parentElement) {
            cur = cur.parentElement;
            continue;
          }
          const root = cur.getRootNode();
          cur = root instanceof ShadowRoot ? root.host : null;
        }
        return false;
      }

      // Sample points across the element's clipped rect; visible only when a
      // meaningful share actually hit-test back to it (catches overlapped/covered
      // elements that are technically in the DOM but not clickable).
      function isVisible(el, rect, vw, vh) {
        if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) return false;
        const clipped = {
          left: Math.max(rect.left, 0),
          top: Math.max(rect.top, 0),
          right: Math.min(rect.right, vw),
          bottom: Math.min(rect.bottom, vh),
        };
        const cw = clipped.right - clipped.left;
        const ch = clipped.bottom - clipped.top;
        if (cw < 3 || ch < 3) return false;

        const cols = Math.min(4, Math.max(1, Math.round(cw / 20)));
        const rows = Math.min(4, Math.max(1, Math.round(ch / 20)));
        let hits = 0;
        let total = 0;
        for (let r = 0; r <= rows; r++) {
          for (let c = 0; c <= cols; c++) {
            const px = clipped.left + (cols > 0 ? (c / cols) * cw : cw / 2);
            const py = clipped.top + (rows > 0 ? (r / rows) * ch : ch / 2);
            const top = deepElementFromPoint(px, py);
            if (top && isDescendantOrSelf(top, el)) hits++;
            total++;
          }
        }
        return total > 0 && hits / total >= 0.3;
      }

      function collectInteractive(root, out) {
        for (const el of root.querySelectorAll("*")) {
          if (SKIP_TAGS.has(el.tagName)) continue;
          if (el.matches(INTERACTIVE_SELECTOR)) out.push(el);
          if (el.shadowRoot) collectInteractive(el.shadowRoot, out);
        }
      }

      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const candidates = [];
      collectInteractive(document, candidates);

      const elements = [];
      let idx = 1;
      const maxElements = options?.maxElements || 200;

      for (const el of candidates) {
        if (idx > maxElements) break;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        try {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
            continue;
        } catch {
          /* ignore */
        }
        if (!isVisible(el, rect, vw, vh)) continue;

        const tag = el.tagName.toLowerCase();
        const text = (
          el.textContent ||
          el.value ||
          el.placeholder ||
          el.getAttribute("aria-label") ||
          el.title ||
          ""
        )
          .trim()
          .slice(0, 100);

        el.setAttribute("data-ocr-idx", String(idx));

        elements.push({
          idx,
          tag,
          type: el.type || "",
          text,
          role: el.getAttribute("role") || "",
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          center: {
            nx: +(((rect.left + rect.width / 2) / vw).toFixed(4)),
            ny: +(((rect.top + rect.height / 2) / vh).toFixed(4)),
          },
        });
        idx++;
      }

      return {
        elements,
        viewport: { width: vw, height: vh, dpr: window.devicePixelRatio || 1 },
        url: location.href,
        title: document.title,
      };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.markElements");
}

// ── DOM actions: click / input ──

export async function extClick(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => {
      function deepQuery(root, sel) {
        const found = root.querySelector(sel);
        if (found) return found;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const inner = deepQuery(el.shadowRoot, sel);
            if (inner) return inner;
          }
        }
        return null;
      }
      let el;
      if (p.index != null) {
        const idx = Number(p.index);
        if (!Number.isInteger(idx) || idx <= 0) return { success: false, error: "Invalid index" };
        el = deepQuery(document, `[data-ocr-idx="${idx}"]`);
      } else if (p.selector) {
        try {
          el = deepQuery(document, p.selector);
        } catch {
          return { success: false, error: "Invalid selector" };
        }
      } else if (p.x != null && p.y != null) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cx = p.viewportWidth ? (p.x / p.viewportWidth) * vw : p.x;
        const cy = p.viewportHeight ? (p.y / p.viewportHeight) * vh : p.y;
        el = document.elementFromPoint(cx, cy);
        if (el?.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(cx, cy);
          if (inner) el = inner;
        }
      }
      if (!el) return { success: false, error: "Element not found" };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const clickType = (p.clickType || "single_left").toLowerCase();
      const isRight = clickType.includes("right");
      const button = isRight ? 2 : 0;
      const baseOpts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: cx,
        clientY: cy,
        button,
      };

      if (clickType === "double_left") {
        for (let i = 1; i <= 2; i++) {
          el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, detail: i }));
          el.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, detail: i }));
          el.dispatchEvent(new MouseEvent("click", { ...baseOpts, detail: i }));
        }
        el.dispatchEvent(new MouseEvent("dblclick", { ...baseOpts, detail: 2 }));
      } else if (isRight) {
        el.dispatchEvent(new MouseEvent("mousedown", baseOpts));
        el.dispatchEvent(new MouseEvent("mouseup", baseOpts));
        el.dispatchEvent(new MouseEvent("contextmenu", baseOpts));
      } else {
        el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, detail: 1 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, detail: 1 }));
        el.dispatchEvent(new MouseEvent("click", { ...baseOpts, detail: 1 }));
      }

      return {
        success: true,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 80),
        clickType,
      };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.click");
}

export async function extInput(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => {
      function deepQuery(root, sel) {
        const found = root.querySelector(sel);
        if (found) return found;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const inner = deepQuery(el.shadowRoot, sel);
            if (inner) return inner;
          }
        }
        return null;
      }
      let el;
      if (p.index != null) {
        const idx = Number(p.index);
        if (!Number.isInteger(idx) || idx <= 0) return { success: false, error: "Invalid index" };
        el = deepQuery(document, `[data-ocr-idx="${idx}"]`);
      } else if (p.selector) {
        try {
          el = deepQuery(document, p.selector);
        } catch {
          return { success: false, error: "Invalid selector" };
        }
      }
      if (!el) return { success: false, error: "Element not found" };

      el.focus();
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        // Use the native value setter so React/Vue controlled inputs see the
        // change (assigning .value directly is swallowed by their descriptors).
        const proto =
          tag === "SELECT"
            ? HTMLSelectElement.prototype
            : tag === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
        const nativeSet = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (nativeSet) nativeSet.call(el, p.text || "");
        else el.value = p.text || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.getAttribute("contenteditable") === "true") {
        el.focus();
        document.execCommand("selectAll");
        document.execCommand("insertText", false, p.text || "");
      } else {
        return { success: false, error: "Element is not editable" };
      }
      return { success: true };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.input");
}

// ── Screenshot (needs debugger attach; background guarantees it) ──

export async function extCaptureViewport(tabId, params) {
  const debuggee = { tabId };
  const format = params?.format || "png";
  const quality = params?.quality || 80;

  // Let one frame settle so the screenshot matches the latest layout.
  await chrome.debugger
    .sendCommand(debuggee, "Runtime.evaluate", {
      expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      awaitPromise: true,
    })
    .catch(() => {});

  const metrics = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
  const vv = metrics?.visualViewport || {};

  const vpResult = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: "JSON.stringify({ dpr: window.devicePixelRatio || 1 })",
    returnByValue: true,
  });
  const { dpr } = JSON.parse(vpResult?.result?.value || '{"dpr":1}');

  const screenshot = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
    format,
    quality: format === "jpeg" ? quality : undefined,
    clip: {
      x: vv.pageX || 0,
      y: vv.pageY || 0,
      width: vv.clientWidth || 1280,
      height: vv.clientHeight || 720,
      scale: 1 / dpr,
    },
    captureBeyondViewport: false,
  });

  return {
    data: screenshot?.data,
    format,
    width: Math.round(vv.clientWidth || 1280),
    height: Math.round(vv.clientHeight || 720),
    dpr,
  };
}

// ── Scroll ──

export async function extScroll(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => {
      function deepQuery(root, sel) {
        const f = root.querySelector(sel);
        if (f) return f;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const i = deepQuery(el.shadowRoot, sel);
            if (i) return i;
          }
        }
        return null;
      }
      let el = null;
      if (p.selector) {
        try {
          el = deepQuery(document, p.selector);
        } catch {
          /* ignore */
        }
      } else if (p.index != null) {
        el = deepQuery(document, `[data-ocr-idx="${Number(p.index)}"]`);
      }
      const scroller = el || document.scrollingElement || document.documentElement;
      const dir = String(p.direction || "down").toLowerCase();
      const step =
        typeof p.amount === "number"
          ? p.amount
          : Math.round((el ? el.clientHeight : window.innerHeight) * 0.8);
      const before = { x: scroller.scrollLeft, y: scroller.scrollTop };
      if (dir === "top") scroller.scrollTo({ top: 0 });
      else if (dir === "bottom") scroller.scrollTo({ top: scroller.scrollHeight });
      else {
        const dx = dir === "left" ? -step : dir === "right" ? step : 0;
        const dy = dir === "up" ? -step : dir === "down" ? step : 0;
        scroller.scrollBy(dx, dy);
      }
      const after = { x: scroller.scrollLeft, y: scroller.scrollTop };
      const maxY = scroller.scrollHeight - scroller.clientHeight;
      return {
        success: true,
        direction: dir,
        before,
        after,
        moved: after.x !== before.x || after.y !== before.y,
        atBottom: after.y >= maxY - 2,
      };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.scroll");
}

// ── Keyboard (synthetic, matching Accio's event model) ──

export async function extPressKey(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => {
      const key = String(p.key || "");
      if (!key) return { success: false, error: "key required" };
      const mods = (Array.isArray(p.modifiers) ? p.modifiers : []).map((m) => String(m).toLowerCase());
      const init = {
        key,
        code: p.code || key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: mods.includes("ctrl") || mods.includes("control"),
        shiftKey: mods.includes("shift"),
        altKey: mods.includes("alt"),
        metaKey: mods.includes("meta") || mods.includes("cmd"),
      };
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { success: true, key, modifiers: mods };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.pressKey");
}

// ── Hover ──

export async function extMoveMouse(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => {
      function deepQuery(root, sel) {
        const f = root.querySelector(sel);
        if (f) return f;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const i = deepQuery(el.shadowRoot, sel);
            if (i) return i;
          }
        }
        return null;
      }
      let el = null;
      if (p.index != null) el = deepQuery(document, `[data-ocr-idx="${Number(p.index)}"]`);
      else if (p.selector) {
        try {
          el = deepQuery(document, p.selector);
        } catch {
          /* ignore */
        }
      }
      if (!el) return { success: false, error: "Element not found" };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const o = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      el.dispatchEvent(new PointerEvent("pointerover", o));
      el.dispatchEvent(new MouseEvent("mouseover", o));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...o, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mousemove", o));
      return { success: true, tag: el.tagName.toLowerCase() };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.moveMouse");
}

// ── In-page keyword search ──

export async function extFindKeyword(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => {
      const kw = String(p.keyword || "").trim();
      if (!kw) return { success: false, error: "keyword required" };
      const limit = Number(p.limit) || 20;
      const low = kw.toLowerCase();
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent || "";
        const idx = t.toLowerCase().indexOf(low);
        if (idx < 0) continue;
        const ctx = t.slice(Math.max(0, idx - 40), idx + kw.length + 40).replace(/\s+/g, " ").trim();
        let scrolled = false;
        if (out.length === 0 && node.parentElement) {
          node.parentElement.scrollIntoView({ block: "center", behavior: "instant" });
          scrolled = true;
        }
        out.push({ context: ctx, tag: node.parentElement?.tagName.toLowerCase() || "", scrolled });
        if (out.length >= limit) break;
      }
      return { success: true, keyword: kw, count: out.length, matches: out };
    },
    args: [params || {}],
  });
  return unwrapScriptResult(results, "Extension.findKeyword");
}

// ── Viewport info ──

export async function extGetViewportInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      url: location.href,
      title: document.title,
    }),
  });
  return unwrapScriptResult(results, "Extension.getViewportInfo");
}

// ── Zoom ──

export async function extEnsureZoom(tabId, params) {
  const target = typeof params?.zoom === "number" ? params.zoom : 1;
  const cur = await chrome.tabs.getZoom(tabId);
  if (Math.abs(cur - target) > 0.01) {
    await chrome.tabs.setZoom(tabId, target);
    return { changed: true, from: cur, to: target };
  }
  return { changed: false, current: cur };
}

// ── Navigate the current tab (chrome.tabs API; no CDP needed) ──

export async function extNavigate(tabId, params) {
  const url = String(params?.url || "").trim();
  if (!url) throw new Error("url required");
  await chrome.tabs.update(tabId, { url });
  // Best-effort wait for load so the next observe/read sees the new page (~8s cap).
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.status === "complete") return { success: true, url: t.url || url, title: t.title || "" };
  }
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return { success: true, url: t?.url || url, title: t?.title || "", note: "load wait timed out" };
}

/** Methods this module owns; background routes these instead of raw CDP. */
export const EXTENSION_OP_METHODS = new Set([
  "Extension.markElements",
  "Extension.extractContent",
  "Extension.click",
  "Extension.input",
  "Extension.captureViewport",
  "Extension.scroll",
  "Extension.pressKey",
  "Extension.moveMouse",
  "Extension.findKeyword",
  "Extension.getViewportInfo",
  "Extension.ensureZoom",
  "Extension.navigate",
]);

/** Dispatch one `Extension.*` command for an already-resolved tab. */
export async function handleExtensionOp(method, tabId, params) {
  switch (method) {
    case "Extension.markElements":
      return await extMarkElements(tabId, params);
    case "Extension.extractContent":
      return await extExtractContent(tabId);
    case "Extension.click":
      return await extClick(tabId, params);
    case "Extension.input":
      return await extInput(tabId, params);
    case "Extension.captureViewport":
      return await extCaptureViewport(tabId, params);
    case "Extension.scroll":
      return await extScroll(tabId, params);
    case "Extension.pressKey":
      return await extPressKey(tabId, params);
    case "Extension.moveMouse":
      return await extMoveMouse(tabId, params);
    case "Extension.findKeyword":
      return await extFindKeyword(tabId, params);
    case "Extension.getViewportInfo":
      return await extGetViewportInfo(tabId);
    case "Extension.ensureZoom":
      return await extEnsureZoom(tabId, params);
    case "Extension.navigate":
      return await extNavigate(tabId, params);
    default:
      throw new Error(`Unknown Extension command: ${method}`);
  }
}

/** captureViewport is the only op that needs a live CDP debugger attach. */
export function extensionOpNeedsAttach(method) {
  return method === "Extension.captureViewport";
}
