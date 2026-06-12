import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAuthCache,
  buildMultipart,
  buildSendBody,
  formatChatApiError,
  normalizeSpace,
  uploadAndSendGif,
} from "./chat-send.js";

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

describe("uploadAndSendGif", () => {
  afterEach(() => {
    __resetAuthCache();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const baseParams = {
    space: "spaces/A",
    filename: "x.gif",
    bytes: Buffer.from("GIF89a"),
    contentType: "image/gif",
    getToken: async () => "fake-token",
  };

  it("happy path: uploads then sends and returns the message name", async () => {
    const responses = [
      jsonResponse({ attachmentDataRef: { attachmentUploadToken: "tok-9" } }),
      jsonResponse({ name: "spaces/A/messages/m1" }),
    ];
    const fetchImpl = async () => responses.shift()!;
    const result = await uploadAndSendGif({ ...baseParams, fetchImpl });
    expect(result).toEqual({ kind: "ok", messageName: "spaces/A/messages/m1" });
  });

  it("upload non-ok: returns an error mentioning 'not a member of the space'", async () => {
    const fetchImpl = async () => jsonResponse({}, 403);
    const result = await uploadAndSendGif({ ...baseParams, fetchImpl });
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain("not a member of the space");
  });

  it("missing token: returns an error mentioning attachmentUploadToken", async () => {
    // Upload returns 200 but no attachmentDataRef
    const fetchImpl = async () => jsonResponse({});
    const result = await uploadAndSendGif({ ...baseParams, fetchImpl });
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; message: string }).message).toContain("attachmentUploadToken");
  });

  it("upload succeeds but send POST returns non-ok: returns an error", async () => {
    const responses = [
      jsonResponse({ attachmentDataRef: { attachmentUploadToken: "tok-send-fail" } }),
      jsonResponse({ error: "Internal Server Error" }, 500),
    ];
    const fetchImpl = async () => responses.shift()!;
    const result = await uploadAndSendGif({ ...baseParams, fetchImpl });
    expect(result.kind).toBe("error");
  });
});
