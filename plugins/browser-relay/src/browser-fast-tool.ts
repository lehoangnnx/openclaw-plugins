import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { ChromeExtensionRelayServer, ExtensionRelayTarget } from "./relay/extension-relay.js";

/**
 * Coarse-grained "fast" browser tool — full Accio-style agentic surface.
 *
 * Every action is ONE relay round-trip to the extension (a single injected
 * script, or one CDP screenshot), so a whole observe/act step is one hop instead
 * of the dozens of fine-grained CDP calls Playwright issues over `/cdp`. On a
 * remote link (laptop -> gateway) round-trip count dominates latency, so this is
 * the lever that makes relay-driven browsing fast.
 *
 * Loop: navigate -> observe (numbered interactive elements, optional screenshot)
 * -> click/type/scroll/hover/press_key by index -> read for page text. Tabs via
 * open_tab/activate_tab/close_tab/list_tabs. Use the standard `browser` tool only
 * for things this can't do (download, pdf, raw evaluate, complex multi-frame).
 */

const FAST_ACTIONS = [
  "navigate",
  "open_tab",
  "observe",
  "read",
  "click",
  "type",
  "scroll",
  "press_key",
  "hover",
  "find",
  "screenshot",
  "viewport",
  "zoom",
  "list_tabs",
  "activate_tab",
  "close_tab",
] as const;

const CLICK_TYPES = ["single_left", "double_left", "right"] as const;
const SCROLL_DIRECTIONS = ["down", "up", "left", "right", "top", "bottom"] as const;

const BrowserFastSchema = Type.Object({
  action: stringEnum([...FAST_ACTIONS], {
    description:
      "navigate (go to url) | open_tab (new tab at url) | observe (numbered interactive elements, optional screenshot) | read (page text as Markdown) | click | type | scroll | press_key | hover | find (in-page keyword) | screenshot | viewport (size/scroll) | zoom | list_tabs | activate_tab | close_tab.",
  }),
  url: Type.Optional(Type.String({ description: "Target URL for navigate/open_tab." })),
  index: Type.Optional(
    Type.Integer({ minimum: 1, description: "1-based element index from a prior observe." }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector instead of index." })),
  text: Type.Optional(Type.String({ description: "Text to enter (type)." })),
  clickType: Type.Optional(stringEnum([...CLICK_TYPES], { description: "Click variant for click." })),
  direction: Type.Optional(
    stringEnum([...SCROLL_DIRECTIONS], { description: "Scroll direction (scroll)." }),
  ),
  amount: Type.Optional(Type.Integer({ description: "Scroll distance in px (scroll)." })),
  key: Type.Optional(Type.String({ description: 'Key name for press_key, e.g. "Enter", "Tab".' })),
  modifiers: Type.Optional(
    Type.Array(Type.String(), { description: 'Modifiers for press_key: ctrl|shift|alt|meta.' }),
  ),
  keyword: Type.Optional(Type.String({ description: "Keyword to search in page (find)." })),
  zoomLevel: Type.Optional(Type.Number({ description: "Zoom factor, e.g. 1 = 100% (zoom)." })),
  screenshot: Type.Optional(
    Type.Boolean({ description: "observe: also return a viewport screenshot image." }),
  ),
  maxElements: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "observe: cap on elements (default 200)." }),
  ),
  targetId: Type.Optional(
    Type.String({
      description: "CDP targetId to act on. Defaults to the relay's attached tab. Required for activate_tab/close_tab.",
    }),
  ),
});

type BrowserFastParams = {
  action: (typeof FAST_ACTIONS)[number];
  url?: string;
  index?: number;
  selector?: string;
  text?: string;
  clickType?: (typeof CLICK_TYPES)[number];
  direction?: (typeof SCROLL_DIRECTIONS)[number];
  amount?: number;
  key?: string;
  modifiers?: string[];
  keyword?: string;
  zoomLevel?: number;
  screenshot?: boolean;
  maxElements?: number;
  targetId?: string;
};

type ContentItem = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type FastResult = { content: ContentItem[]; details: Record<string, unknown> };

function result(content: ContentItem[], details: Record<string, unknown> = {}): FastResult {
  return { content, details };
}
function textResult(text: string, details: Record<string, unknown> = {}): FastResult {
  return result([{ type: "text", text }], details);
}

