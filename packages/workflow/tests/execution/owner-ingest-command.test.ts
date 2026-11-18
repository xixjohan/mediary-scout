import { describe, expect, it } from "vitest";
import {
  OWNER_INGEST_KIND,
  ownerIngestTitleId,
  rebaseOwnerIngestSnapshot,
  syntheticOwnerIngestSeason,
  syntheticOwnerIngestTitle,
  queueOwnerIngest,
} from "../../src/execution/owner-ingest-command.js";
import { parseTitleId } from "../../src/domain/media-identity.js";
import { isUserVisibleWorkflowKind } from "../../src/domain/domain.js";
import type { ResourceSnapshot } from "../../src/domain/domain.js";

/**
 * owner_ingest 的身份契约（对应方案 §4.1/§4.2 的决策）：
 *  1. **无作品时用合成标题**，其 id 刻意躲开 `tmdb_*` / `douban_*` 前缀——
 *     任何把它当真实 tmdb 作品的代码都会得到「不认识」，而不是静默误配。
 *  2. **tmdbId = 0 是哨兵**：本仓所有 TMDB 调用都要求 > 0，因此合成标题不会被
 *     抓去刮削或补缺。
 *  3. **季节状态 completed**：投放记录不应该在订阅墙上显示「追更中 / 缺 N 集」。
 *  4. **候选成员与 TTL 复用同一 resolver**：不复制第二套规则。
 */
describe("owner_ingest 合成身份", () => {
  it("合成标题 id 不是 tmdb/douban 前缀（解析必须返回 not a title id）", () => {
    const title = syntheticOwnerIngestTitle({ storageId: "drive_1", keyword: "某片 4K" });
    const parsed = parseTitleId(title.id);
    expect(parsed.ok).toBe(false);
  });

  it("tmdbId 是哨兵 0（不会被任何 TMDB 调用当成真实作品）", () => {
    const title = syntheticOwnerIngestTitle({ storageId: "d", keyword: "x" });
    expect(title.tmdbId).toBe(0);
  });

  it("同一 (盘, 关键字) 得到稳定 id；不同盘互不覆盖", () => {
    expect(ownerIngestTitleId({ storageId: "d1", keyword: "Frieren" })).toBe(
      ownerIngestTitleId({ storageId: "d1", keyword: "  frieren " }),
    );
    expect(ownerIngestTitleId({ storageId: "d1", keyword: "x" })).not.toBe(
      ownerIngestTitleId({ storageId: "d2", keyword: "x" }),
    );
  });

  it("合成季节是 completed（不进订阅墙的追更语义）", () => {
    const title = syntheticOwnerIngestTitle({ storageId: "d", keyword: "x" });
    const season = syntheticOwnerIngestSeason(title, "target_dir");
    expect(season.status).toBe("completed");
    expect(season.storageDirectoryId).toBe("target_dir");
    expect(season.mediaTitleId).toBe(title.id);
  });

  it("空关键字也给出可用的兜底标题（不让 run 记录带空标题）", () => {
    const title = syntheticOwnerIngestTitle({ storageId: "d", keyword: "   " });
    expect(title.title.length).toBeGreaterThan(0);
  });
});

/**
 * 活动流可见性（Dev 3020 验收实测缺陷）：
 * `owner_ingest` 曾被当成用户可见 kind，于是投放出现在「获取中/已完成」，
 * 行链到 `showHref(title.tmdbId=0)` → `/show/0`（404），且文案读作
 * 「系统在追这部片」——而投放根本没有作品身份。现在它必须被活动流隐藏。
 */
describe("owner_ingest 不进活动流", () => {
  it("isUserVisibleWorkflowKind(owner_ingest) === false", () => {
    expect(isUserVisibleWorkflowKind("owner_ingest")).toBe(false);
  });

  it("对照：manual_import 仍可见（用户自己的入库，进度要能被看到）", () => {
    expect(isUserVisibleWorkflowKind("manual_import")).toBe(true);
  });

  it("对照：resource_search 隐藏（只读记录）", () => {
    expect(isUserVisibleWorkflowKind("resource_search")).toBe(false);
  });
});

