import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  OWNER_INGEST_COOLDOWN_MS,
  OWNER_INGEST_TTL_MS,
  ownerIngestCooldownKey,
  ownerIngestSearchRunId,
  ownerIngestSnapshotId,
} from "./owner-ingest-service";
import { normalizeSearchKeyword } from "@media-track/workflow";

/**
 * 关键字检索侧的关键不变量（对应方案 §7 的 G5/G7 精神）：
 *  1. 冷却键按「账号 + 后端组合 + 归一化关键字」，不依赖 titleId（没有作品就没有 titleId）；
 *  2. 两次相同检索拿到两份独立 snapshotId —— 内容哈希 id 会撞
 *     `resource_snapshots.id` 全局主键，第二份会被静默丢弃；
 *  3. 快照落库的 run id 与提交端取回的 run id 是同一推导（不可能漂移）；
 *  4. 「关键词相同但空格/大小写不同」命中同一个冷却键；
 *  5. 换了后端组合就是另一把键（不得复用上一次的缓存——否则「换源再搜」看起来成功、
 *     实际拿的是原源的结果）。
 */
describe("owner ingest search 的键与 id 推导", () => {
  it("冷却键按 (账号, 归一化关键字) —— 与 titleId 无关", () => {
    expect(ownerIngestCooldownKey("acct_a", "Frieren 4K")).toBe(
      ownerIngestCooldownKey("acct_a", "  frieren   4K "),
    );
    expect(ownerIngestCooldownKey("acct_a", "frieren")).not.toBe(ownerIngestCooldownKey("acct_b", "frieren"));
  });

  it("归一化与 agent 搜索门禁共用同一函数（不允许两套空格/大小写规则）", () => {
    expect(ownerIngestCooldownKey("a", "   Hello   World ")).toBe(
      `owner_ingest|a|all|${normalizeSearchKeyword("Hello World")}`,
    );
  });

  it("后端组合进键：全选 = all，子集按固定顺序拼接，两者互不复用", () => {
    const all = ownerIngestCooldownKey("a", "kw");
    const subset = ownerIngestCooldownKey("a", "kw", ["pansou"]);
    const sorted1 = ownerIngestCooldownKey("a", "kw", ["prowlarr", "pansou"]);
    const sorted2 = ownerIngestCooldownKey("a", "kw", ["pansou", "prowlarr"]);
    expect(all).not.toBe(subset);
    expect(sorted1).toBe(sorted2);
    expect(sorted1).not.toBe(all);
  });

  it("run id 与 snapshot id 是不同前缀，且都带上本次检索 id", () => {
    const searchRunId = "acct_a_abc123";
    expect(ownerIngestSearchRunId(searchRunId)).toBe(`owner_ingest_search_${searchRunId}`);
    expect(ownerIngestSnapshotId(searchRunId)).toBe(`owner_ingest_${searchRunId}`);
    expect(ownerIngestSearchRunId(searchRunId)).not.toBe(ownerIngestSnapshotId(searchRunId));
  });

  it("窗口与冷却常量符合方案（30 分钟窗口 / 60 秒冷却）", () => {
    expect(OWNER_INGEST_TTL_MS).toBe(30 * 60 * 1000);
    expect(OWNER_INGEST_COOLDOWN_MS).toBe(60 * 1000);
  });
});

const mockProvider = {
  search: vi.fn(),
};

vi.mock("../../../composition/runtime-container", () => ({
  getWorkflowRepository: vi.fn(),
}));

