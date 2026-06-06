import { Type, type Static } from "typebox";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  getSpace,
  listSpaceMembers,
  listSpaceMessages,
  normalizeSpace,
  type ChatMessage,
  type MessagesAuth,
} from "./chat-api.js";

const PLUGIN_ID = "googlechat-history";
const GOOGLECHAT_CHANNEL = "googlechat";
const AUTO_CONTEXT_DEFAULT_COUNT = 15;
const AUTO_CONTEXT_MAX_COUNT = 50;

type PluginConfig = {
  /** "app" = service account (needs admin scope to read messages); "user" = OAuth as a human. */
  authMode?: "app" | "user";
  /** Service account key path — used by app-mode reads and by members/space-info (chat.bot). */
  serviceAccountFile?: string;
  /** User-auth OAuth credentials for message reads (env fallback: GOOGLE_CHAT_OAUTH_*). */
  user?: { clientId?: string; clientSecret?: string; refreshToken?: string };
  /** Allowlist of readable spaces. Deny-by-default: empty/unset => nothing is readable. */
  allowedSpaces?: string[];
  autoContext?: { enabled?: boolean; messageCount?: number };
};

// Structural subset of the trusted tool context we read. Declaring only the
// fields we use avoids coupling to the full SDK context type/import path while
// staying assignable from the real OpenClawPluginToolContext.
type ToolContext = {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string };
};

// Resolve the live plugin config on each call so operators can change auth /
// allowlist / auto-context settings without restarting the gateway.
function resolvePluginConfig(api: OpenClawPluginApi): PluginConfig {
  const cfg = resolveLivePluginConfigObject(
    api.runtime.config?.current
      ? () => api.runtime.config.current() as OpenClawConfig
      : undefined,
    PLUGIN_ID,
    api.pluginConfig as Record<string, unknown>,
  ) as PluginConfig | undefined;
  return cfg ?? {};
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
// model can omit `space` when the agent is already running inside a Google Chat
// space. Only trusts the route when it is a Google Chat conversation.
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

// Deny-by-default allowlist: a space is readable only if it is explicitly listed.
function allowedSpaceSet(cfg: PluginConfig): Set<string> {
  return new Set((cfg.allowedSpaces ?? []).map((s) => normalizeSpace(s)));
}

type SpaceCheck = { space: string } | { error: string };

function checkSpace(
  explicit: string | undefined,
  ctx: ToolContext,
  allowed: Set<string>,
): SpaceCheck {
  const space = resolveSpaceArg(explicit, ctx);
  if (!space) {
    return { error: NO_SPACE_TEXT };
  }
  if (allowed.size === 0) {
    return {
      error:
        "No spaces are allowed (deny-by-default). Configure " +
        "plugins.entries.googlechat-history.config.allowedSpaces with the space ids you permit.",
    };
  }
  if (!allowed.has(space)) {
    return {
      error: `Refusing to read ${space}: it is not in the allowedSpaces allowlist.`,
    };
  }
  return { space };
}

function resolveUserCreds(
  cfg: PluginConfig,
): { clientId: string; clientSecret: string; refreshToken: string } | undefined {
  const clientId = cfg.user?.clientId ?? process.env.GOOGLE_CHAT_OAUTH_CLIENT_ID;
  const clientSecret = cfg.user?.clientSecret ?? process.env.GOOGLE_CHAT_OAUTH_CLIENT_SECRET;
  const refreshToken = cfg.user?.refreshToken ?? process.env.GOOGLE_CHAT_OAUTH_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken };
  }
  return undefined;
}

function buildMessagesAuth(cfg: PluginConfig): MessagesAuth | { error: string } {
  if ((cfg.authMode ?? "app") === "user") {
    const creds = resolveUserCreds(cfg);
    if (!creds) {
      return {
        error:
          "authMode 'user' requires clientId/clientSecret/refreshToken " +
          "(config.user.* or GOOGLE_CHAT_OAUTH_* env). Run scripts/get-refresh-token.mjs to obtain a token.",
      };
    }
    return { mode: "user", ...creds };
  }
  return { mode: "app", serviceAccountFile: cfg.serviceAccountFile };
}

function shortThreadId(threadName?: string): string | undefined {
  if (!threadName) {
    return undefined;
  }
  const idx = threadName.lastIndexOf("/");
  return idx >= 0 ? threadName.slice(idx + 1) : threadName;
}

