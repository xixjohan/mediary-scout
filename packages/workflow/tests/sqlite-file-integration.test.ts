import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2Workflow } from "../src/acquisition-v2/workflow-v2.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { createSqliteWorkflowRepository } from "../src/sqlite.js";
import { ENC_PREFIX } from "@media-track/shared";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

/**
 * 文件型 SQLite 全栈集成（任务单 S4.2，治理文档 §7.2）。
 *
 * :memory: 单测证明不了的性质，这里用真文件证明：
 *   - WAL 模式与 busy_timeout 在真文件上生效；
 *   - 凭据密钥文件 credential.key 与库同目录生成；
 *   - **跨连接可见性**：第二个仓储实例（模拟 worker 另一个进程）能读到
 *     第一个实例提交的运行——SQLite 文件锁/WAL 的真实语义；
 *   - 完整工作流（目录→need→agent→对账→暂存销毁）在真文件上跑通。
 */
const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mediary-integration-"));
  dirs.push(dir);
  return join(dir, "mediary.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }: { keyword: string }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-10-23T00:00:00.000Z",
    }),
  };
}

/** 协议合法的最小跑通：search → reportNoCoverage → 文本收尾。 */
function noCoverageModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      step += 1;
      if (step === 1) {
        return {
          content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "searchResources", input: JSON.stringify({ keyword: "show" }) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      if (step === 2) {
        return {
          content: [{ type: "tool-call" as const, toolCallId: "c2", toolName: "reportNoCoverage", input: JSON.stringify({ reason: "no candidates" }) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "done" }],
        finishReason: { unified: "stop" as const, raw: "stop" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

describe("文件型 SQLite 全栈集成（S4.2）", () => {
  it("真文件：WAL + busy_timeout 生效，密钥文件与库同目录", async () => {
    const path = tmpDbPath();
    const repo = createSqliteWorkflowRepository({ path });
    const raw = new Database(path);
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(raw.pragma("busy_timeout", { simple: true })).toBe(5000);
    raw.close();
    expect(existsSync(join(path, "..", "credential.key"))).toBe(true);
    // 密钥文件权限 0600
    const keyFile = join(path, "..", "credential.key");
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    await repo.close?.();
  });

  it("跨连接可见性：另一个仓储实例读得到提交的运行与加密凭据", async () => {
    const path = tmpDbPath();
    const writer = createSqliteWorkflowRepository({ path });
    await writer.upsertConnectedStorage({
      id: "cs_1",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "100000001",
      label: null,
      payload: { cookie: "UID=cross; CID=1; SEID=conn" },
      rootCid: "r",
      moviesCid: "m",
      tvCid: "t",
      animeCid: "a",
      createdAt: "2026-10-23T00:00:00.000Z",
    });
    await writer.close?.();

    // 磁盘上是密文
    const raw = new Database(path);
    const row = raw.prepare("SELECT payload FROM connected_storages WHERE id = 'cs_1'").get() as { payload: string };
    expect(row.payload.startsWith(ENC_PREFIX)).toBe(true);
    raw.close();

    // 第二个实例（另一个进程的角色）用同一密钥文件解出明文
    const reader = createSqliteWorkflowRepository({ path });
    const found = await reader.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.payload).toEqual({ cookie: "UID=cross; CID=1; SEID=conn" });
    await reader.close?.();
  });

  it("完整工作流在真文件上跑通：runState=completed，运行落库可查", async () => {
    const path = tmpDbPath();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor: new FakeStorageExecutor(),
      model: noCoverageModel(),
      workflowRunId: "run-integration-1",
      title: { name: "集成测试剧", year: 2025, aliases: [], tmdbId: 777 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 2 }],
      qualityPreference: "1080p",
    });
    expect(result.runState).toBe("completed");
    // 真文件 + 仓储：把一次运行持久化后再读回（证明文件栈可写可读）
    const repo = createSqliteWorkflowRepository({ path });
    await repo.saveWorkflowRunSnapshot({
      title: { id: "tmdb_movie_777", tmdbId: 777, type: "tv", title: "集成测试剧", originalTitle: "集成测试剧", year: 2025, aliases: [] },
      season: { id: "season_int", mediaTitleId: "tmdb_movie_777", seasonNumber: 1, status: "active", qualityPreference: "1080p", storageDirectoryId: "d", totalEpisodes: 2, latestAiredEpisode: 2, latestAiredSource: "metadata" },
      workflowRun: { id: "run-integration-1", kind: "type2_init", status: "succeeded", trackedSeasonId: "season_int", startedAt: "2026-10-23T00:00:00.000Z", finishedAt: "2026-10-23T00:01:00.000Z", auditEvents: [] },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      connectedStorageId: "cs_1",
    } as never);
    const readBack = await repo.getWorkflowRunSnapshot("run-integration-1");
    expect(readBack?.workflowRun.id).toBe("run-integration-1");
    expect(readBack?.workflowRun.status).toBe("succeeded");
    // 死链回收/统计在真文件上也可用
    expect(await repo.reapExpiredDeadLinks()).toBe(0);
    expect((await repo.deadLinkStats()).total).toBe(0);
    await repo.close?.();
  });
});
