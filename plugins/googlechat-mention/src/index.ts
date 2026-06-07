import { Type, type Static } from "typebox";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { listAllSpaceMembers, normalizeSpace, type ChatMember } from "./chat-api.js";

const PLUGIN_ID = "googlechat-mention";
const GOOGLECHAT_CHANNEL = "googlechat";

type PluginConfig = {
  /** Service account key path (chat.bot). Falls back to env GOOGLE_CHAT_SERVICE_ACCOUNT(_FILE). */
  serviceAccountFile?: string;
  /**
   * Explicit allowlist of spaces whose membership this plugin may read to resolve
   * names. When set it wins (empty array denies all). When UNSET it is INHERITED
   * from the googlechat channel's enabled `channels.googlechat.groups` allowlist,
   * so there is one source of truth for which spaces are in scope.
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
// without coupling to its full type. requesterSenderId is the inbound sender's
// id, used to resolve "me" without a members lookup.
type ToolContext = {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string };
  requesterSenderId?: string;
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
// a stable `spaces/<id>`. Empty unless groupPolicy is "allowlist".
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
        "No spaces are in scope (deny-by-default). Either add the space to the googlechat " +
        'channel allowlist (channels.googlechat.groups with groupPolicy: "allowlist"), or set ' +
        "plugins.entries.googlechat-mention.config.allowedSpaces explicitly.",
    };
  }
  if (!allowed.has(space)) {
    return { error: `Refusing to read members of ${space}: it is not allowlisted.` };
  }
  return { space };
}

// "me"/"requester"/"self" mentions the inbound sender (no lookup); "all"/"@all"
// mentions everyone; a raw id ("users/123" or "123456") mentions that user
// directly; anything else is a display name to resolve against the membership.
type MentionRequest =
  | { kind: "self" }
  | { kind: "all" }
  | { kind: "id"; id: string }
  | { kind: "name"; name: string };

function classifyMention(raw: string): MentionRequest | null {
  const value = raw.trim().replace(/^@/, "").trim();
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === "me" || lower === "requester" || lower === "self") {
    return { kind: "self" };
  }
  if (lower === "all") {
    return { kind: "all" };
  }
  const idMatch = value.match(/^(?:users\/)?(\d{3,})$/);
  if (idMatch) {
    return { kind: "id", id: `users/${idMatch[1]}` };
  }
  return { kind: "name", name: value };
}

/** Wrap a "users/<id>" (or "all") into Chat mention syntax. */
function token(userResource: string): string {
  return `<${userResource}>`;
}

// Resolve each request to a "<users/...>" token. Display names match human members
// (case-insensitive). Returns either ordered, de-duplicated tokens plus a
// per-name map, or one actionable error listing unresolved/ambiguous names and
// the visible members so the agent can retry with a precise name or id.
type MentionResolution =
  | { tokens: string[]; byName: Record<string, string> }
  | { error: string };

function resolveMentionTokens(
  requests: MentionRequest[],
  members: ChatMember[],
  requesterSenderId: string | undefined,
): MentionResolution {
  const humans = members.filter((m) => (m.member?.type ?? "HUMAN") === "HUMAN");
  const byDisplay = new Map<string, string[]>();
  for (const m of humans) {
    const display = m.member?.displayName?.trim().toLowerCase();
    const id = m.member?.name;
    if (display && id) {
      const ids = byDisplay.get(display) ?? [];
      ids.push(id);
      byDisplay.set(display, ids);
    }
  }

  const tokens: string[] = [];
  const byName: Record<string, string> = {};
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  for (const req of requests) {
    if (req.kind === "self") {
      const id = requesterSenderId?.trim();
      if (id && /^users\//.test(id)) {
        tokens.push(token(id));
        byName["me"] = token(id);
      } else {
        unresolved.push("me (no requester id in context)");
      }
      continue;
    }
    if (req.kind === "all") {
      tokens.push(token("users/all"));
      byName["all"] = token("users/all");
      continue;
    }
    if (req.kind === "id") {
      tokens.push(token(req.id));
      byName[req.id] = token(req.id);
      continue;
    }
    const matches = byDisplay.get(req.name.toLowerCase());
    if (!matches || matches.length === 0) {
      unresolved.push(req.name);
    } else if (matches.length > 1) {
      ambiguous.push(req.name);
    } else {
      tokens.push(token(matches[0] as string));
      byName[req.name] = token(matches[0] as string);
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

  // De-duplicate tokens while preserving first-seen order.
  return { tokens: [...new Set(tokens)], byName };
}

function errorResult(text: string, code = "error") {
  return { content: [{ type: "text" as const, text }], details: { error: code } };
}

const MentionSchema = Type.Object({
  mentions: Type.Array(
    Type.String({
      description:
        "Who to tag. Each entry is a display name (resolved against space members), a user id " +
        "('users/123...' or the numeric id), 'me'/'requester' (the person you are replying to), " +
        "or 'all' for everyone in the space.",
    }),
    { description: "People to resolve into @mention tokens. At least one entry is required." },
  ),
  space: Type.Optional(
    Type.String({
      description:
        "Space id, e.g. 'spaces/AAQAxxxx' or 'AAQAxxxx'. Omit to use the current Google Chat space. Must be allowlisted.",
    }),
  ),
});
type MentionParams = Static<typeof MentionSchema>;

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat Mention",
  description:
    "Resolve Google Chat @mention tokens (<users/id>) so your normal reply can tag people in an ALLOWLISTED space.",
  register(api) {
    api.registerTool(
      (ctx: ToolContext): AnyAgentTool => ({
        name: "googlechat_mention",
        label: "Google Chat Mention",
        description:
          "Resolve people into Google Chat @mention tokens. Returns one '<users/ID>' token per " +
          "person; you then PASTE those tokens VERBATIM into your normal reply text where each " +
          "@mention should appear (e.g. start your reply with '<users/123> ...'). Do NOT describe " +
          "or alter the tokens — write them exactly as returned. Google Chat renders them as real " +
          "@mentions (with a notification). Use this only when a reply needs to actually tag/notify " +
          "someone. Accepts display names (resolved against the space's members), a 'users/<id>', " +
          "'me' for the person you are replying to, or 'all'. Omit `space` to use the current space.",
        parameters: MentionSchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as MentionParams;
          const requests = params.mentions
            .map(classifyMention)
            .filter((r): r is MentionRequest => r !== null);
          if (requests.length === 0) {
            return errorResult(
              "`mentions` must contain at least one name, 'users/<id>', 'me', or 'all'.",
              "bad_request",
            );
          }

          // Only list members when a display name actually needs resolving — id /
          // 'me' / 'all' never touch the members API.
          const needsMembers = requests.some((r) => r.kind === "name");
          let members: ChatMember[] = [];
          if (needsMembers) {
            const { cfg, config } = resolveLive(api);
            const checked = checkSpace(params.space, ctx, allowedSpaceSet(cfg, config));
            if ("error" in checked) {
              return errorResult(checked.error, "space_denied");
            }
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

          const resolved = resolveMentionTokens(requests, members, ctx.requesterSenderId);
          if ("error" in resolved) {
            return errorResult(resolved.error, "mention_unresolved");
          }

          const lines = Object.entries(resolved.byName).map(([who, tok]) => `- ${who} → ${tok}`);
          const text =
            "Paste these mention token(s) VERBATIM into your reply text where the @mention should " +
            `appear (do not send a separate message, do not alter them):\n${lines.join("\n")}\n\n` +
            `Combined: ${resolved.tokens.join(" ")}`;
          return {
            content: [{ type: "text", text }],
            details: { tokens: resolved.tokens, byName: resolved.byName },
          };
        },
      }),
      { name: "googlechat_mention" },
    );
  },
});