function renderMessageLine(message: ChatMessage): string {
  const who = message.sender?.displayName || message.sender?.name || "unknown";
  const when = message.createTime ?? "";
  const text = message.text ?? message.formattedText ?? message.argumentText ?? "(no text)";
  const attachmentCount = message.attachment?.length ?? 0;
  const attachment = attachmentCount > 0 ? ` [${attachmentCount} attachment(s)]` : "";
  const thread = shortThreadId(message.thread?.name);
  const threadTag = thread ? ` {thread ${thread}}` : "";
  return `[${when}] ${who}${threadTag}: ${text}${attachment}`;
}

function renderMessages(messages: ChatMessage[]): string {
  return messages.length > 0
    ? messages.map(renderMessageLine).join("\n")
    : "(no messages returned)";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function errorResult(text: string, code = "error") {
  return { content: [{ type: "text" as const, text }], details: { error: code } };
}

const HistorySchema = Type.Object({
  space: Type.Optional(
    Type.String({
      description:
        "Space id, e.g. 'spaces/AAQAxxxx' or 'AAQAxxxx'. Omit to use the current Google Chat space when the agent is running inside one. Must be in the configured allowlist.",
    }),
  ),
  pageSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: "Max messages to return (Chat API allows up to 1000; default 25).",
    }),
  ),
  filter: Type.Optional(
    Type.String({
      description:
        'Chat API filter, e.g. createTime > "2026-06-01T00:00:00Z" AND createTime < "2026-06-05T00:00:00Z".',
    }),
  ),
  orderBy: Type.Optional(
    // Flat string enum (not Type.Union of literals) so tool-schema consumers
    // that reject `anyOf` (e.g. some provider runtimes) accept it.
    Type.Unsafe<"ASC" | "DESC">({
      type: "string",
      enum: ["ASC", "DESC"],
      description: "Sort by createTime: ASC (oldest first, default) or DESC (newest first).",
    }),
  ),
  pageToken: Type.Optional(
    Type.String({ description: "Page token from a previous call to fetch the next page." }),
  ),
});
type HistoryParams = Static<typeof HistorySchema>;

const MembersSchema = Type.Object({
  space: Type.Optional(
    Type.String({ description: "Space id; omit to use the current Google Chat space. Must be allowlisted." }),
  ),
  pageSize: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: "Max members to return." }),
  ),
  pageToken: Type.Optional(Type.String({ description: "Page token for the next page." })),
});
type MembersParams = Static<typeof MembersSchema>;

