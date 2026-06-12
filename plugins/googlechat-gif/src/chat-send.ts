import { randomUUID } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";
// chat.bot is the same scope the googlechat channel and googlechat-mention use —
// no Workspace admin approval needed, and sufficient to upload + post messages.
const SCOPE_BOT = "https://www.googleapis.com/auth/chat.bot";

type ServiceAccountSource = { keyFile: string } | { credentials: Record<string, unknown> };

// One GoogleAuth client per credential so we do not re-read the key file or
// re-mint a client on every tool call.
const appAuthCache = new Map<string, GoogleAuth>();

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

async function getAppAccessToken(configFile?: string): Promise<string> {
  const source = resolveServiceAccount(configFile);
  const key = credentialKey(source);
  let auth = appAuthCache.get(key);
  if (!auth) {
    auth = new GoogleAuth({
      ...("keyFile" in source ? { keyFile: source.keyFile } : { credentials: source.credentials }),
      scopes: [SCOPE_BOT],
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

// A 403 here almost always means the Chat app is not a member of the space.
export function formatChatApiError(status: number, body: string): string {
  const snippet = body.slice(0, 300);
  if (status === 403 || /PERMISSION_DENIED/i.test(body)) {
    return `Google Chat API 403 (the Chat app is not a member of the space). ${snippet}`;
  }
  if (status === 404) {
    return `Google Chat API 404: space or resource not found. ${snippet}`;
  }
  return `Google Chat API error HTTP ${status}: ${snippet}`;
}

// Mirror the bundled channel's multipart/related upload body exactly so Google
// Chat accepts the attachment (metadata part + raw media part).
export function buildMultipart(
  filename: string,
  bytes: Buffer,
  contentType: string,
  boundary: string,
): { body: Buffer; contentType: string } {
  const metadata = JSON.stringify({ filename });
  const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const mediaHeader = `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header, "utf8"),
    Buffer.from(mediaHeader, "utf8"),
    bytes,
    Buffer.from(footer, "utf8"),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// Message body shape from extensions/googlechat/src/api.ts sendGoogleChatMessage.
export function buildSendBody(attachmentUploadToken: string, contentName: string): Record<string, unknown> {
  return {
    attachment: [{ attachmentDataRef: { attachmentUploadToken }, contentName }],
  };
}

export type SendGifResult = { kind: "ok"; messageName?: string } | { kind: "error"; message: string };

// Upload the GIF bytes then post a message referencing the upload token. Returns
// a typed result so the tool can fall back gracefully instead of throwing.
export async function uploadAndSendGif(params: {
  space: string;
  filename: string;
  bytes: Buffer;
  contentType: string;
  serviceAccountFile?: string;
  fetchImpl?: typeof fetch;
}): Promise<SendGifResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const space = normalizeSpace(params.space);
  let token: string;
  try {
    token = await getAppAccessToken(params.serviceAccountFile);
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }

  const boundary = `openclaw-${randomUUID()}`;
  const multipart = buildMultipart(params.filename, params.bytes, params.contentType, boundary);
  const uploadUrl = `${CHAT_UPLOAD_BASE}/${space}/attachments:upload?uploadType=multipart`;
  const uploadRes = await doFetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": multipart.contentType },
    body: multipart.body,
  });
  if (!uploadRes.ok) {
    return { kind: "error", message: formatChatApiError(uploadRes.status, await uploadRes.text().catch(() => "")) };
  }
  const uploadData = (await uploadRes.json()) as { attachmentDataRef?: { attachmentUploadToken?: string } };
  const uploadToken = uploadData.attachmentDataRef?.attachmentUploadToken;
  if (!uploadToken) {
    return { kind: "error", message: "Google Chat upload returned no attachmentUploadToken." };
  }

  const sendRes = await doFetch(`${CHAT_API_BASE}/${space}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildSendBody(uploadToken, params.filename)),
  });
  if (!sendRes.ok) {
    return { kind: "error", message: formatChatApiError(sendRes.status, await sendRes.text().catch(() => "")) };
  }
  const sent = (await sendRes.json()) as { name?: string };
  return { kind: "ok", messageName: sent.name };
}

/** Reset cached auth clients — exported for tests. */
export function __resetAuthCache(): void {
  appAuthCache.clear();
}
