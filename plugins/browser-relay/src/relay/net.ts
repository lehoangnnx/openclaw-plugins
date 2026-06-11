/**
 * Vendored loopback checks for the relay's bind/enforcement logic. Kept local so
 * the plugin carries no dependency on OpenClaw core internals (originally
 * `src/gateway/net`). The relay only needs to know whether a host targets the
 * local loopback interface, so this is intentionally a narrow subset.
 */

/** True if `ip` is an IPv4 (127.0.0.0/8) or IPv6 (`::1`) loopback literal. */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  let host = ip.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const zone = host.indexOf("%");
  if (zone !== -1) {
    host = host.slice(0, zone);
  }
  if (host === "::1") {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    host = host.slice("::ffff:".length);
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return false;
  }
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 127;
}

/** True if `host` (hostname or IP literal) targets the local loopback interface. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  return isLoopbackAddress(normalized);
}
