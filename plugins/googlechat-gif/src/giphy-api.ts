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
  // idx is always in [0, usable.length) here because usable.length > 0 (checked above).
  const gif = usable[idx] as GifPick;
  return { kind: "ok", gif };
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
