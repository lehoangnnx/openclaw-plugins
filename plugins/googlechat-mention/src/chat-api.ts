import { GoogleAuth } from "google-auth-library";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";

// chat.bot is the same scope the googlechat channel and googlechat-history use —
// no Workspace admin approval needed, and it is sufficient for spaces.members.list
// (the only Chat API call this plugin makes: resolving display names to user ids).
const SCOPE_BOT = "https://www.googleapis.com/auth/chat.bot";

type ServiceAccountSource = { keyFile: string } | { credentials: Record<string, unknown> };

// One GoogleAuth client per (scope, credential) so we do not re-read the key file
// or re-mint a client on every tool call.
const appAuthCache = new Map<string, GoogleAuth>();

// Reuse the exact credential resolution the googlechat-history plugin and the
// googlechat channel use, so a single service account (env or file) drives reads
// and mention sends with no second secret to configure.
function resolveServiceAccount(configFile?: string): ServiceAccountSource {
  const inline = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT?.trim();
  if (inline) {
    return { credentials: JSON.parse(inline) as Record<string, unknown> };
  }
  const file = configFile?.trim() || process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE?.trim();
  if (!file) {
    throw new Error(
      "No Google Chat service account configured. Set plugin config `serviceAccountFile`, " +
        "or env GOOGLE_CHAT_SERVICE_ACCOUNT_FILE (path) / GOOGLE_CHAT_SERVICE_ACCOUNT (inline JSON).",
    );
  }
  return { keyFile: file };
}

function credentialKey(source: ServiceAccountSource): string {
  return "keyFile" in source ? `file:${source.keyFile}` : `inline:${JSON.stringify(source.credentials)}`;
}

async function getAppAccessToken(scope: string, configFile?: string): Promise<string> {
  const source = resolveServiceAccount(configFile);
  const key = `${scope}|${credentialKey(source)}`;
  let auth = appAuthCache.get(key);
  if (!auth) {
    auth = new GoogleAuth({
      ...("keyFile" in source ? { keyFile: source.keyFile } : { credentials: source.credentials }),
      scopes: [scope],
    });
    appAuthCache.set(key, auth);
  }
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error("Failed to mint a Google Chat access token from the service account.");
  }
  return token;
}

/** Normalize "AAQA..." or "spaces/AAQA..." into a canonical "spaces/<id>". */
export function normalizeSpace(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`;
}

// A 403 on these calls almost always means the Chat app is not a member of the
// space; surface that plainly instead of a raw HTTP body.
const BOT_AUTH_HINT = "the Chat app is not a member of the space";

function formatChatApiError(status: number, body: string): string {
  const snippet = body.slice(0, 400);
  if (status === 403 || /PERMISSION_DENIED/i.test(body)) {
    return `Google Chat API 403 (${BOT_AUTH_HINT}). ${snippet}`;
  }
  if (status === 404) {
    return `Google Chat API 404: space or resource not found. Raw: ${snippet}`;
  }
  return `Google Chat API error HTTP ${status}: ${snippet}`;
}

export type ChatMember = {
  name?: string;
  role?: string;
  member?: { name?: string; displayName?: string; type?: string };
};

export type ListSpaceMembersResult = {
  memberships: ChatMember[];
  nextPageToken?: string;
};

// Paginate through every membership so name resolution can see all human members,
// not just the first page. chat.bot only returns members the app can see.
export async function listAllSpaceMembers(params: {
  space: string;
  serviceAccountFile?: string;
}): Promise<ChatMember[]> {
  const token = await getAppAccessToken(SCOPE_BOT, params.serviceAccountFile);
  const space = normalizeSpace(params.space);
  const all: ChatMember[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${CHAT_API_BASE}/${space}/members`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(formatChatApiError(response.status, body));
    }
    const data = (await response.json()) as ListSpaceMembersResult;
    all.push(...(data.memberships ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

/** Reset cached auth clients — exported for tests. */
export function __resetAuthCache(): void {
  appAuthCache.clear();
}
