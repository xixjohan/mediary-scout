import { describe, expect, it, vi } from "vitest";
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

  it("uses the immutable queued snapshot instead of a later edited work policy", async () => {
    const option = await loadSubscriptionPolicyFilter({
      workflowRunId: "run_snapshot",
      repository: {
        getSubscriptionPolicy: async () => ({
          accountId: "acct_a", titleKey: "tmdb_tv_42", mustContain: ["1080p"], mustNotContain: [],
          episodeFilter: "", useRegex: false, cooldownDays: 0, customKeywords: [], priorityGroups: [],
          lastTakenAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
        }),
        getWorkflowRunPolicySnapshot: async () => ({ schemaVersion: 1, evaluatorVersion: 1, capturedAt: "2026-01-01T00:00:00Z", policy: {
          mustContain: ["2160p"], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 0,
          seasonEpisodeRanges: [{ seasonNumber: 1, startEpisode: 3, endEpisode: 5 }],
        } }),
      },
      accountId: "acct_a", titleKey: "tmdb_tv_42",
    });
    expect(option.policyFilter?.accept({ name: "Show.2160p.mkv" })).toBe(true);
    expect(option.policyFilter?.accept({ name: "Show.1080p.mkv" })).toBe(false);
    expect(option.policyFilter?.accept({ name: "Show.S01E02.2160p.mkv" })).toBe(false);
    expect(option.policyFilter?.accept({ name: "Show.S01E03.2160p.mkv" })).toBe(true);
    expect(option.policyFileValidator?.({ name: "Show.S01E02.2160p.mkv" })).toBe("episode_filtered");
    expect(option.policyFileValidator?.({ name: "2160p-unparsed-video.mkv" })).toBe("episode_filtered");
  });

  it("fails closed when a queued task snapshot is missing, unknown, or from an unsupported evaluator", async () => {
    const getSubscriptionPolicy = vi.fn(async () => null);
    const repository = {
      getSubscriptionPolicy,
      getWorkflowRunPolicySnapshot: async () => null,
    };
    await expect(loadSubscriptionPolicyFilter({ repository, workflowRunId: "run_missing", accountId: "acct_a", titleKey: "tmdb_tv_42" }))
      .rejects.toThrow(/无法读取.*快照/);
    expect(getSubscriptionPolicy).not.toHaveBeenCalled();

    await expect(loadSubscriptionPolicyFilter({
      repository: { ...repository, getWorkflowRunPolicySnapshot: async () => ({ schemaVersion: 0, legacyUnknown: true }) },
      workflowRunId: "run_legacy", accountId: "acct_a", titleKey: "tmdb_tv_42",
    })).rejects.toThrow(/没有入队时的订阅策略快照/);
    await expect(loadSubscriptionPolicyFilter({
      repository: { ...repository, getWorkflowRunPolicySnapshot: async () => ({ schemaVersion: 1, evaluatorVersion: 2, capturedAt: "2026-01-01T00:00:00Z", policy: null }) },
      workflowRunId: "run_future", accountId: "acct_a", titleKey: "tmdb_tv_42",
    })).rejects.toThrow(/不支持的订阅策略快照版本/);
  });

  it("uses priority groups to rank search candidates while file checks apply only hard rules", async () => {
    const option = await loadSubscriptionPolicyFilter({
      repository: { getSubscriptionPolicy: async () => ({
        accountId: "acct_a", titleKey: "tmdb_tv_42", mustContain: [], mustNotContain: [],
        episodeFilter: "", useRegex: false, cooldownDays: 0, customKeywords: [], lastTakenAt: null,
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        priorityGroups: [
          { id: "preferred", name: "优先", mustContain: ["remux"], mustNotContain: [] },
          { id: "fallback", name: "兜底", mustContain: ["1080p"], mustNotContain: [] },
        ],
      }) },
      accountId: "acct_a", titleKey: "tmdb_tv_42",
    });
    expect(option.policyFilter?.rank({ name: "Show.REMUX.1080p.mkv" })).toBe(0);
    expect(option.policyFilter?.rank({ name: "Show.1080p.mkv" })).toBe(1);
    expect(option.policyFileValidator?.({ name: "renamed-video.mkv" })).toBe(null);
  });
});
