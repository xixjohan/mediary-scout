import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../../src/acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../../src/acquisition-v2/real-provider-adapter.js";
import { TaskSandbox } from "../../src/acquisition-v2/sandbox.js";
import { loadSubscriptionPolicyFilter } from "../../src/execution/subscription-policy-filter.js";
import { searchFilterFailureReason } from "../../src/acquisition-v2/search-filter-diagnostics.js";

describe("automatic search explains the actual rejection stage", () => {
  it("does not blame policy when a later search has eligible candidates", () => {
    expect(searchFilterFailureReason([
      { type: "resource_filter_applied", message: "filtered", data: { keptCount: 0, policyDropped: 3 } },
      { type: "resource_filter_applied", message: "recovered", data: { keptCount: 1, policyDropped: 0 } },
    ])).toBeNull();
    expect(searchFilterFailureReason([])).toBeNull();
  });
  it("does not blame Jev for a 1080p policy rejecting candidates it retained", async () => {
    const options = await loadSubscriptionPolicyFilter({
      repository: { getSubscriptionPolicy: async () => ({ accountId: "acct_default", titleKey: "tmdb_tv_1",
        mustContain: ["1080p"], mustNotContain: [], episodeFilter: "", useRegex: false, cooldownDays: 0,
        createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z", lastTakenAt: null }) },
      accountId: "acct_default", titleKey: "tmdb_tv_1",
    });
    const provider = new RealResourceProviderV2({ registry: new CandidateRegistry(), workflowRunId: "test",
      ...options,
      provider: { search: async () => ({ id: "snapshot", provider: "registry", keyword: "test", createdAt: "2026-11-14T00:00:00Z",
        candidates: [{ id: "good", snapshotId: "snapshot", index: 0, title: "测试动画 全集", type: "115", source: "test", providerPayload: {} }],
        sourceHealth: { status: "degraded", unhealthySources: ["pansou"] },
        prefilter: { provider: "jev", model: "test", status: "applied", scores: { good: 0.9 },
          dropped: [{ id: "unrelated", title: "无关作品", score: 0.01 }], thresholds: { dropBelow: 0.3, uncertainBelow: 0.7 }, durationMs: 1 },
      }) },
    });
    const sandbox = new TaskSandbox({ provider });
    const result = await sandbox.searchResources("test");
    expect(result.snapshot?.candidates).toEqual([]); // User's hard rule still applies.
    const warning = (result.warnings ?? []).join("\n");
    expect(warning).toContain("订阅策略排除 1");
    expect(warning).toContain("missing_term");
    expect(warning).not.toContain("这不是搜索源故障");
    await sandbox.primeRawSnapshot("test");
    expect(sandbox.viewResourceSnapshot().document).toContain("订阅策略排除 1");
  });
});
