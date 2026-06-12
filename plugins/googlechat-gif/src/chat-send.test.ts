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
