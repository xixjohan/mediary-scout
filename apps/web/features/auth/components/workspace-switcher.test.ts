import { describe, it, expect, beforeEach } from "vitest";
import { resolveActiveSwitcherId, type WorkspaceTab } from "./workspace-switcher";
import { computeEpisodeFilter } from "../../acquisition/components/subscription-modal";

describe("WorkspaceSwitcher Resolution Chain", () => {
  const tabs: WorkspaceTab[] = [
    { id: "cs_quark_1", href: "/w/cs_quark_1", label: "夸克网盘", provider: "quark", frozen: false },
    { id: "cs_115_2", href: "/w/cs_115_2", label: "115网盘", provider: "115", frozen: false },
  ];

  beforeEach(() => {
    // Clear mock document cookies
    if (typeof document !== "undefined") {
      document.cookie = "mediary_active_workspace=; path=/; max-age=0";
    }
  });

  it("prioritizes /w/:id path over query and initialActiveId", () => {
    const activeId = resolveActiveSwitcherId(tabs, "/w/cs_115_2/show/100", "cs_quark_1", "cs_quark_1");
    expect(activeId).toBe("cs_115_2");
  });

  it("resolves query param ?w= when path has no /w/ prefix", () => {
    const activeId = resolveActiveSwitcherId(tabs, "/show/100", "cs_115_2", "cs_quark_1");
    expect(activeId).toBe("cs_115_2");
  });

  it("resolves server initialActiveId when path and query have no workspace info", () => {
    const activeId = resolveActiveSwitcherId(tabs, "/show/100", null, "cs_115_2");
    expect(activeId).toBe("cs_115_2");
  });

  it("resolves cookie when path, query and initialActiveId are not set", () => {
    if (typeof document !== "undefined") {
      document.cookie = "mediary_active_workspace=cs_115_2; path=/";
      const activeId = resolveActiveSwitcherId(tabs, "/show/100", null, undefined);
      expect(activeId).toBe("cs_115_2");
    }
  });

  it("falls back to primary tab[0] when no context is available", () => {
    const activeId = resolveActiveSwitcherId(tabs, "/show/100", null, undefined);
    expect(activeId).toBe("cs_quark_1");
  });
});

describe("SubscriptionModal Episode Filter Calculation", () => {
  it("leaves movie filter untouched", () => {
    const filter = computeEpisodeFilter(false, new Set([1, 2]), [1, 2, 3], "E01-E10");
    expect(filter).toBe("E01-E10");
  });

  it("formats selected partial seasons into standard S01;S03 tokens", () => {
    const filter = computeEpisodeFilter(true, new Set([3, 1]), [1, 2, 3, 4], "");
    expect(filter).toBe("S01;S03");
  });

  it("retains fallback filter when all seasons are selected (full acquisition)", () => {
    const filter = computeEpisodeFilter(true, new Set([1, 2, 3]), [1, 2, 3], "E01-E20");
    expect(filter).toBe("E01-E20");
  });
});
