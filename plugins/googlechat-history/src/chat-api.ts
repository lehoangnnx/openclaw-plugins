import { GoogleAuth } from "google-auth-library";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";

// App-authentication scope to read PUBLIC messages in spaces the app is a
// member of. This is separate from the channel plugin's chat.bot scope.
// Docs: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list
const CHAT_READ_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";

type ServiceAccountSource =
  | { keyFile: string }
  | { credentials: Record<string, unknown> };

// One GoogleAuth client per resolved credential, reused across calls so we do
// not re-read the key file / re-mint a client on every tool invocation.
let cachedAuth: { key: string; auth: GoogleAuth } | null = null;

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

async function getAccessToken(configFile?: string): Promise<string> {
  const source = resolveServiceAccount(configFile);
  const key =
    "keyFile" in source ? `file:${source.keyFile}` : `inline:${JSON.stringify(source.credentials)}`;
  if (!cachedAuth || cachedAuth.key !== key) {
    const auth = new GoogleAuth({
      ...("keyFile" in source ? { keyFile: source.keyFile } : { credentials: source.credentials }),
      scopes: [CHAT_READ_SCOPE],
    });
    cachedAuth = { key, auth };
  }
  const token = await cachedAuth.auth.getAccessToken();
  if (!token) {
    throw new Error("Failed to mint a Google Chat access token from the service account.");
  }
  return token;
}

export type ChatMessage = {
  name?: string;
  text?: string;
  createTime?: string;
  sender?: { name?: string; displayName?: string; type?: string };
};

export type ListSpaceMessagesResult = {
  messages: ChatMessage[];
  nextPageToken?: string;
};

/** Normalize "AAQA..." or "spaces/AAQA..." into a canonical "spaces/<id>". */
export function normalizeSpace(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`;
}

export async function listSpaceMessages(params: {
  space: string;
  pageSize?: number;
  filter?: string;
  pageToken?: string;
  serviceAccountFile?: string;
}): Promise<ListSpaceMessagesResult> {
  const token = await getAccessToken(params.serviceAccountFile);
  const url = new URL(`${CHAT_API_BASE}/${normalizeSpace(params.space)}/messages`);
  if (params.pageSize) {
    url.searchParams.set("pageSize", String(params.pageSize));
  }
  if (params.filter) {
    url.searchParams.set("filter", params.filter);
  }
  if (params.pageToken) {
    url.searchParams.set("pageToken", params.pageToken);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Google Chat spaces.messages.list failed: HTTP ${response.status} ${body.slice(0, 400)}`,
    );
  }
  const data = (await response.json()) as ListSpaceMessagesResult;
  return { messages: data.messages ?? [], nextPageToken: data.nextPageToken };
}

/** Reset cached auth — exported for tests. */
export function __resetAuthCache(): void {
  cachedAuth = null;
}