const SpaceInfoSchema = Type.Object({
  space: Type.Optional(
    Type.String({ description: "Space id; omit to use the current Google Chat space. Must be allowlisted." }),
  ),
});
type SpaceInfoParams = Static<typeof SpaceInfoSchema>;

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat History",
  description: "Read history, members, and metadata from ALLOWLISTED Google Chat spaces via the Chat API.",
  register(api) {
    // #1–#4: read space history the bot never received (no @mention / before it
    // joined). Honors authMode (app|user) and the deny-by-default allowlist.
    api.registerTool(
      (ctx: ToolContext): AnyAgentTool => ({
        name: "googlechat_history",
        label: "Google Chat History",
        description:
          "Fetch messages from an allowlisted Google Chat space — including history the bot did not " +
          "receive directly (no @mention, or before it joined). Omit `space` to use the current space. " +
          "Supports pageSize (up to 1000), createTime filter, orderBy, and pageToken.",
        parameters: HistorySchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as HistoryParams;
          const cfg = resolvePluginConfig(api);
          const checked = checkSpace(params.space, ctx, allowedSpaceSet(cfg));
          if ("error" in checked) {
            return errorResult(checked.error, "space_denied");
          }
          const auth = buildMessagesAuth(cfg);
          if ("error" in auth) {
            return errorResult(auth.error, "auth");
          }
          const { messages, nextPageToken } = await listSpaceMessages({
            space: checked.space,
            auth,
            pageSize: params.pageSize,
            filter: params.filter,
            orderBy: params.orderBy,
            pageToken: params.pageToken,
          });
          const text =
            renderMessages(messages) +
            (nextPageToken ? `\n\n[nextPageToken: ${nextPageToken}]` : "");
          return {
            content: [{ type: "text", text }],
            details: { space: checked.space, count: messages.length, nextPageToken: nextPageToken ?? null },
          };
        },
      }),
      { name: "googlechat_history" },
    );

    // #5: who is in the space (uses chat.bot service account). Allowlist-gated.
    api.registerTool(
      (ctx: ToolContext): AnyAgentTool => ({
        name: "googlechat_members",
        label: "Google Chat Members",
        description:
          "List members of an allowlisted Google Chat space (people and apps). Omit `space` to use the current space.",
        parameters: MembersSchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as MembersParams;
          const cfg = resolvePluginConfig(api);
          const checked = checkSpace(params.space, ctx, allowedSpaceSet(cfg));
          if ("error" in checked) {
            return errorResult(checked.error, "space_denied");
          }
          const { memberships, nextPageToken } = await listSpaceMembers({
            space: checked.space,
            pageSize: params.pageSize,
            pageToken: params.pageToken,
            serviceAccountFile: cfg.serviceAccountFile,
          });
          const lines = memberships.map((m) => {
            const who = m.member?.displayName || m.member?.name || m.name || "unknown";
            const role = m.role ? ` (${m.role})` : "";
            const type = m.member?.type ? ` [${m.member.type}]` : "";
            return `- ${who}${type}${role}`;
          });
          const text =
            (lines.length > 0 ? lines.join("\n") : "(no members returned)") +
            (nextPageToken ? `\n\n[nextPageToken: ${nextPageToken}]` : "");
          return {
            content: [{ type: "text", text }],
            details: { space: checked.space, count: memberships.length, nextPageToken: nextPageToken ?? null },
          };
        },
      }),
      { name: "googlechat_members" },
    );

    // #5: space metadata (uses chat.bot service account). Allowlist-gated.
    api.registerTool(
      (ctx: ToolContext): AnyAgentTool => ({
        name: "googlechat_space_info",
        label: "Google Chat Space Info",
        description:
          "Read metadata for an allowlisted Google Chat space (display name, type, history state). Omit `space` to use the current space.",
        parameters: SpaceInfoSchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as SpaceInfoParams;
          const cfg = resolvePluginConfig(api);
          const checked = checkSpace(params.space, ctx, allowedSpaceSet(cfg));
          if ("error" in checked) {
            return errorResult(checked.error, "space_denied");
          }
          const info = await getSpace({ space: checked.space, serviceAccountFile: cfg.serviceAccountFile });
          const lines = [
            `Space: ${info.displayName ?? info.name ?? checked.space}`,
            info.spaceType || info.type ? `Type: ${info.spaceType ?? info.type}` : undefined,
            info.spaceThreadingState ? `Threading: ${info.spaceThreadingState}` : undefined,
            info.spaceHistoryState ? `History: ${info.spaceHistoryState}` : undefined,
            info.membershipCount?.joinedDirectHumanUserCount !== undefined
              ? `Members (direct humans): ${info.membershipCount.joinedDirectHumanUserCount}`
              : undefined,
          ].filter((line): line is string => Boolean(line));
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { space: checked.space, spaceType: info.spaceType ?? info.type ?? null },
          };
        },
      }),
      { name: "googlechat_space_info" },
    );

    // #1: auto-context. Before a reply is built, prepend recent space history so
    // the agent has context without an explicit tool call. Off by default and
    // deny-by-default: only fires for an allowlisted space. The host must also
    // allow prompt injection + conversation access for this non-bundled plugin
    // (see README). Fail-safe: never blocks or breaks a turn.
    api.on("before_prompt_build", async (_event, ctx) => {
      const cfg = resolvePluginConfig(api);
      if (!cfg.autoContext?.enabled) {
        return;
      }
      const allowed = allowedSpaceSet(cfg);
      if (allowed.size === 0) {
        return;
      }
      // The hook context exposes channel/session ids but not the space directly;
      // resolve a "spaces/<id>" from whichever id carries it. Not allowlisted → no-op.
      const space = extractSpaceId(ctx.channelId) ?? extractSpaceId(ctx.sessionKey);
      if (!space || !allowed.has(space)) {
        return;
      }
      const auth = buildMessagesAuth(cfg);
      if ("error" in auth) {
        return;
      }
      const count = clamp(cfg.autoContext.messageCount ?? AUTO_CONTEXT_DEFAULT_COUNT, 1, AUTO_CONTEXT_MAX_COUNT);
      try {
        const { messages } = await listSpaceMessages({
          space,
          auth,
          pageSize: count,
          orderBy: "DESC",
        });
        if (messages.length === 0) {
          return;
        }
        const chronological = [...messages].reverse();
        return {
          prependContext: `Recent Google Chat history for ${space} (latest ${chronological.length} messages):\n${renderMessages(chronological)}`,
        };
      } catch {
        // Reading history must never block a reply; skip injection on failure.
        return;
      }
    });
  },
});