function resolveTarget(
  targets: ExtensionRelayTarget[],
  targetId?: string,
): ExtensionRelayTarget | undefined {
  return targetId ? targets.find((t) => t.targetId === targetId) : targets[0];
}

function renderObservation(res: unknown): string {
  const obs = (res ?? {}) as {
    elements?: Array<{ idx: number; tag: string; type?: string; role?: string; text?: string }>;
    url?: string;
    title?: string;
  };
  const els = Array.isArray(obs.elements) ? obs.elements : [];
  const lines = els.map((el) => {
    const kind = el.role || el.type || el.tag;
    const label = (el.text ?? "").replace(/\s+/g, " ").trim();
    return `[${el.idx}] ${kind}${label ? ` "${label}"` : ""}`;
  });
  return [`Page: ${obs.title ?? ""}`, `URL: ${obs.url ?? ""}`, `${els.length} interactive elements:`, ...lines].join("\n");
}

function screenshotImage(res: unknown): ContentItem | null {
  const shot = (res ?? {}) as { data?: string; format?: string };
  if (!shot.data) return null;
  return { type: "image", data: shot.data, mimeType: shot.format === "jpeg" ? "image/jpeg" : "image/png" };
}

export function createBrowserFastTool(deps: {
  resolveServer: () => Promise<ChromeExtensionRelayServer | null>;
}): AnyAgentTool {
  return {
    name: "browser_fast",
    label: "Browser (fast)",
    description:
      "Fast, full control of the relay-attached browser via one-round-trip commands (Accio-style). " +
      "navigate/open_tab to a URL, observe to see numbered interactive elements (+optional screenshot), " +
      "then click/type/scroll/hover/press_key by index, read for page text, find for in-page search. " +
      "Prefer this over the slower `browser` tool for any relay-tab work; only use `browser` for download/pdf/raw evaluate.",
    parameters: BrowserFastSchema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as BrowserFastParams;
      const server = await deps.resolveServer();
      if (!server) return textResult("Browser relay is not running (no server on the relay port).");
      if (!server.extensionConnected())
        return textResult("Browser relay extension is not connected. Open the extension and attach a tab, then retry.");

      const targets = server.listExtensionTargets();

      // Tab-level actions that don't need a pre-attached target.
      if (p.action === "list_tabs") {
        const lines = targets.map((t, i) => `${i + 1}. ${t.targetId} — ${t.title || ""} (${t.url || ""})`);
        return textResult(targets.length ? `Attached tabs:\n${lines.join("\n")}` : "No attached tabs.", {
          count: targets.length,
        });
      }
      if (p.action === "open_tab") {
        if (!p.url) return textResult("open_tab requires `url`.");
        const res = (await server.sendExtensionCommand("Target.createTarget", { url: p.url })) as {
          targetId?: string;
        };
        return textResult(`Opened tab ${res?.targetId ?? ""} at ${p.url}`, { targetId: res?.targetId });
      }
      if (p.action === "activate_tab" || p.action === "close_tab") {
        const targetId = p.targetId ?? targets[0]?.targetId;
        if (!targetId) return textResult(`${p.action} requires a targetId (none attached).`);
        const method = p.action === "activate_tab" ? "Target.activateTarget" : "Target.closeTarget";
        const res = (await server.sendExtensionCommand(method, { targetId })) as {
          success?: boolean;
          error?: string;
        };
        if (res && res.success === false) return textResult(`${p.action} failed: ${res.error ?? "unknown"}`);
        return textResult(`${p.action === "activate_tab" ? "Activated" : "Closed"} tab ${targetId}.`);
      }

      // Everything else acts on a specific tab.
      const target = resolveTarget(targets, p.targetId);
      if (!target)
        return textResult("No attached tab. Click the OpenClaw Browser Relay toolbar icon on the tab you want to control.");
      const opts = { sessionId: target.sessionId, targetId: target.targetId };
      const send = (method: string, params?: unknown) => server.sendExtensionCommand(method, params, opts);

      try {
        switch (p.action) {
          case "navigate": {
            if (!p.url) return textResult("navigate requires `url`.");
            const res = (await send("Extension.navigate", { url: p.url })) as { url?: string; title?: string };
            return textResult(`Navigated to ${res?.url ?? p.url}${res?.title ? ` — ${res.title}` : ""}`, {
              url: res?.url,
            });
          }
          case "observe": {
            const marks = await send("Extension.markElements", { maxElements: p.maxElements ?? 200 });
            const items: ContentItem[] = [{ type: "text", text: renderObservation(marks) }];
            if (p.screenshot) {
              const img = screenshotImage(await send("Extension.captureViewport", { format: "jpeg", quality: 70 }));
              if (img) items.push(img);
            }
            return result(items, { targetId: target.targetId, url: target.url });
          }
          case "read": {
            const res = (await send("Extension.extractContent")) as {
              title?: string;
              url?: string;
              content?: string;
            };
            return textResult(`# ${res?.title ?? ""}\n${res?.url ?? ""}\n\n${res?.content ?? ""}`, {
              targetId: target.targetId,
            });
          }
          case "click": {
            if (p.index == null && !p.selector) return textResult("click requires `index` or `selector`.");
            const res = (await send("Extension.click", {
              index: p.index,
              selector: p.selector,
              clickType: p.clickType,
            })) as { success?: boolean; error?: string; text?: string };
            if (!res?.success) return textResult(`Click failed: ${res?.error ?? "unknown error"}`);
            return textResult(`Clicked [${p.index ?? p.selector}] ${res.text ?? ""}`.trim());
          }
          case "type": {
            if (p.index == null && !p.selector) return textResult("type requires `index` or `selector`.");
            if (p.text == null) return textResult("type requires `text`.");
            const res = (await send("Extension.input", {
              index: p.index,
              selector: p.selector,
              text: p.text,
            })) as { success?: boolean; error?: string };
            if (!res?.success) return textResult(`Type failed: ${res?.error ?? "unknown error"}`);
            return textResult(`Typed into [${p.index ?? p.selector}].`);
          }
          case "scroll": {
            const res = (await send("Extension.scroll", {
              direction: p.direction,
              amount: p.amount,
              selector: p.selector,
              index: p.index,
            })) as { atBottom?: boolean; after?: { y?: number } };
            return textResult(`Scrolled ${p.direction ?? "down"} (y=${res?.after?.y ?? "?"}${res?.atBottom ? ", at bottom" : ""}).`);
          }
          case "press_key": {
            if (!p.key) return textResult("press_key requires `key`.");
            const res = (await send("Extension.pressKey", { key: p.key, modifiers: p.modifiers })) as {
              success?: boolean;
              error?: string;
            };
            if (!res?.success) return textResult(`press_key failed: ${res?.error ?? "unknown"}`);
            return textResult(`Pressed ${[...(p.modifiers ?? []), p.key].join("+")}.`);
          }
          case "hover": {
            if (p.index == null && !p.selector) return textResult("hover requires `index` or `selector`.");
            const res = (await send("Extension.moveMouse", { index: p.index, selector: p.selector })) as {
              success?: boolean;
              error?: string;
            };
            if (!res?.success) return textResult(`hover failed: ${res?.error ?? "unknown"}`);
            return textResult(`Hovered [${p.index ?? p.selector}].`);
          }
          case "find": {
            if (!p.keyword) return textResult("find requires `keyword`.");
            const res = (await send("Extension.findKeyword", { keyword: p.keyword, limit: 20 })) as {
              count?: number;
              matches?: Array<{ context?: string }>;
            };
            const lines = (res?.matches ?? []).map((m, i) => `${i + 1}. …${m.context ?? ""}…`);
            return textResult(`Found ${res?.count ?? 0} match(es) for "${p.keyword}":\n${lines.join("\n")}`);
          }
          case "screenshot": {
            const img = screenshotImage(await send("Extension.captureViewport", { format: "jpeg", quality: 70 }));
            if (!img) return textResult("Screenshot failed (no data).");
            return result([{ type: "text", text: "Viewport screenshot:" }, img], { targetId: target.targetId });
          }
          case "viewport": {
            const res = await send("Extension.getViewportInfo");
            return textResult(`Viewport: ${JSON.stringify(res)}`, { viewport: res as Record<string, unknown> });
          }
          case "zoom": {
            const res = await send("Extension.ensureZoom", { zoom: p.zoomLevel ?? 1 });
            return textResult(`Zoom set: ${JSON.stringify(res)}`);
          }
          default:
            return textResult(`Unknown action: ${String((p as { action?: unknown }).action)}`);
        }
      } catch (err) {
        return textResult(`Fast browser command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
