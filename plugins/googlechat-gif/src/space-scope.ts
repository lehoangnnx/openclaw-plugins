import { normalizeSpace } from "./chat-send.js";

const GOOGLECHAT_CHANNEL = "googlechat";

export type ToolContext = {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string };
  requesterSenderId?: string;
};

type GoogleChatChannelConfig = {
  groupPolicy?: "open" | "allowlist" | "disabled";
  groups?: Record<string, { enabled?: boolean } | null | undefined>;
  mediaMaxMb?: number;
};
type StructuralConfig = { channels?: Record<string, unknown> };

function googlechatConfig(config: StructuralConfig | undefined): GoogleChatChannelConfig | undefined {
  return config?.channels?.[GOOGLECHAT_CHANNEL] as GoogleChatChannelConfig | undefined;
}

/** Spaces the googlechat channel already admits (enabled allowlist groups). */
export function inheritedAllowedSpaces(config: StructuralConfig | undefined): string[] {
  const gc = googlechatConfig(config);
  if (!gc || gc.groupPolicy !== "allowlist" || !gc.groups) {
    return [];
  }
  return Object.entries(gc.groups)
    .filter(([key, entry]) => /^spaces\//i.test(key.trim()) && entry?.enabled !== false)
    .map(([key]) => normalizeSpace(key));
}

/** Upload size cap from the googlechat channel config (MB → bytes), default 20MB. */
export function resolveMaxBytes(config: StructuralConfig | undefined): number {
  const mb = googlechatConfig(config)?.mediaMaxMb ?? 20;
  return mb * 1024 * 1024;
}

function extractSpaceId(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/spaces\/[A-Za-z0-9_-]+/);
  return match ? match[0] : undefined;
}

// Resolve the current space from the ambient delivery route so the model can omit
// `space` when already running inside a Google Chat space.
export function resolveAmbientSpace(ctx: ToolContext): string | undefined {
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

// Deny-by-default: explicit `allowedSpaces` wins (empty => deny all); otherwise
// inherit the googlechat channel allowlist (one source of truth).
export function allowedSpaceSet(explicit: string[] | undefined, config: StructuralConfig | undefined): Set<string> {
  const list = explicit ?? inheritedAllowedSpaces(config);
  return new Set(list.map((s) => normalizeSpace(s)));
}

export type SpaceCheck = { space: string } | { error: string };

export function checkSpace(explicit: string | undefined, ctx: ToolContext, allowed: Set<string>): SpaceCheck {
  const space = resolveSpaceArg(explicit, ctx);
  if (!space) {
    return { error: "No Google Chat space id available. Pass `space` (e.g. spaces/AAQAxxxx) or run inside a Google Chat space conversation." };
  }
  if (allowed.size === 0) {
    return {
      error:
        "No spaces are in scope (deny-by-default). Add the space to the googlechat channel allowlist " +
        '(channels.googlechat.groups with groupPolicy: "allowlist"), or set ' +
        "plugins.entries.googlechat-gif.config.allowedSpaces explicitly.",
    };
  }
  if (!allowed.has(space)) {
    return { error: `Refusing to post to ${space}: it is not allowlisted.` };
  }
  return { space };
}
