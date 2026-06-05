import { Type, type Static } from "typebox";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { listSpaceMessages, normalizeSpace } from "./chat-api.js";

const PLUGIN_ID = "googlechat-history";

const HistorySchema = Type.Object({
  space: Type.String({
    description: "Space id, e.g. 'spaces/AAQAxxxx' or just 'AAQAxxxx'.",
  }),
  pageSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "Max messages to return (default Chat API page size).",
    }),
  ),
  filter: Type.Optional(
    Type.String({
      description:
        'Chat API filter, e.g. createTime > "2026-06-01T00:00:00Z" AND createTime < "2026-06-05T00:00:00Z".',
    }),
  ),
  pageToken: Type.Optional(
    Type.String({ description: "Page token from a previous call to fetch the next page." }),
  ),
});
type HistoryParams = Static<typeof HistorySchema>;

type PluginConfig = { serviceAccountFile?: string };

// Resolve the live plugin config on each call so operators can change the
// service-account path without restarting the gateway.
function resolveServiceAccountFile(api: OpenClawPluginApi): string | undefined {
  const cfg = resolveLivePluginConfigObject(
    api.runtime.config?.current
      ? () => api.runtime.config.current() as OpenClawConfig
      : undefined,
    PLUGIN_ID,
    api.pluginConfig as Record<string, unknown>,
  ) as PluginConfig | undefined;
  return cfg?.serviceAccountFile;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat History",
  description: "Read past messages from a Google Chat space via the Chat API.",
  register(api) {
    api.registerTool(
      (): AnyAgentTool => ({
        name: "googlechat_history",
        label: "Google Chat History",
        description:
          "Fetch recent messages from a Google Chat space — useful to read history the bot " +
          "did not receive directly (e.g. messages without an @mention). " +
          "Input: a space id; optional pageSize, filter, and pageToken for pagination.",
        parameters: HistorySchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as HistoryParams;
          const { messages, nextPageToken } = await listSpaceMessages({
            space: normalizeSpace(params.space),
            pageSize: params.pageSize,
            filter: params.filter,
            pageToken: params.pageToken,
            serviceAccountFile: resolveServiceAccountFile(api),
          });

          const lines = messages.map((message) => {
            const who = message.sender?.displayName || message.sender?.name || "unknown";
            const when = message.createTime ?? "";
            return `[${when}] ${who}: ${message.text ?? "(no text)"}`;
          });
          const text =
            (lines.length > 0 ? lines.join("\n") : "(no messages returned)") +
            (nextPageToken ? `\n\n[nextPageToken: ${nextPageToken}]` : "");

          return {
            content: [{ type: "text", text }],
            details: { count: messages.length, nextPageToken: nextPageToken ?? null },
          };
        },
      }),
      { name: "googlechat_history" },
    );
  },
});
