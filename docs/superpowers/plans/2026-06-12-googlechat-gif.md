# googlechat-gif Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `googlechat-gif` plugin exposing one `send_gif(query, space?)` tool so the agent Oppy can find a GIF on Giphy and post it (as its own message) into an allowlisted Google Chat space.

**Architecture:** A standalone plugin in the `openclaw-plugins` monorepo, modeled on `plugins/googlechat-mention`. `send_gif` is one-shot: search Giphy → download the GIF bytes → upload + send to the space using the existing `chat.bot` service account. Pure logic (rendition pick, Giphy parsing, request bodies) lives in small testable functions; the tool entry wires them together with the same ambient-space resolution and deny-by-default space allowlist as the mention plugin.

**Tech Stack:** TypeScript ESM, `typebox` (tool schema), `google-auth-library` (chat.bot auth), `tsup` (build), `vitest` (unit tests, plugin-local), Node 22 `fetch`.

---

## File Structure

All paths are under `~/Documents/workspaces/personal/openclaw-plugins` unless noted.

- Create `plugins/googlechat-gif/package.json` — package metadata, deps, build/test/typecheck scripts.
- Create `plugins/googlechat-gif/tsconfig.json` — extends repo base.
- Create `plugins/googlechat-gif/openclaw.plugin.json` — manifest (`send_gif` tool, configSchema).
- Create `plugins/googlechat-gif/README.md` — short usage/config doc.
- Create `plugins/googlechat-gif/src/giphy-api.ts` — Giphy search + GIF download + rendition pick (pure-ish, fetch injectable).
- Create `plugins/googlechat-gif/src/giphy-api.test.ts` — unit tests for the above.
- Create `plugins/googlechat-gif/src/chat-send.ts` — chat.bot auth, multipart upload, message send; pure body builders.
- Create `plugins/googlechat-gif/src/chat-send.test.ts` — unit tests for body builders + error formatting.
- Create `plugins/googlechat-gif/src/space-scope.ts` — ambient space resolution + deny-by-default allowlist (ported from mention).
- Create `plugins/googlechat-gif/src/space-scope.test.ts` — unit tests for allowlist/space logic.
- Create `plugins/googlechat-gif/src/index.ts` — `definePluginEntry`, registers `send_gif`, wires everything.

Deployment edits in the **openclaw** repo (`~/Documents/workspaces/personal/openclaw`):
- Modify `ops/openclaw-packages.txt` — add the plugin line.
- Modify `ops/.env` — add `GIPHY_API_KEY` (not committed; Fly secret source).
- Modify `ops/fly.toml` — bump `OPENCLAW_PLUGINS_REF`.
- Modify `ops/agents/work-orchestrator/SOUL.md` — proactive-GIF behavior rule.

---

## Task 1: Scaffold the plugin package

**Files:**
- Create: `plugins/googlechat-gif/package.json`
- Create: `plugins/googlechat-gif/tsconfig.json`
- Create: `plugins/googlechat-gif/openclaw.plugin.json`
- Create: `plugins/googlechat-gif/README.md`
- Create: `plugins/googlechat-gif/src/index.ts` (stub for now)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@lehoangnnx/openclaw-googlechat-gif",
  "version": "0.1.0",
  "description": "OpenClaw tool plugin that lets an agent search Giphy and post an animated GIF into an allowlisted Google Chat space (reuses the googlechat service-account auth, deny-by-default allowlist).",
  "keywords": ["openclaw", "openclaw-plugin", "google-chat", "googlechat", "chatops", "ai-agent", "agent-tool", "gif", "giphy"],
  "license": "MIT",
  "author": "Nguyen Le Hoang",
  "repository": {
    "type": "git",
    "url": "https://github.com/lehoangnnx/openclaw-plugins",
    "directory": "plugins/googlechat-gif"
  },
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist", "openclaw.plugin.json", "README.md"],
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "compat": { "pluginApi": ">=2026.6.1", "minGatewayVersion": "2026.6.1" },
    "build": { "openclawVersion": "2026.6.1", "pluginSdkVersion": "2026.6.1" }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean --out-dir dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "google-auth-library": "^10.6.2",
    "typebox": "1.1.39"
  },
  "peerDependencies": { "openclaw": ">=2026.6.1" },
  "peerDependenciesMeta": { "openclaw": { "optional": true } },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "openclaw": "2026.6.1",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `openclaw.plugin.json`**

