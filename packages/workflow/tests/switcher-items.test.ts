import { describe, expect, it } from "vitest";
import { switcherItems } from "../src/index.js";

const drives = [
  { id: "csNew", label: null, providerUid: "100000002", createdAt: "2026-06-10T00:00:00.000Z", status: "active" as const },
  { id: "csOld", label: "我的主号", providerUid: "100000001", createdAt: "2026-06-01T00:00:00.000Z", status: "active" as const },
];

describe("switcherItems", () => {
  it("primary (earliest) routes to '/', others to /w/<id>", () => {
    const items = switcherItems(drives, "/");
    expect(items.map((i) => [i.id, i.href])).toEqual([
      ["csOld", "/"],
      ["csNew", "/w/csNew"],
    ]);
  });
  it("on '/' the primary is active", () => {
    expect(switcherItems(drives, "/").find((i) => i.isActive)?.id).toBe("csOld");
  });
  it("on /w/<id> that drive is active", () => {
    expect(switcherItems(drives, "/w/csNew").find((i) => i.isActive)?.id).toBe("csNew");
  });
  it("a non-workspace path (/settings) keeps the primary active", () => {
    expect(switcherItems(drives, "/settings").find((i) => i.isActive)?.id).toBe("csOld");
  });
  it("label falls back to a uid-tail when unnamed; frozen surfaced", () => {
    const frozen = [
      { id: "csOld", label: null, providerUid: "100000001", createdAt: "2026-06-01T00:00:00.000Z", status: "active" as const },
      { id: "csNew", label: null, providerUid: "100000002", createdAt: "2026-06-10T00:00:00.000Z", status: "frozen" as const },
    ];
    const items = switcherItems(frozen, "/");
    expect(items[0]!.label).toContain("4004");
    expect(items.find((i) => i.id === "csNew")?.frozen).toBe(true);
  });
});
