import { describe, expect, it } from "vitest";
import { chooseIndex, downloadGif, pickRendition, searchGif, type GiphyImages } from "./giphy-api.js";

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
    if (out.kind === "error") expect(out.message).toContain("429");
  });
});

describe("downloadGif", () => {
  it("ok path: returns bytes and contentType for a 200 response", async () => {
    const gifBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (async () =>
      new Response(gifBytes, { status: 200, headers: { "content-type": "image/gif" } })) as unknown as typeof fetch;
    const result = await downloadGif("https://giphy/test.gif", 1_000_000, fetchImpl);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(Buffer.isBuffer(result.bytes)).toBe(true);
      expect(result.bytes.byteLength).toBe(4);
      expect(result.contentType).toBe("image/gif");
    }
  });

  it("over-limit: returns error when body exceeds maxBytes", async () => {
    const gifBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = (async () =>
      new Response(gifBytes, { status: 200, headers: { "content-type": "image/gif" } })) as unknown as typeof fetch;
    const result = await downloadGif("https://giphy/big.gif", 3, fetchImpl);
    expect(result.kind).toBe("error");
  });

  it("non-200: returns error for a 404 response", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    const result = await downloadGif("https://giphy/missing.gif", 1_000_000, fetchImpl);
    expect(result.kind).toBe("error");
  });
});
