import { GoogleAuth, OAuth2Client } from "google-auth-library";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";

// Scopes are per-operation.
// - App auth (service account) reading messages needs the chat.app read scope,
//   which a Workspace admin must authorize. Listing members / reading space
//   metadata use chat.bot — the same scope the channel already uses (no approval).
// - User auth reads messages as a human via OAuth (chat.messages.readonly). It
//   needs NO admin approval (Internal OAuth app + self-consent) but the token can
//   see every space the user belongs to, so the plugin enforces an allowlist.
const SCOPE_MESSAGES_READ_APP = "https://www.googleapis.com/auth/chat.app.messages.readonly";
const SCOPE_BOT = "https://www.googleapis.com/auth/chat.bot";

// How to authenticate message reads. Members/space metadata always use the
// service-account chat.bot path (`serviceAccountFile`) regardless of this.
export type MessagesAuth =
  | { mode: "app"; serviceAccountFile?: string }
  | { mode: "user"; clientId: string; clientSecret: string; refreshToken: string };

type ServiceAccountSource =
  | { keyFile: string }
  | { credentials: Record<string, unknown> };

// One GoogleAuth client per (scope, credential) so we do not re-read the key
// file / re-mint a client on every tool invocation.
const appAuthCache = new Map<string, GoogleAuth>();
// One OAuth2 client per (clientId, refreshToken) for user-auth token refresh.
const userAuthCache = new Map<string, OAuth2Client>();

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
  return "keyFile" in source
    ? `file:${source.keyFile}`
    : `inline:${JSON.stringify(source.credentials)}`;
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

async function getUserAccessToken(auth: Extract<MessagesAuth, { mode: "user" }>): Promise<string> {
  // Cache by clientId + a short refresh-token fingerprint (never the full token).
  const key = `${auth.clientId}|${auth.refreshToken.slice(0, 12)}`;
  let client = userAuthCache.get(key);
  if (!client) {
    client = new OAuth2Client({ clientId: auth.clientId, clientSecret: auth.clientSecret });
    client.setCredentials({ refresh_token: auth.refreshToken });
    userAuthCache.set(key, client);
  }
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error(
      "Failed to refresh a Google Chat user access token. The refresh token may be revoked or " +
        "expired — re-run scripts/get-refresh-token.mjs to obtain a new one.",
    );
  }
  return token;
}

async function getMessagesToken(auth: MessagesAuth): Promise<string> {
  return auth.mode === "user"
    ? getUserAccessToken(auth)
    : getAppAccessToken(SCOPE_MESSAGES_READ_APP, auth.serviceAccountFile);
}

/** Normalize "AAQA..." or "spaces/AAQA..." into a canonical "spaces/<id>". */
export function normalizeSpace(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`;
}

// Turn HTTP failures into actionable guidance. A 403 almost always means the
// caller cannot access the space — for app auth: the bot is not a member or the
// scope is not admin-authorized; for user auth: the user is not a space member.
function formatChatApiError(status: number, body: string, hint: string): string {
  const snippet = body.slice(0, 400);
  if (status === 403 || /PERMISSION_DENIED/i.test(body)) {
    return `Google Chat API 403 (${hint}). ${snippet}`;
  }
  if (status === 404) {
    return `Google Chat API 404: space or resource not found. Raw: ${snippet}`;
  }
  return `Google Chat API error HTTP ${status}: ${snippet}`;
}

async function chatApiGet<T>(params: {
  path: string;
  token: string;
  errorHint: string;
  query?: Record<string, string | undefined>;
}): Promise<T> {
  const url = new URL(`${CHAT_API_BASE}/${params.path}`);
  for (const [name, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(name, value);
    }
  }
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatChatApiError(response.status, body, params.errorHint));
  }
  return (await response.json()) as T;
}

export type ChatSender = {
  name?: string;
  displayName?: string;
  type?: string;
  domainId?: string;
};

export type ChatAttachment = {
  name?: string;
  contentName?: string;
  contentType?: string;
};

export type ChatMessage = {
  /** Resource name, e.g. "spaces/AAQA.../messages/abc.def" — stable message id. */
  name?: string;
  text?: string;
  formattedText?: string;
  argumentText?: string;
  createTime?: string;
  thread?: { name?: string };
  sender?: ChatSender;
  attachment?: ChatAttachment[];
};

export type ListSpaceMessagesResult = {
  messages: ChatMessage[];
  nextPageToken?: string;
};

export type ChatMember = {
  name?: string;
  state?: string;
  role?: string;
  member?: { name?: string; displayName?: string; type?: string };
};

export type ListSpaceMembersResult = {
  memberships: ChatMember[];
  nextPageToken?: string;
};

export type ChatSpace = {
  name?: string;
  displayName?: string;
  type?: string;
  spaceType?: string;
  spaceThreadingState?: string;
  spaceHistoryState?: string;
  externalUserAllowed?: boolean;
  membershipCount?: { joinedDirectHumanUserCount?: number; joinedGroupCount?: number };
};

export type MessageOrder = "ASC" | "DESC";

const USER_AUTH_HINT = "the user is not a member of this space, or the OAuth token lacks chat.messages.readonly";
const APP_AUTH_HINT =
  "the Chat app is not a member of the space, or a Workspace admin has not authorized the scope (see https://support.google.com/a?p=chat-app-auth)";
const BOT_AUTH_HINT = "the Chat app is not a member of the space";

export async function listSpaceMessages(params: {
  space: string;
  auth: MessagesAuth;
  pageSize?: number;
  filter?: string;
  orderBy?: MessageOrder;
  pageToken?: string;
}): Promise<ListSpaceMessagesResult> {
  const token = await getMessagesToken(params.auth);
  const data = await chatApiGet<ListSpaceMessagesResult>({
    path: `${normalizeSpace(params.space)}/messages`,
    token,
    errorHint: params.auth.mode === "user" ? USER_AUTH_HINT : APP_AUTH_HINT,
    query: {
      pageSize: params.pageSize ? String(params.pageSize) : undefined,
      filter: params.filter,
      // Chat API expects "createTime ASC" | "createTime DESC".
      orderBy: params.orderBy ? `createTime ${params.orderBy}` : undefined,
      pageToken: params.pageToken,
    },
  });
  return { messages: data.messages ?? [], nextPageToken: data.nextPageToken };
}

export async function listSpaceMembers(params: {
  space: string;
  pageSize?: number;
  pageToken?: string;
  serviceAccountFile?: string;
}): Promise<ListSpaceMembersResult> {
  const token = await getAppAccessToken(SCOPE_BOT, params.serviceAccountFile);
  const data = await chatApiGet<ListSpaceMembersResult>({
    path: `${normalizeSpace(params.space)}/members`,
    token,
    errorHint: BOT_AUTH_HINT,
    query: {
      pageSize: params.pageSize ? String(params.pageSize) : undefined,
      pageToken: params.pageToken,
    },
  });
  return { memberships: data.memberships ?? [], nextPageToken: data.nextPageToken };
}

export async function getSpace(params: {
  space: string;
  serviceAccountFile?: string;
}): Promise<ChatSpace> {
  const token = await getAppAccessToken(SCOPE_BOT, params.serviceAccountFile);
  return await chatApiGet<ChatSpace>({
    path: normalizeSpace(params.space),
    token,
    errorHint: BOT_AUTH_HINT,
  });
}

/** Reset cached auth clients — exported for tests. */
export function __resetAuthCache(): void {
  appAuthCache.clear();
  userAuthCache.clear();
}
