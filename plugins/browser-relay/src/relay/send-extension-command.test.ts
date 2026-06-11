import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ensureChromeExtensionRelayServer,
  getChromeExtensionRelayAuthHeaders,
  getChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";

/**
 * Proves the coarse-grained fast-path seam: sendExtensionCommand forwards one
 * high-level command to the extension with id-correlation and returns its
 * result, and listExtensionTargets reflects the attached tab. This is the
 * round-trip-collapsing path the browser_fast tool rides.
 */

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    srv.once("error", reject);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

let activeCdpUrl = "";
let prevToken: string | undefined;

beforeAll(() => {
  // The relay refuses to listen without a shared token; supply one for the test.
  prevToken = process.env.OPENCLAW_BROWSER_RELAY_TOKEN;
  process.env.OPENCLAW_BROWSER_RELAY_TOKEN = "test-token";
});

afterAll(() => {
  if (prevToken === undefined) delete process.env.OPENCLAW_BROWSER_RELAY_TOKEN;
  else process.env.OPENCLAW_BROWSER_RELAY_TOKEN = prevToken;
});

afterEach(async () => {
  if (activeCdpUrl) {
    await stopChromeExtensionRelayServer({ cdpUrl: activeCdpUrl }).catch(() => {});
    activeCdpUrl = "";
  }
});

describe("sendExtensionCommand", () => {
  it("forwards a high-level command and returns the extension's result", async () => {
    const port = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    activeCdpUrl = cdpUrl;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const wsUrl = `ws://127.0.0.1:${port}/extension`;
    const ext = new WebSocket(wsUrl, { headers: getChromeExtensionRelayAuthHeaders(wsUrl) });
    await waitForOpen(ext);

    // Capture the exact command the relay forwards.
    let forwarded: { method?: string; sessionId?: string; params?: unknown } | null = null;
    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as {
        id?: number;
        method?: string;
        params?: { method?: string; sessionId?: string; params?: unknown };
      };
      if (msg.method === "forwardCDPCommand" && typeof msg.id === "number") {
        forwarded = {
          method: msg.params?.method,
          sessionId: msg.params?.sessionId,
          params: msg.params?.params,
        };
        ext.send(JSON.stringify({ id: msg.id, result: { elements: [{ idx: 1, tag: "button" }] } }));
      }
    });

    // Announce one attached page target so the relay tracks it.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: { targetId: "T1", type: "page", url: "https://example.com", title: "Ex" },
            waitingForDebugger: false,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    const server = getChromeExtensionRelayServer(port);
    expect(server).not.toBeNull();

    const targets = server!.listExtensionTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ targetId: "T1", sessionId: "cb-tab-1", url: "https://example.com" });

    const result = (await server!.sendExtensionCommand(
      "Extension.markElements",
      { maxElements: 5 },
      { sessionId: "cb-tab-1", targetId: "T1" },
    )) as { elements: Array<{ idx: number }> };

    expect(result.elements[0].idx).toBe(1);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.method).toBe("Extension.markElements");
    expect(forwarded!.sessionId).toBe("cb-tab-1");
    // targetId is embedded into the inner params so the extension resolves the tab.
    expect(forwarded!.params).toMatchObject({ maxElements: 5, targetId: "T1" });

    ext.close();
  });

  it("rejects when the extension is not connected", async () => {
    const port = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    activeCdpUrl = cdpUrl;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const server = getChromeExtensionRelayServer(port);
    expect(server).not.toBeNull();
    expect(server!.listExtensionTargets()).toHaveLength(0);
    await expect(server!.sendExtensionCommand("Extension.extractContent")).rejects.toThrow(
      /not connected/i,
    );
  });
});
