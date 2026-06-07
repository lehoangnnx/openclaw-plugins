import { Type, type Static } from "typebox";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { createMessage, listAllSpaceMembers, normalizeSpace, type ChatMember } from "./chat-api.js";

const PLUGIN_ID = "googlechat-mention";
const GOOGLECHAT_CHANNEL = "googlechat";

type PluginConfig = {
  /** Service account key path (chat.bot). Falls back to env GOOGLE_CHAT_SERVICE_ACCOUNT(_FILE). */
  serviceAccountFile?: string;
  /**
   * Explicit allowlist of spaces this plugin may post into. When set it wins (an
   * empty array denies everything). When UNSET it is INHERITED from the googlechat
   * channel's enabled `channels.googlechat.groups` allowlist, so there is one
   * source of truth for which spaces the agent can write to.
   */
  allowedSpaces?: string[];
};

// Structural read of the googlechat channel's space allowlist. We mirror it
// instead of importing the channel package: the channel owns this contract, we
// only observe its resolved config. Only stable `spaces/<id>` entries inherit.
type GoogleChatChannelConfig = {
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, { enabled?: boolean } | null | undefined>;
};

// Structural subset of the trusted tool context we read. Declaring only the
// fields we use keeps us assignable from the real OpenClawPluginToolContext
// without coupling to its full type.
type ToolContext = {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string };
};

// One live config snapshot per call so operators can change auth / allowlist (and
// the inherited googlechat allowlist) without a gateway restart.
function resolveLive(api: OpenClawPluginApi): { cfg: PluginConfig; config: OpenClawConfig | undefined } {
  const config = api.runtime.config?.current
    ? (api.runtime.config.current() as OpenClawConfig)
    : undefined;
  const cfg = resolveLivePluginConfigObject(
    config ? () => config : undefined,
    PLUGIN_ID,
    api.pluginConfig as Record<string, unknown>,
  ) as PluginConfig | undefined;
  return { cfg: cfg ?? {}, config };
}

// Spaces the googlechat channel already admits: enabled allowlist groups keyed by
// a stable `spaces/<id>`. Empty unless groupPolicy is "allowlist" (an open/disabled
// channel yields no finite list, so we deny rather than write anywhere reachable).
function inheritedAllowedSpaces(config: OpenClawConfig | undefined): string[] {
  const channels = config?.channels as Record<string, unknown> | undefined;
  const gc = channels?.[GOOGLECHAT_CHANNEL] as GoogleChatChannelConfig | undefined;
  if (!gc || gc.groupPolicy !== "allowlist" || !gc.groups) {
    return [];
  }
  return Object.entries(gc.groups)
    .filter(([key, entry]) => /^spaces\//i.test(key.trim()) && entry?.enabled !== false)
    .map(([key]) => normalizeSpace(key));
}

/** Pull a "spaces/<id>" out of any string that contains one. */
function extractSpaceId(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/spaces\/[A-Za-z0-9_-]+/);
  return match ? match[0] : undefined;
}

// Best-effort current-space resolution from the ambient delivery route, so the
// model can omit `space` when already running inside a Google Chat space.
function resolveAmbientSpace(ctx: ToolContext): string | undefined {
  const channel = ctx.messageChannel ?? ctx.deliveryContext?.channel;
  if (channel && channel !== GOOGLECHAT_CHANNEL) {
    return undefined;
  }
  const target = ctx.deliveryContext?.to?.trim();
  if (!target) {
    return undefined;
  }
  return extractSpaceId(target) ?? (channel === GOOGLECHAT_CHANNEL ? normalizeSpace(target) : undefined);
}

function resolveSpaceArg(explicit: string | undefined, ctx: ToolContext): string | undefined {
  const fromArg = explicit?.trim();
  if (fromArg) {
    return normalizeSpace(fromArg);
  }
  return resolveAmbientSpace(ctx);
}

const NO_SPACE_TEXT =
  "No Google Chat space id available. Pass `space` (e.g. spaces/AAQAxxxx) or run inside a Google Chat space conversation.";

