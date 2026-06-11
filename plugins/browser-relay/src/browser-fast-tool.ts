import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { ChromeExtensionRelayServer, ExtensionRelayTarget } from "./relay/extension-relay.js";

/**
 * Coarse-grained "fast" browser tool.
 *
 * It speaks the relay's high-level `Extension.*` commands directly, in-process,
 * so each action is ONE relay round-trip to the extension — not the dozens of
 * fine-grained CDP calls Playwright issues over `/cdp`. On a remote link
 * (laptop -> gateway) round-trip count dominates latency, so this is the main
 * lever that makes relay-driven browsing fast.
 *
 * Loop: `observe` -> numbered interactive elements -> `click`/`type` by index;
 * `read` for page text. For anything advanced (downloads, eval, multi-frame),
 * fall back to the standard `browser` tool (Playwright over the same relay).
 */

const FAST_ACTIONS = ["observe", "click", "type", "read"] as const;

const BrowserFastSchema = Type.Object({
  action: stringEnum([...FAST_ACTIONS], {
    description:
      "observe = list numbered interactive elements; click = click element by index; type = set an input's value by index; read = extract page text as Markdown.",
  }),
  index: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-based element index from a prior observe. Required for click/type.",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Text to enter. Required for type." })),
  selector: Type.Optional(
    Type.String({ description: "Optional CSS selector instead of index (click/type)." }),
  ),
  targetId: Type.Optional(
    Type.String({
      description: "Optional CDP targetId to act on. Defaults to the relay's attached tab.",
    }),
  ),
  maxElements: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description: "observe: cap on returned elements (default 200).",
    }),
  ),
});

type BrowserFastParams = {
  action: (typeof FAST_ACTIONS)[number];
  index?: number;
  text?: string;
  selector?: string;
  targetId?: string;
  maxElements?: number;
};

type FastResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function textResult(text: string, details: Record<string, unknown> = {}): FastResult {
  return { content: [{ type: "text", text }], details };
}

/** Pick the requested target, or the sole attached tab. */
function resolveTarget(
  targets: ExtensionRelayTarget[],
  targetId?: string,
): ExtensionRelayTarget | undefined {
  if (targetId) {
    return targets.find((t) => t.targetId === targetId);
  }
  return targets[0];
}

function renderObservation(result: unknown): string {
  const obs = (result ?? {}) as {
    elements?: Array<{ idx: number; tag: string; type?: string; role?: string; text?: string }>;
    url?: string;
    title?: string;
    viewport?: { width: number; height: number };
  };
  const elements = Array.isArray(obs.elements) ? obs.elements : [];
  const header = `Page: ${obs.title ?? ""}\nURL: ${obs.url ?? ""}\n${elements.length} interactive elements:`;
  const lines = elements.map((el) => {
    const kind = el.role || el.type || el.tag;
    const label = (el.text ?? "").replace(/\s+/g, " ").trim();
    return `[${el.idx}] ${kind}${label ? ` "${label}"` : ""}`;
  });
  return [header, ...lines].join("\n");
}

export function createBrowserFastTool(deps: {
  resolveServer: () => Promise<ChromeExtensionRelayServer | null>;
}): AnyAgentTool {
  return {
    name: "browser_fast",
    label: "Browser (fast)",
    description:
      "Fast control of the relay-attached browser via one-round-trip commands. " +
      "Use action=observe to see numbered interactive elements, then action=click/type with the index, " +
      "and action=read to extract page text. Prefer this over the slower browser tool for simple " +
      "navigate/click/read steps on the relay tab.",
    parameters: BrowserFastSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as BrowserFastParams;
      const server = await deps.resolveServer();
      if (!server) {
        return textResult("Browser relay is not running (no server on the relay port).");
      }
      if (!server.extensionConnected()) {
        return textResult(
          "Browser relay extension is not connected. Open the extension and attach a tab, then retry.",
        );
      }

      const targets = server.listExtensionTargets();
      const target = resolveTarget(targets, params.targetId);
      if (!target) {
        return textResult(
          "No attached tab. Click the OpenClaw Browser Relay toolbar icon on the tab you want to control.",
        );
      }
      const opts = { sessionId: target.sessionId, targetId: target.targetId };

      try {
        switch (params.action) {
          case "observe": {
            const result = await server.sendExtensionCommand(
              "Extension.markElements",
              { maxElements: params.maxElements ?? 200 },
              opts,
            );
            return textResult(renderObservation(result), {
              targetId: target.targetId,
              url: target.url,
            });
          }
          case "read": {
            const result = (await server.sendExtensionCommand(
              "Extension.extractContent",
              {},
              opts,
            )) as { title?: string; url?: string; content?: string };
            const body = result?.content ?? "";
            return textResult(`# ${result?.title ?? ""}\n${result?.url ?? ""}\n\n${body}`, {
              targetId: target.targetId,
            });
          }
          case "click": {
            if (params.index == null && !params.selector) {
              return textResult("click requires `index` (from observe) or `selector`.");
            }
            const result = (await server.sendExtensionCommand(
              "Extension.click",
              { index: params.index, selector: params.selector },
              opts,
            )) as { success?: boolean; error?: string; text?: string };
            if (!result?.success) {
              return textResult(`Click failed: ${result?.error ?? "unknown error"}`);
            }
            return textResult(`Clicked [${params.index ?? params.selector}] ${result.text ?? ""}`.trim());
          }
          case "type": {
            if (params.index == null && !params.selector) {
              return textResult("type requires `index` (from observe) or `selector`.");
            }
            if (params.text == null) {
              return textResult("type requires `text`.");
            }
            const result = (await server.sendExtensionCommand(
              "Extension.input",
              { index: params.index, selector: params.selector, text: params.text },
              opts,
            )) as { success?: boolean; error?: string };
            if (!result?.success) {
              return textResult(`Type failed: ${result?.error ?? "unknown error"}`);
            }
            return textResult(`Typed into [${params.index ?? params.selector}].`);
          }
          default:
            return textResult(`Unknown action: ${String((params as { action?: unknown }).action)}`);
        }
      } catch (err) {
        return textResult(`Fast browser command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