```json
{
  "id": "googlechat-gif",
  "name": "Google Chat GIF",
  "description": "Search Giphy and post an animated GIF into an allowlisted Google Chat space.",
  "contracts": { "tools": ["send_gif"] },
  "toolMetadata": { "send_gif": { "optional": true } },
  "activation": { "onStartup": true },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "giphyApiKey": {
        "type": "string",
        "description": "Giphy API key. Falls back to env GIPHY_API_KEY. A Giphy beta key is sufficient for a personal bot."
      },
      "rating": {
        "type": "string",
        "enum": ["g", "pg", "pg-13", "r"],
        "description": "Giphy content rating filter. Defaults to 'g' (safe for a work space)."
      },
      "serviceAccountFile": {
        "type": "string",
        "description": "Path to the Google service account JSON key (chat.bot scope). Falls back to env GOOGLE_CHAT_SERVICE_ACCOUNT_FILE (path) or inline GOOGLE_CHAT_SERVICE_ACCOUNT (JSON) — the same credentials the googlechat channel uses."
      },
      "allowedSpaces": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Explicit allowlist of spaces the plugin may post GIFs to (e.g. 'spaces/AAQAxxxx'). When SET it wins (empty array = deny all). When UNSET it is INHERITED from the googlechat channel's enabled groups while groupPolicy is 'allowlist'."
      }
    }
  }
}
```

- [ ] **Step 4: Create `README.md`**

```markdown
# Google Chat GIF (`googlechat-gif`)

Adds one agent tool, `send_gif`, that searches Giphy and posts an animated GIF
into an **allowlisted** Google Chat space. The GIF is sent as the Chat app's own
message via the `chat.bot` service account — the same credentials the `googlechat`
channel already uses.

## Config

`plugins.entries.googlechat-gif.config`:

- `giphyApiKey` — Giphy API key (or env `GIPHY_API_KEY`). A beta key is enough.
- `rating` — `g` | `pg` | `pg-13` | `r` (default `g`).
- `serviceAccountFile` — chat.bot service account JSON (or env
  `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` / inline `GOOGLE_CHAT_SERVICE_ACCOUNT`).
- `allowedSpaces` — explicit space allowlist; unset inherits the googlechat
  channel allowlist (deny-by-default).

## Tool

`send_gif(query, space?)` — search Giphy for `query` and post the chosen GIF to
`space` (defaults to the current Google Chat space). One call sends one GIF.
```

- [ ] **Step 5: Create stub `src/index.ts`**

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "googlechat-gif";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat GIF",
  description: "Search Giphy and post an animated GIF into an allowlisted Google Chat space.",
  register() {
    // Tool registration added in Task 5.
  },
});
```

- [ ] **Step 6: Install deps and verify it builds**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins && npm install && npm run build --workspace plugins/googlechat-gif
```
Expected: install succeeds; build emits `plugins/googlechat-gif/dist/index.js` with no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins
git add plugins/googlechat-gif/package.json plugins/googlechat-gif/tsconfig.json plugins/googlechat-gif/openclaw.plugin.json plugins/googlechat-gif/README.md plugins/googlechat-gif/src/index.ts package-lock.json
git commit -m "feat(googlechat-gif): scaffold plugin package"
```

---

## Task 2: Giphy search + download (`giphy-api.ts`)

**Files:**
- Create: `plugins/googlechat-gif/src/giphy-api.ts`
- Test: `plugins/googlechat-gif/src/giphy-api.test.ts`

- [ ] **Step 1: Write the failing tests**

`plugins/googlechat-gif/src/giphy-api.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { chooseIndex, pickRendition, searchGif, type GiphyImages } from "./giphy-api.js";

