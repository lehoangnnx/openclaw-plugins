import type WebSocket from "ws";

/**
 * Normalize a ws `RawData` payload (string | Buffer | Buffer[] | ArrayBuffer)
 * into a string. Vendored from OpenClaw core `src/infra/ws` so the relay stays
 * self-contained inside the plugin.
 */
export function rawDataToString(
  data: WebSocket.RawData,
  encoding: BufferEncoding = "utf8",
): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString(encoding);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString(encoding);
  }
  return Buffer.from(data as ArrayBuffer).toString(encoding);
}
