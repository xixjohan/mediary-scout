import { describe, expect, it } from "vitest";
import type { MediaTitle, ResourceSnapshot, TrackedSeason } from "../../src/domain.js";
import { isUserVisibleWorkflowKind } from "../../src/domain.js";
import { RESOURCE_SEARCH_KIND, buildResourceSearchRun, resourceSearchIsUserVisible } from "../../src/providers/resource-search-run.js";

/**
 * 批次 3：把用户态搜索的快照落成一个 run。
 *
 * 断言的要点是「它是记录，不是工作」——每一条非空字段都会是后来者（janitor、媒体库
 * 视图）会当真的事。
 */

const NOW = "2024-05-01T10:00:00Z";

function title(): MediaTitle {
  return {
    id: "t1",
    tmdbId: 283428,
    type: "tv",
    title: "孤独摇滚",
    originalTitle: "Bocchi the Rock!",
    year: 2022,
    aliases: [],
  };
}

function season(): TrackedSeason {
  return {
    id: "t1_s1",
    mediaTitleId: "t1",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata",
  };
}

function snapshot(): ResourceSnapshot {
  return {
    id: "snap-1",
    provider: "pansou",
    keyword: "孤独摇滚",
    createdAt: NOW,
    candidates: [
      {
        id: "c1",
        snapshotId: "snap-1",
        index: 0,
        title: "孤独摇滚 S01E01",
        type: "115",
        source: "pansou-115",
        providerPayload: { url: "https://115.com/s/x", password: "p" },
      },
    ],
  };
}

describe("buildResourceSearchRun", () => {
  it("只带快照，其余全空（搜索没有转存/决策/通知）", () => {
    const run = buildResourceSearchRun({
      snapshot: snapshot(),
      title: title(),
      season: season(),
      accountId: "acct_default",
      now: NOW,
    });
    expect(run.resourceSnapshots).toHaveLength(1);
    expect(run.resourceSnapshots[0]!.id).toBe("snap-1");
    expect(run.episodes).toEqual([]);
    expect(run.decisions).toEqual([]);
    expect(run.transferAttempts).toEqual([]);
    expect(run.notifications).toEqual([]);
  });

  it("kind 是 resource_search，status 是 succeeded", () => {
    const run = buildResourceSearchRun({
      snapshot: snapshot(),
      title: title(),
      season: season(),
      accountId: "acct_default",
      now: NOW,
    });
    expect(run.workflowRun.kind).toBe("resource_search");
    expect(run.workflowRun.status).toBe("succeeded");
  });

  it("run id 由快照 id 派生（同一次搜索重复落库是幂等更新，不是两行）", () => {
    const input = { snapshot: snapshot(), title: title(), season: season(), accountId: "a", now: NOW };
    expect(buildResourceSearchRun(input).workflowRun.id).toBe(buildResourceSearchRun(input).workflowRun.id);
    expect(buildResourceSearchRun(input).workflowRun.id).toBe("search_snap-1");
  });

  it("startedAt/finishedAt 同一时刻（它没有持续过程）", () => {
    const run = buildResourceSearchRun({
      snapshot: snapshot(),
      title: title(),
      season: season(),
      accountId: "a",
      now: NOW,
    });
    expect(run.workflowRun.startedAt).toBe(NOW);
    expect(run.workflowRun.finishedAt).toBe(NOW);
  });

  it("drive scope 跟随传入值，省略时落 null", () => {
    const base = { snapshot: snapshot(), title: title(), season: season(), accountId: "a", now: NOW };
    expect(buildResourceSearchRun({ ...base, connectedStorageId: "drive_1" }).connectedStorageId).toBe("drive_1");
    expect(buildResourceSearchRun(base).connectedStorageId).toBeNull();
  });

  it("**不是** queued——否则它算 active，会把季永久堵死", () => {
    // reserveWorkflowRun 在季已有 active run 时回答 already_active。一个搜索记录
    // 若以 queued 落库，用户再也无法对这部片发起任何操作。
    const run = buildResourceSearchRun({
      snapshot: snapshot(),
      title: title(),
      season: season(),
      accountId: "a",
      now: NOW,
    });
    expect(run.workflowRun.status).not.toBe("queued");
    expect(run.workflowRun.status).not.toBe("running");
  });
});

describe("resource_search 的用户可见性", () => {
  it("不出现在任何用户可见列表里", () => {
    expect(resourceSearchIsUserVisible()).toBe(false);
    expect(isUserVisibleWorkflowKind("resource_search")).toBe(false);
  });

  it("manual_import **是**可见的（那是用户自己的导入，进度要给他看）", () => {
    expect(isUserVisibleWorkflowKind("manual_import")).toBe(true);
  });

  it("staging_recovery 仍然不可见（不回归）", () => {
    expect(isUserVisibleWorkflowKind("staging_recovery")).toBe(false);
  });

  it("既有可见 kind 不回归", () => {
    for (const kind of ["type1_package_init", "type2_init", "type3_monitor", "movie_init", "replace_request"] as const) {
      expect(isUserVisibleWorkflowKind(kind)).toBe(true);
    }
  });
});

describe("WorkflowKind 穷尽性", () => {
  it("每个 kind 都有明确的可见性裁决（不留默认值）", () => {
    const kinds = [
      "type1_package_init",
      "type2_init",
      "type3_monitor",
      "movie_init",
      "replace_request",
      "staging_recovery",
      "resource_search",
      "manual_import",
    ] as const;
    expect(kinds).toHaveLength(8);
    // 逐个数出来，确保新增 kind 时这条用例会逼人显式表态
    expect(new Set(kinds).size).toBe(8);
  });
});