// Deny-by-default allowlist: explicit `allowedSpaces` wins (empty array => deny
// all); otherwise inherit the googlechat channel allowlist (one source of truth).
function allowedSpaceSet(cfg: PluginConfig, config: OpenClawConfig | undefined): Set<string> {
  const list = cfg.allowedSpaces ?? inheritedAllowedSpaces(config);
  return new Set(list.map((s) => normalizeSpace(s)));
}

type SpaceCheck = { space: string } | { error: string };

function checkSpace(explicit: string | undefined, ctx: ToolContext, allowed: Set<string>): SpaceCheck {
  const space = resolveSpaceArg(explicit, ctx);
  if (!space) {
    return { error: NO_SPACE_TEXT };
  }
  if (allowed.size === 0) {
    return {
      error:
        "No spaces are writable (deny-by-default). Either add the space to the googlechat " +
        'channel allowlist (channels.googlechat.groups with groupPolicy: "allowlist"), or set ' +
        "plugins.entries.googlechat-mention.config.allowedSpaces explicitly.",
    };
  }
  if (!allowed.has(space)) {
    return { error: `Refusing to post to ${space}: it is not allowlisted.` };
  }
  return { space };
}

// "all"/"@all" mentions everyone; a raw id ("users/123" or "123456") mentions
// that user directly; anything else is a display name to resolve against the
// space membership.
type MentionRequest =
  | { kind: "all" }
  | { kind: "id"; id: string }
  | { kind: "name"; name: string };

function classifyMention(raw: string): MentionRequest | null {
  const value = raw.trim().replace(/^@/, "").trim();
  if (!value) {
    return null;
  }
  if (value.toLowerCase() === "all") {
    return { kind: "all" };
  }
  const idMatch = value.match(/^(?:users\/)?(\d{3,})$/);
  if (idMatch) {
    return { kind: "id", id: `users/${idMatch[1]}` };
  }
  return { kind: "name", name: value };
}

// Resolve display names against human members (case-insensitive). Returns either
// the ordered, de-duplicated mention tokens or a single actionable error listing
// the unresolved/ambiguous names plus the members we could see, so the agent can
// retry with a precise name or id rather than tagging the wrong person.
type MentionResolution = { tokens: string[] } | { error: string };

function resolveMentionTokens(requests: MentionRequest[], members: ChatMember[]): MentionResolution {
  const humans = members.filter((m) => (m.member?.type ?? "HUMAN") === "HUMAN");
  const byName = new Map<string, string[]>();
  for (const m of humans) {
    const display = m.member?.displayName?.trim().toLowerCase();
    const id = m.member?.name;
    if (display && id) {
      const ids = byName.get(display) ?? [];
      ids.push(id);
      byName.set(display, ids);
    }
  }

  const tokens: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  for (const req of requests) {
    if (req.kind === "all") {
      tokens.push("<users/all>");
      continue;
    }
    if (req.kind === "id") {
      tokens.push(`<${req.id}>`);
      continue;
    }
    const matches = byName.get(req.name.toLowerCase());
    if (!matches || matches.length === 0) {
      unresolved.push(req.name);
    } else if (matches.length > 1) {
      ambiguous.push(req.name);
    } else {
      tokens.push(`<${matches[0]}>`);
    }
  }

  if (unresolved.length > 0 || ambiguous.length > 0) {
    const names = humans
      .map((m) => m.member?.displayName)
      .filter((n): n is string => Boolean(n))
      .sort();
    const parts: string[] = [];
    if (unresolved.length > 0) {
      parts.push(`No space member matched: ${unresolved.join(", ")}.`);
    }
    if (ambiguous.length > 0) {
      parts.push(`Multiple members share these names: ${ambiguous.join(", ")} — pass a 'users/<id>' instead.`);
    }
    parts.push(
      names.length > 0
        ? `Known members: ${names.join(", ")}.`
        : "No members were visible (the Chat app may not be in this space).",
    );
    return { error: parts.join(" ") };
  }

  // De-duplicate while preserving first-seen order so repeated names/ids do not
  // produce duplicate pings.
  return { tokens: [...new Set(tokens)] };
}

