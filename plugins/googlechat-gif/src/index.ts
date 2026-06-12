import { Type, type Static } from "typebox";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { downloadGif, searchGif, type GifRating } from "./giphy-api.js";
import { uploadAndSendGif } from "./chat-send.js";
import { allowedSpaceSet, checkSpace, resolveMaxBytes, type ToolContext } from "./space-scope.js";

const PLUGIN_ID = "googlechat-gif";

// Module-scoped rotation counter for GIF variety (see `selector` below).
let callCounter = 0;

type PluginConfig = {
  giphyApiKey?: string;
  rating?: GifRating;
  serviceAccountFile?: string;
  allowedSpaces?: string[];
};

// One live config snapshot per call so operators can change auth / key / allowlist
// without a gateway restart.
function resolveLive(api: OpenClawPluginApi): { cfg: PluginConfig; config: OpenClawConfig | undefined } {
  const config = api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
  const cfg = resolveLivePluginConfigObject(
    config ? () => config : undefined,
    PLUGIN_ID,
    api.pluginConfig as Record<string, unknown>,
  ) as PluginConfig | undefined;
  return { cfg: cfg ?? {}, config };
}

function errorResult(text: string, code = "error") {
  return { content: [{ type: "text" as const, text }], details: { error: code } };
}

const SendGifSchema = Type.Object({
  query: Type.String({
    description: "What GIF to find, e.g. 'celebration', 'thumbs up', 'facepalm'. Keep it short and descriptive.",
  }),
  space: Type.Optional(
    Type.String({
      description: "Space id, e.g. 'spaces/AAQAxxxx' or 'AAQAxxxx'. Omit to use the current Google Chat space. Must be allowlisted.",
    }),
  ),
});
type SendGifParams = Static<typeof SendGifSchema>;

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat GIF",
  description: "Search Giphy and post an animated GIF into an allowlisted Google Chat space.",
  register(api) {
    api.registerTool(
      (ctx: ToolContext): AnyAgentTool => ({
        name: "send_gif",
        label: "Send GIF",
        description:
          "Search Giphy for a short query and POST the chosen animated GIF into the current Google Chat space " +
          "as its own message. Use sparingly when a GIF genuinely fits the moment (celebration, congrats, light " +
          "reaction). One call sends one GIF. Omit `space` to use the current space. If no good GIF is found, " +
          "this returns a note and you should just continue with text/emoji.",
        parameters: SendGifSchema,
        execute: async (_toolCallId, rawParams) => {
          const params = rawParams as SendGifParams;
          const query = params.query?.trim();
          if (!query) {
            return errorResult("`query` is required (what GIF to search for).", "bad_request");
          }

          const { cfg, config } = resolveLive(api);
          const apiKey = cfg.giphyApiKey?.trim() || process.env.GIPHY_API_KEY?.trim();
          if (!apiKey) {
            return errorResult(
              "No Giphy API key. Set plugins.entries.googlechat-gif.config.giphyApiKey or env GIPHY_API_KEY.",
              "no_api_key",
            );
          }

          const checked = checkSpace(params.space, ctx, allowedSpaceSet(cfg.allowedSpaces, config));
          if ("error" in checked) {
            return errorResult(checked.error, "space_denied");
          }

          const maxBytes = resolveMaxBytes(config);
          const rating: GifRating = cfg.rating ?? "g";
          // Vary the pick across calls without Date/Math.random in the search path:
          // a cheap per-call counter keeps repeated identical queries from always
          // returning result #0.
          const selector = (callCounter += 1);

          const search = await searchGif({ apiKey, query, rating, maxBytes, selector });
          if (search.kind === "error") {
            return errorResult(search.message, "giphy_error");
          }
          if (search.kind === "none") {
            return errorResult(`No GIF found for "${query}".`, "no_results");
          }

          const download = await downloadGif(search.gif.url, maxBytes);
          if (download.kind === "error") {
            return errorResult(download.message, "download_failed");
          }

          const sent = await uploadAndSendGif({
            space: checked.space,
            filename: `${query.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "gif"}.gif`,
            bytes: download.bytes,
            contentType: download.contentType,
            serviceAccountFile: cfg.serviceAccountFile,
          });
          if (sent.kind === "error") {
            return errorResult(sent.message, "send_failed");
          }

          return {
            content: [{ type: "text", text: `Sent a GIF for "${query}" to ${checked.space}.` }],
            details: { ok: true, space: checked.space, title: search.gif.title },
          };
        },
      }),
      { name: "send_gif" },
    );
  },
});