const images = (over: Partial<GiphyImages> = {}): GiphyImages => ({
  downsized_medium: { url: "https://giphy/medium.gif", size: "1000" },
  fixed_height: { url: "https://giphy/fixed.gif", size: "500" },
  original: { url: "https://giphy/original.gif", size: "9000" },
  ...over,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("pickRendition", () => {
  it("prefers downsized_medium when under the cap", () => {
    expect(pickRendition(images(), 1_000_000)).toBe("https://giphy/medium.gif");
  });
  it("falls back to the next rendition over the cap", () => {
    expect(pickRendition(images(), 800)).toBe("https://giphy/fixed.gif");
  });
  it("returns undefined when every rendition is too big", () => {
    expect(pickRendition(images(), 100)).toBeUndefined();
  });
  it("returns undefined for missing images", () => {
    expect(pickRendition(undefined, 1_000_000)).toBeUndefined();
  });
});

describe("chooseIndex", () => {
  it("wraps the selector modulo count", () => {
    expect(chooseIndex(3, 7)).toBe(1);
  });
  it("returns -1 for an empty set", () => {
    expect(chooseIndex(0, 5)).toBe(-1);
  });
});

describe("searchGif", () => {
  const base = { apiKey: "k", query: "party", rating: "g" as const, maxBytes: 1_000_000, selector: 0 };

  it("returns a usable gif and passes the rating through", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: URL) => {
      calledUrl = url.toString();
      return jsonResponse({ data: [{ title: "Party", images: images() }] });
    }) as unknown as typeof fetch;
    const out = await searchGif({ ...base, fetchImpl });
    expect(out).toEqual({ kind: "ok", gif: { url: "https://giphy/medium.gif", title: "Party" } });
    expect(calledUrl).toContain("rating=g");
    expect(calledUrl).toContain("q=party");
  });

  it("reports none when no rendition fits", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ title: "x", images: images() }] })) as unknown as typeof fetch;
    const out = await searchGif({ ...base, maxBytes: 1, fetchImpl });
    expect(out).toEqual({ kind: "none" });
  });

  it("reports none for an empty result set", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    expect(await searchGif({ ...base, fetchImpl })).toEqual({ kind: "none" });
  });

  it("surfaces a 429 rate limit as an error", async () => {
    const fetchImpl = (async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    const out = await searchGif({ ...base, fetchImpl });
    expect(out.kind).toBe("error");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run src/giphy-api.test.ts
```
Expected: FAIL — cannot resolve `./giphy-api.js`.

- [ ] **Step 3: Implement `giphy-api.ts`**

```ts
const GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search";

export type GifRating = "g" | "pg" | "pg-13" | "r";

type GiphyRendition = { url?: string; size?: string };
export type GiphyImages = {
  downsized_medium?: GiphyRendition;
  fixed_height?: GiphyRendition;
  original?: GiphyRendition;
};
type GiphyItem = { title?: string; images?: GiphyImages };
type GiphySearchResponse = { data?: GiphyItem[] };

export type GifPick = { url: string; title: string };
export type GifSearchOutcome =
  | { kind: "ok"; gif: GifPick }
  | { kind: "none" }
  | { kind: "error"; message: string };

// Prefer a small-but-decent rendition; fall through to larger ones, skipping any
// whose declared byte size exceeds the cap so we never queue an over-limit upload.
const RENDITION_ORDER = ["downsized_medium", "fixed_height", "original"] as const;

export function pickRendition(images: GiphyImages | undefined, maxBytes: number): string | undefined {
  if (!images) {
    return undefined;
  }
  for (const key of RENDITION_ORDER) {
    const rendition = images[key];
    const url = rendition?.url?.trim();
    if (!url) {
      continue;
    }
    const size = rendition?.size ? Number(rendition.size) : undefined;
    if (size !== undefined && Number.isFinite(size) && size > maxBytes) {
      continue;
    }
    return url;
  }
  return undefined;
}

// Deterministic selection so callers inject their own randomness (keeps tests
// stable and avoids Date/Math.random inside the pure search path).
export function chooseIndex(count: number, selector: number): number {
  if (count <= 0) {
    return -1;
  }
  return Math.abs(Math.trunc(selector)) % count;
}

export async function searchGif(params: {
  apiKey: string;
  query: string;
  rating: GifRating;
  maxBytes: number;
  selector: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<GifSearchOutcome> {
  const limit = params.limit ?? 8;
  const doFetch = params.fetchImpl ?? fetch;
  const url = new URL(GIPHY_SEARCH_URL);
  url.searchParams.set("api_key", params.apiKey);
  url.searchParams.set("q", params.query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("rating", params.rating);

  let res: Response;
  try {
    res = await doFetch(url, { method: "GET" });
  } catch (err) {
    return { kind: "error", message: `Giphy request failed: ${(err as Error).message}` };
  }
  if (res.status === 429) {
    return { kind: "error", message: "Giphy rate limit (429). Try again later." };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { kind: "error", message: `Giphy error HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = (await res.json()) as GiphySearchResponse;
  const usable = (data.data ?? [])
    .map((item) => ({ url: pickRendition(item.images, params.maxBytes), title: item.title?.trim() || params.query }))
    .filter((item): item is GifPick => Boolean(item.url));
  if (usable.length === 0) {
    return { kind: "none" };
  }
  const idx = chooseIndex(usable.length, params.selector);
  return { kind: "ok", gif: usable[idx] };
}

export type GifDownload =
  | { kind: "ok"; bytes: Buffer; contentType: string }
  | { kind: "error"; message: string };

export async function downloadGif(url: string, maxBytes: number, fetchImpl?: typeof fetch): Promise<GifDownload> {
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { method: "GET" });
  } catch (err) {
    return { kind: "error", message: `GIF download failed: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { kind: "error", message: `GIF download HTTP ${res.status}` };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return { kind: "error", message: `GIF exceeds size cap (${bytes.byteLength} > ${maxBytes}).` };
  }
  return { kind: "ok", bytes, contentType: res.headers.get("content-type") ?? "image/gif" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run src/giphy-api.test.ts
```
Expected: PASS (10 assertions across the suites).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins
git add plugins/googlechat-gif/src/giphy-api.ts plugins/googlechat-gif/src/giphy-api.test.ts
git commit -m "feat(googlechat-gif): Giphy search, rendition pick, and download"
```

---

## Task 3: Google Chat upload + send (`chat-send.ts`)

**Files:**
- Create: `plugins/googlechat-gif/src/chat-send.ts`
- Test: `plugins/googlechat-gif/src/chat-send.test.ts`

This ports the `chat.bot` auth pattern from `googlechat-mention/src/chat-api.ts` and the multipart upload + message body shapes from the bundled channel's `extensions/googlechat/src/api.ts` (`uploadGoogleChatAttachment`, `sendGoogleChatMessage`). The request-body construction is split into pure builders so they can be tested without network or auth.

- [ ] **Step 1: Write the failing tests**

`plugins/googlechat-gif/src/chat-send.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildMultipart, buildSendBody, formatChatApiError, normalizeSpace } from "./chat-send.js";

describe("normalizeSpace", () => {
  it("adds the spaces/ prefix when missing", () => {
    expect(normalizeSpace("AAQA1")).toBe("spaces/AAQA1");
  });
  it("leaves an already-qualified id untouched", () => {
    expect(normalizeSpace("spaces/AAQA1")).toBe("spaces/AAQA1");
  });
});

describe("buildMultipart", () => {
  it("wraps metadata and bytes with the boundary", () => {
    const { body, contentType } = buildMultipart("party.gif", Buffer.from("GIF89a"), "image/gif", "B1");
    const text = body.toString("utf8");
    expect(contentType).toBe("multipart/related; boundary=B1");
    expect(text).toContain('{"filename":"party.gif"}');
    expect(text).toContain("Content-Type: image/gif");
    expect(text).toContain("--B1--");
  });
});

describe("buildSendBody", () => {
  it("references the upload token as an attachment", () => {
    expect(buildSendBody("tok-123", "party.gif")).toEqual({
      attachment: [{ attachmentDataRef: { attachmentUploadToken: "tok-123" }, contentName: "party.gif" }],
    });
  });
});

describe("formatChatApiError", () => {
  it("explains a 403 as the app not being in the space", () => {
    expect(formatChatApiError(403, "PERMISSION_DENIED")).toContain("not a member of the space");
  });
  it("passes other statuses through", () => {
    expect(formatChatApiError(500, "boom")).toContain("HTTP 500");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run src/chat-send.test.ts
```
Expected: FAIL — cannot resolve `./chat-send.js`.

- [ ] **Step 3: Implement `chat-send.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run src/chat-send.test.ts
```
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins
git add plugins/googlechat-gif/src/chat-send.ts plugins/googlechat-gif/src/chat-send.test.ts
git commit -m "feat(googlechat-gif): chat.bot upload + send with pure body builders"
```

---

## Task 4: Space resolution + deny-by-default allowlist (`space-scope.ts`)

**Files:**
- Create: `plugins/googlechat-gif/src/space-scope.ts`
- Test: `plugins/googlechat-gif/src/space-scope.test.ts`

Ported from `googlechat-mention/src/index.ts` (`resolveAmbientSpace`, `inheritedAllowedSpaces`, `allowedSpaceSet`, `checkSpace`) so the GIF plugin admits exactly the same spaces as the mention plugin and the channel.

- [ ] **Step 1: Write the failing tests**

`plugins/googlechat-gif/src/space-scope.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkSpace, inheritedAllowedSpaces, resolveAmbientSpace } from "./space-scope.js";

describe("resolveAmbientSpace", () => {
  it("extracts the space id from the delivery target", () => {
    const space = resolveAmbientSpace({ messageChannel: "googlechat", deliveryContext: { channel: "googlechat", to: "googlechat:spaces/AAQA1" } });
    expect(space).toBe("spaces/AAQA1");
  });
  it("returns undefined for a non-googlechat channel", () => {
    expect(resolveAmbientSpace({ messageChannel: "discord", deliveryContext: { channel: "discord", to: "x" } })).toBeUndefined();
  });
});

describe("inheritedAllowedSpaces", () => {
  it("returns enabled allowlist spaces when groupPolicy is allowlist", () => {
    const cfg = { channels: { googlechat: { groupPolicy: "allowlist", groups: { "spaces/A": { enabled: true }, "spaces/B": { enabled: false } } } } };
    expect(inheritedAllowedSpaces(cfg)).toEqual(["spaces/A"]);
  });
  it("returns nothing when groupPolicy is not allowlist", () => {
    const cfg = { channels: { googlechat: { groupPolicy: "open", groups: { "spaces/A": { enabled: true } } } } };
    expect(inheritedAllowedSpaces(cfg)).toEqual([]);
  });
});

describe("checkSpace", () => {
  const ctx = { deliveryContext: { channel: "googlechat", to: "googlechat:spaces/A" } };
  it("accepts an allowlisted ambient space", () => {
    expect(checkSpace(undefined, ctx, new Set(["spaces/A"]))).toEqual({ space: "spaces/A" });
  });
  it("rejects a non-allowlisted space", () => {
    const res = checkSpace("spaces/Z", ctx, new Set(["spaces/A"]));
    expect("error" in res).toBe(true);
  });
  it("errors with no space available", () => {
    const res = checkSpace(undefined, {}, new Set(["spaces/A"]));
    expect("error" in res).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run src/space-scope.test.ts
```
Expected: FAIL — cannot resolve `./space-scope.js`.

- [ ] **Step 3: Implement `space-scope.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run src/space-scope.test.ts
```
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins
git add plugins/googlechat-gif/src/space-scope.ts plugins/googlechat-gif/src/space-scope.test.ts
git commit -m "feat(googlechat-gif): ambient space resolution + deny-by-default allowlist"
```

---

## Task 5: Wire the `send_gif` tool (`index.ts`)

**Files:**
- Modify: `plugins/googlechat-gif/src/index.ts` (replace the Task 1 stub)

- [ ] **Step 1: Replace `src/index.ts` with the full tool**

```ts
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

// Module-scoped rotation counter for GIF variety (see `selector` above).
let callCounter = 0;
```

- [ ] **Step 2: Typecheck and build**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npm run typecheck && npm run build
```
Expected: typecheck passes; `dist/index.js` rebuilt with no errors.

- [ ] **Step 3: Run the full plugin test suite**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif && npx vitest run
```
Expected: PASS — all three test files green.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins
git add plugins/googlechat-gif/src/index.ts
git commit -m "feat(googlechat-gif): wire send_gif tool (search → download → upload → send)"
```

> Note on SDK subpaths: this plan assumes `openclaw/plugin-sdk/plugin-entry` exports `definePluginEntry`, `AnyAgentTool`, `OpenClawPluginApi`, and that `openclaw/plugin-sdk/plugin-config-runtime` exports `resolveLivePluginConfigObject` and `openclaw/plugin-sdk/config-contracts` exports `OpenClawConfig` — all confirmed against `plugins/googlechat-mention/src/index.ts`. If a subpath fails to resolve at typecheck (Step 2), align the import with whatever `googlechat-mention` currently uses before proceeding.

---

## Task 6: Verify the manifest loads (local sanity)

**Files:** none (verification only)

- [ ] **Step 1: Confirm the built artifact and manifest agree**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins/plugins/googlechat-gif
node -e "const m=require('./openclaw.plugin.json'); if(!m.contracts.tools.includes('send_gif')) throw new Error('manifest missing send_gif'); console.log('manifest ok:', m.id)"
test -f dist/index.js && echo "dist ok"
```
Expected: prints `manifest ok: googlechat-gif` and `dist ok`.

- [ ] **Step 2: Repo-wide build + typecheck (matches CI)**

Run:
```bash
cd ~/Documents/workspaces/personal/openclaw-plugins && npm run build && npm run typecheck
```
Expected: all workspaces build and typecheck clean (this is exactly what CI runs).

- [ ] **Step 3: Commit any lockfile/build changes**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins
git add -A
git commit -m "chore(googlechat-gif): lockfile + build artifacts" || echo "nothing to commit"
```

---

## Task 7: Deployment wiring (openclaw repo `ops/`)

**Files (in `~/Documents/workspaces/personal/openclaw`):**
- Modify: `ops/openclaw-packages.txt`
- Modify: `ops/.env`
- Modify: `ops/fly.toml`

> These changes live in the openclaw repo's `ops/` tree (currently untracked). They are applied locally and shipped via `fly deploy`; do not commit secrets.

- [ ] **Step 1: Register the plugin for boot install**

In `ops/openclaw-packages.txt`, add this line alongside the other `plugin plugins/...` entries:
```
plugin plugins/googlechat-gif
```

- [ ] **Step 2: Add the Giphy key to the Fly secret source**

In `ops/.env`, add (use the real beta key):
```
GIPHY_API_KEY=<your-giphy-beta-key>
```

- [ ] **Step 3: Push the plugin repo and pin the new ref**

```bash
cd ~/Documents/workspaces/personal/openclaw-plugins && git push origin main && git rev-parse HEAD
```
Then in `ops/fly.toml`, set `OPENCLAW_PLUGINS_REF` under `[build.args]` to the printed commit SHA.

- [ ] **Step 4: Deploy**

Run (from the openclaw repo root):
```bash
cd ~/Documents/workspaces/personal/openclaw && fly deploy
```
Expected: build clones the pinned ref, installs `googlechat-gif`, gateway boots healthy (`/healthz` 200).

- [ ] **Step 5: Confirm the tool is live**

After deploy, verify the gateway loaded the plugin (logs should show the plugin install line from `start-openclaw.sh`). Note the exact verification command set used, for the PR/record.

---

## Task 8: Teach Oppy to use GIFs (SOUL.md)

**Files (in `~/Documents/workspaces/personal/openclaw`):**
- Modify: `ops/agents/work-orchestrator/SOUL.md`

- [ ] **Step 1: Add a restrained proactive-GIF rule**

Near the existing emoji guidance (around the "Emoji cảm xúc cao trào" line), add a short rule. Suggested text (Vietnamese, matching SOUL.md voice):
```markdown
- GIF: khi hợp khoảnh khắc (chúc mừng, ăn mừng, ghẹo vui, phản ứng cảm xúc) có thể
  dùng tool `send_gif` để gửi một GIF — TIẾT CHẾ như emoji "mức vừa", không rải mọi
  tin. Không tìm được GIF hợp thì thôi, cứ trả lời bằng text/emoji bình thường.
```

- [ ] **Step 2: Apply to the live agent**

Apply the SOUL.md change to the running `work-orchestrator` agent the same way other agent-instruction edits are made on the Fly gateway (edit the live agent file; do not commit inside the runtime-managed git).

- [ ] **Step 3: Real send check (Crabbox / live)**

From the Google Chat space, prompt Oppy in a way that should trigger a GIF (e.g. a celebration moment) and confirm an animated GIF actually arrives as a message from Oppy. Record the observed result.

---

## Self-Review notes

- **Spec coverage:** provider=Giphy (Task 1 manifest + Task 2), one-shot send (Task 3+5), separate message from Oppy (Task 3 `uploadAndSendGif`), no caption (schema in Task 5 has only `query`/`space`), deny-by-default allowlist (Task 4), behavior change (Task 8), deployment (Task 7), tests (Tasks 2–4). All spec sections map to a task.
- **Type consistency:** `searchGif`/`downloadGif`/`GifRating` (Task 2) consumed in Task 5; `uploadAndSendGif`/`normalizeSpace` (Task 3) consumed in Tasks 4/5; `checkSpace`/`allowedSpaceSet`/`resolveMaxBytes`/`ToolContext` (Task 4) consumed in Task 5. Names match across tasks.
- **No live calls in unit tests:** all `fetch` injected; auth never invoked in tests (only pure builders tested in Task 3).
```
