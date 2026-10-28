import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ENC_PREFIX } from "@media-track/shared";
import { createSqliteWorkflowRepository } from "../src/index.js";

/**
 * 密钥丢失/更换时，仓储绝不能把「一块盘需要重新绑定」放大成整体 500。
 *
 * 真实事故：部署目录的 credential.key 被误删后重新生成，connected_storages.payload
 * 用旧密钥加密、解不开。listConnectedStorages 一抛，设置页与 /api/activity 全灭，
 * 而根错误边界还把责任误导成「连不上 TMDB／资源搜索」——用户照着查网络，方向整个错。
 *
 * 铁律：解不开的凭据按「这块盘不存在」降级（并留下可诊断的日志），
 * 让用户还能进 UI 重新绑定；绝不外抛。
 */
describe("凭据解不开时 listConnectedStorages 的降级", () => {
  const dirs: string[] = [];
  const tmpDb = () => {
    const dir = mkdtempSync(join(tmpdir(), "undecryptable-"));
    dirs.push(dir);
    return join(dir, "mediary.db");
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.MEDIA_TRACK_CREDENTIAL_KEY;
  });

  const storageRow = (id: string, uid: string) => ({
    id,
    accountId: "acct_default",
    provider: "quark",
    providerUid: uid,
    label: null,
    payload: { cookie: "QUARK_COOKIE=topsecret-value" },
    rootCid: null,
    moviesCid: null,
    tvCid: null,
    animeCid: null,
    createdAt: "2026-10-23T00:00:00.000Z",
  });

  /** 两把不同的合法密钥（64 位 hex），模拟「密钥被换掉」。 */
  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);

  it("密钥更换后不抛：解不开的盘被跳过，换回原密钥立刻全好", async () => {
    const path = tmpDb();

    // 用密钥 A 写入两块盘
    process.env.MEDIA_TRACK_CREDENTIAL_KEY = KEY_A;
    const writer = createSqliteWorkflowRepository({ path });
    await writer.upsertConnectedStorage(storageRow("cs_dead", "AA11111111111111111111"));
    await writer.upsertConnectedStorage(storageRow("cs_alive", "BB22222222222222222222"));
    await writer.close?.();

    // 先钉死「磁盘上确实是密文」——防止将来有人靠「不加密」把降级逻辑弄绿
    const raw = new Database(path);
    const onDisk = raw
      .prepare("SELECT payload FROM connected_storages WHERE id = 'cs_dead'")
      .get() as { payload: string };
    expect(onDisk.payload.startsWith(ENC_PREFIX)).toBe(true);
    expect(onDisk.payload).not.toContain("topsecret-value");
    raw.close();

    // 换密钥 B 再开库：密文解不开。这里必须降级而不是抛。
    process.env.MEDIA_TRACK_CREDENTIAL_KEY = KEY_B;
    const reader = createSqliteWorkflowRepository({ path });
    await expect(reader.listConnectedStorages("acct_default")).resolves.toEqual([]);
    expect(await reader.listConnectedStorages("acct_default")).toEqual([]);

    // 仓储没有变成废铁：换回密钥 A 立刻全好
    process.env.MEDIA_TRACK_CREDENTIAL_KEY = KEY_A;
    const back = createSqliteWorkflowRepository({ path });
    expect((await back.listConnectedStorages("acct_default")).map((s) => s.id).sort()).toEqual([
      "cs_alive",
      "cs_dead",
    ]);
    await back.close?.();
    await reader.close?.();
  });
});
