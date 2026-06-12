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
