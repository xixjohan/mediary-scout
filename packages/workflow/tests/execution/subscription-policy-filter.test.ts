import { describe, expect, it } from "vitest";
import { loadSubscriptionPolicyFilter } from "../../src/execution/subscription-policy-filter.js";

describe("loadSubscriptionPolicyFilter", () => {
  it("returns no filter when the title has no saved policy", async () => {
    const option = await loadSubscriptionPolicyFilter({
      repository: { getSubscriptionPolicy: async () => null },
      accountId: "acct_a",
      titleKey: "tmdb_tv_42",
    });
    expect(option).toEqual({});
  });

  it("provides the same hard matcher for saved include and exclude rules", async () => {
    const option = await loadSubscriptionPolicyFilter({
      repository: {
        getSubscriptionPolicy: async () => ({
          accountId: "acct_a",
          titleKey: "tmdb_tv_42",
          mustContain: ["2160p"],
          mustNotContain: ["CAM"],
          episodeFilter: "S01E01",
          useRegex: false,
          cooldownDays: 0,
          customKeywords: ["字幕组名"],
          lastTakenAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      },
      accountId: "acct_a",
      titleKey: "tmdb_tv_42",
    });
    const filter = option.policyFilter;
    expect(filter).toBeDefined();
    if (!filter) throw new Error("expected a policy filter");
    expect(filter.accept({ name: "Show.S01E01.2160p.mkv" })).toBe(true);
    expect(filter.accept({ name: "Show.S01E01.1080p.mkv" })).toBe(false);
    expect(filter.accept({ name: "Show.S01E01.2160p.CAM.mkv" })).toBe(false);
    expect(filter.accept({ name: "Show.S02E01.2160p.mkv" })).toBe(false);
    expect(option.policyFileValidator?.({ name: "Show.S01E01.2160p.mkv", episodeCode: "S01E01" })).toBe(null);
    expect(option.policyFileValidator?.({ name: "Show.S01E02.2160p.mkv", episodeCode: "S01E02" })).toBe(
      "episode_filtered",
    );
    expect(option.subscriptionSearchKeywords).toEqual(["字幕组名"]);
  });

  it("keeps account and title scope on the repository lookup", async () => {
    let query: unknown;
    await loadSubscriptionPolicyFilter({
      repository: {
        getSubscriptionPolicy: async (input) => { query = input; return null; },
      },
      accountId: "acct_b",
      titleKey: "tmdb_movie_17",
    });
    expect(query).toEqual({ accountId: "acct_b", titleKey: "tmdb_movie_17" });
  });
});