function errorResult(text: string, code = "error") {
  return { content: [{ type: "text" as const, text }], details: { error: code } };
}

const MentionSchema = Type.Object({
  text: Type.String({
    description: "The message body to post. Mentions are prepended to this text.",
  }),
  mentions: Type.Array(
    Type.String({
      description:
        "Who to tag. Each entry is a display name (resolved against space members), a user id " +
        "('users/123...' or the numeric id), or 'all' for everyone in the space.",
    }),
    { description: "People to @mention. At least one entry is required." },
  ),
  space: Type.Optional(
    Type.String({
      description:
        "Space id, e.g. 'spaces/AAQAxxxx' or 'AAQAxxxx'. Omit to use the current Google Chat space. Must be allowlisted.",
    }),
  ),
  thread: Type.Optional(
    Type.String({
      description:
        "Thread resource name (e.g. 'spaces/AAQA.../threads/xyz') to reply within. Omit to start a new thread.",
    }),
  ),
});
type MentionParams = Static<typeof MentionSchema>;

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat Mention",
  description: "Post a message that @mentions specific people (or everyone) in an ALLOWLISTED Google Chat space.",
  register(api) {
    api.registerTool(
      (ctx: ToolContext): AnyAgentTool => ({
        name: "googlechat_mention",
        label: "Google Chat Mention",
        description:
          "Send a Google Chat message that @mentions people (or everyone) in an allowlisted space. " +
          "Use this only when a reply needs to actually tag/notify someone — the normal reply path " +
          "cannot render mentions. Omit `space` to post in the current space. Names are resolved " +
          "against the space's members; you can also pass a 'users/<id>' or 'all'.",
        parameters: MentionSchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as MentionParams;
          const text = params.text?.trim();
          if (!text) {
            return errorResult("`text` is required and cannot be empty.", "bad_request");
          }

          const requests = params.mentions
            .map(classifyMention)
            .filter((r): r is MentionRequest => r !== null);
          if (requests.length === 0) {
            return errorResult(
              "`mentions` must contain at least one name, 'users/<id>', or 'all'.",
              "bad_request",
            );
          }

          const { cfg, config } = resolveLive(api);
          const checked = checkSpace(params.space, ctx, allowedSpaceSet(cfg, config));
          if ("error" in checked) {
            return errorResult(checked.error, "space_denied");
          }

          // Only list members when a display name actually needs resolving — id /
          // 'all' mentions never touch the members API.
          const needsMembers = requests.some((r) => r.kind === "name");
          let members: ChatMember[] = [];
          if (needsMembers) {
            try {
              members = await listAllSpaceMembers({
                space: checked.space,
                serviceAccountFile: cfg.serviceAccountFile,
              });
            } catch (err) {
              return errorResult(
                `Could not list members of ${checked.space} to resolve names: ${(err as Error).message}`,
                "members_failed",
              );
            }
          }

          const resolved = resolveMentionTokens(requests, members);
          if ("error" in resolved) {
            return errorResult(resolved.error, "mention_unresolved");
          }

          const messageText = `${resolved.tokens.join(" ")} ${text}`;
          try {
            const result = await createMessage({
              space: checked.space,
              text: messageText,
              thread: params.thread,
              serviceAccountFile: cfg.serviceAccountFile,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Sent mention message to ${checked.space} (${resolved.tokens.length} mention(s)).`,
                },
              ],
              details: {
                space: checked.space,
                messageName: result.name ?? null,
                mentions: resolved.tokens.length,
              },
            };
          } catch (err) {
            return errorResult(
              `Failed to send mention message to ${checked.space}: ${(err as Error).message}`,
              "send_failed",
            );
          }
        },
      }),
      { name: "googlechat_mention" },
    );
  },
});