describe("searchOwnerIngestCandidates", () => {
  beforeEach(() => {
    mockProvider.search.mockReset();
  });

  it("两次相同检索各得一份 snapshot（内容哈希 id 不得复用）", async () => {
    const { searchOwnerIngestCandidates } = await import("./owner-ingest-service");
    const repository = { saveWorkflowRunSnapshot: vi.fn(async () => {}) } as never;

    mockProvider.search.mockImplementation(async ({ keyword }: { keyword: string }) => ({
      id: "pansou_content_hash_same",
      provider: "pansou",
      keyword,
      candidates: [
        { id: "c1", snapshotId: "pansou_content_hash_same", index: 0, title: "x", type: "magnet", source: "s", providerPayload: { url: "magnet:?xt=urn:btih:a" } },
      ],
      createdAt: "2026-11-17T00:00:00.000Z",
    }));

    const first = await searchOwnerIngestCandidates({
      accountId: "acct_a",
      storageId: "drive_1",
      keyword: "test",
      provider: mockProvider as never,
      repository,
      now: () => "2026-11-17T00:00:00.000Z",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    // 第一份快照的 id 被本次检索 id 覆盖（不再是 provider 的内容哈希）。
    expect(first.result.searchRunId).toContain("acct_a");
    const saved = (repository as unknown as { saveWorkflowRunSnapshot: ReturnType<typeof vi.fn> }).saveWorkflowRunSnapshot.mock.calls[0]![0];
    const snapshotId = saved.resourceSnapshots[0].id;
    expect(snapshotId).toBe(ownerIngestSnapshotId(first.result.searchRunId));
    expect(snapshotId).not.toBe("pansou_content_hash_same");
    // 候选的 snapshotId 也必须跟着改，否则 repository 的 validateWorkflowRunSnapshot 会拒。
    expect(saved.resourceSnapshots[0].candidates[0].snapshotId).toBe(snapshotId);
  });

  it("30 分钟内的同 key 检索命中缓存，不再打 provider", async () => {
    const { searchOwnerIngestCandidates, _resetOwnerIngestCacheForTests } = await import("./owner-ingest-service");
    _resetOwnerIngestCacheForTests();
    const repository = { saveWorkflowRunSnapshot: vi.fn(async () => {}) } as never;
    const clock = { now: "2026-11-17T00:00:00.000Z" };
    mockProvider.search.mockImplementation(async ({ keyword }: { keyword: string }) => ({
      id: "h2",
      provider: "p",
      keyword,
      candidates: [
        { id: "c1", snapshotId: "h2", index: 0, title: "y", type: "115", source: "s", providerPayload: { url: "https://115.com/s/x" } },
      ],
      createdAt: clock.now,
    }));

    const call = () =>
      searchOwnerIngestCandidates({
        accountId: "acct_cache",
        storageId: "drive_1",
        keyword: "same keyword",
        provider: mockProvider as never,
        repository,
        now: () => clock.now,
      });

    const first = await call();
    expect(first.kind).toBe("ok");
    // 第二次不再消耗冷却、也不打 provider——有候选的结果会进 30 分钟缓存。
    mockProvider.search.mockClear();
    const second = await call();
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.result.cached).toBe(true);
    expect(mockProvider.search).not.toHaveBeenCalled();
  });

  it("源抛错时退还冷却额度（用户不该因我们的故障被罚 60 秒）", async () => {
    const { searchOwnerIngestCandidates, _resetOwnerIngestCacheForTests } = await import("./owner-ingest-service");
    _resetOwnerIngestCacheForTests();
    mockProvider.search.mockRejectedValue(new Error("source down"));
    const repository = { saveWorkflowRunSnapshot: vi.fn(async () => {}) } as never;
    const failed = await searchOwnerIngestCandidates({
      accountId: "acct_err",
      storageId: "d",
      keyword: "boom",
      provider: mockProvider as never,
      repository,
      now: () => "2026-11-17T00:10:00.000Z",
    });
    expect(failed.kind).toBe("error");

    mockProvider.search.mockResolvedValue({
      id: "ok",
      provider: "p",
      keyword: "boom",
      candidates: [],
      createdAt: "2026-11-17T00:10:00.000Z",
    });
    const retry = await searchOwnerIngestCandidates({
      accountId: "acct_err",
      storageId: "d",
      keyword: "boom",
      provider: mockProvider as never,
      repository,
      now: () => "2026-11-17T00:10:00.000Z",
    });
    expect(retry.kind).toBe("ok");
  });
});