describe("queueOwnerIngest", () => {
  const snapshot: ResourceSnapshot = {
    id: "snap_1",
    provider: "pansou",
    keyword: "kw",
    candidates: [
      {
        id: "snap_1_c1",
        snapshotId: "snap_1",
        index: 0,
        title: "x",
        type: "magnet",
        source: "s",
        providerPayload: { url: "magnet:?xt=urn:btih:a" },
      },
    ],
    createdAt: "2026-11-17T00:00:00.000Z",
  };

  const reserve = (result: unknown) => ({
    reserveWorkflowRun: async () => result,
  });

  it("窗口内 + 候选存在 → queued，并带 blockIfTitleHasActiveRun", async () => {
    let captured: Record<string, unknown> = {};
    const outcome = await queueOwnerIngest({
      request: {
        accountId: "acct",
        connectedStorageId: "drive_1",
        snapshot,
        candidateId: "snap_1_c1",
        targetDirectoryId: "dir_x",
        now: () => "2026-11-17T00:05:00.000Z",
      },
      repository: {
        reserveWorkflowRun: async (input: Record<string, unknown>) => {
          captured = input;
          return { status: "reserved", snapshot: input };
        },
      } as never,
    });
    expect(outcome.status).toBe("queued");
    expect(captured["blockIfTitleHasActiveRun"]).toBe(true);

    const audit = (captured["workflowRun"] as { auditEvents: Array<{ type: string; data: Record<string, unknown> }> }).auditEvents;
    expect(audit[0]!.type).toBe("owner_ingest_queued");
    expect(audit[0]!.data["targetDirectoryId"]).toBe("dir_x");
    expect(audit[0]!.data["boundTitle"]).toBe(false);
    expect((captured["workflowRun"] as { kind: string }).kind).toBe(OWNER_INGEST_KIND);
  });

  it("候选不在快照里 → rejected(not_found)，且不写任何东西", async () => {
    const outcome = await queueOwnerIngest({
      request: {
        accountId: "acct",
        connectedStorageId: "drive_1",
        snapshot,
        candidateId: "not_in_snapshot",
        targetDirectoryId: "dir_x",
      },
      repository: reserve({ status: "reserved", snapshot: {} }) as never,
    });
    expect(outcome.status).toBe("rejected");
  });

  it("超过 30 分钟窗口 → rejected(expired)", async () => {
    const outcome = await queueOwnerIngest({
      request: {
        accountId: "acct",
        connectedStorageId: "drive_1",
        snapshot,
        candidateId: "snap_1_c1",
        targetDirectoryId: "dir_x",
        now: () => "2026-11-17T01:00:00.000Z",
      },
      repository: reserve({ status: "reserved", snapshot: {} }) as never,
    });
    expect(outcome).toMatchObject({ status: "rejected", reason: "expired" });
  });
});

/**
 * 定基是「静默丢快照」这个缺陷的钉子。
 *
 * 背景（Dev 3020 实机复现）：检索记录以 `owner_ingest_<searchRunId>` 落库；
 * 投放 run 若沿用同一 snapshot id，`resource_snapshots` 的
 * `ON CONFLICT (id) DO NOTHING` 会把第二条插入静默吞掉，随后
 * `validateWorkflowRunSnapshot` 抛「Agent decision referenced unknown resource
 * snapshot」——drain 因一次异常整体失败，投放永远排队。
 */
describe("rebaseOwnerIngestSnapshot", () => {
  const snapshot: ResourceSnapshot = {
    id: "owner_ingest_search_abc",
    provider: "pansou",
    keyword: "kw",
    createdAt: "2026-11-17T00:00:00.000Z",
    candidates: [
      { id: "owner_ingest_search_abc_c1", snapshotId: "owner_ingest_search_abc", index: 0, title: "a", type: "115", source: "s", providerPayload: {} },
      { id: "owner_ingest_search_abc_c2", snapshotId: "owner_ingest_search_abc", index: 1, title: "b", type: "magnet", source: "s", providerPayload: {} },
    ],
  };

  it("snapshot id 与目标候选 id 都带上本次 run（不与检索记录撞主键）", () => {
    const rebased = rebaseOwnerIngestSnapshot({
      snapshot,
      workflowRunId: "run_1",
      candidateId: "owner_ingest_search_abc_c1",
    });
    expect(rebased.snapshot.id).toBe("owner_ingest_search_abc_run_1");
    expect(rebased.snapshot.id).not.toBe(snapshot.id);
    expect(rebased.candidateId).not.toBe("owner_ingest_search_abc_c1");
    expect(rebased.snapshot.candidates.some((c) => c.id === rebased.candidateId)).toBe(true);
  });

  it("所有候选的 snapshotId 同步改写（否则 validateWorkflowRunSnapshot 会拒）", () => {
    const rebased = rebaseOwnerIngestSnapshot({ snapshot, workflowRunId: "run_1", candidateId: "x" });
    for (const candidate of rebased.snapshot.candidates) {
      expect(candidate.snapshotId).toBe(rebased.snapshot.id);
    }
  });

  it("两次投放同一份检索快照得到互不相同的 snapshot id", () => {
    const a = rebaseOwnerIngestSnapshot({ snapshot, workflowRunId: "run_a", candidateId: "x" });
    const b = rebaseOwnerIngestSnapshot({ snapshot, workflowRunId: "run_b", candidateId: "x" });
    expect(a.snapshot.id).not.toBe(b.snapshot.id);
  });
});
