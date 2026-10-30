import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/storage/credential-store.js";
import type { MediaryDatabase } from "../../src/persistence/db-schema.js";
import { SQLITE_SCHEMA } from "../../src/persistence/sqlite.js";
import type { UpsertConnectedStorageText } from "../../src/storage/credential-store.js";

/**
 * CredentialStore（任务单 S1.6）：凭据相关持久化切片整体迁到 Kysely
 * 类型安全查询构建器。行为契约与迁移前完全一致——这里把最容易回退的
 * 语义钉死：设置 upsert、跨账号冲突 no-op、同账号刷新、状态/删除。
 */
function store() {
  const db = new Database(":memory:");
  db.exec(SQLITE_SCHEMA);
  return new CredentialStore(new Kysely<MediaryDatabase>({ dialect: new SqliteDialect({ database: db }) }));
}

const storage = (over: Partial<UpsertConnectedStorageText> = {}): UpsertConnectedStorageText => ({
  id: "cs_1",
  accountId: "acct_default",
  provider: "pan115",
  providerUid: "100000001",
  label: null,
  payloadText: JSON.stringify({ cookie: "UID=1" }),
  rootCid: "r",
  moviesCid: "m",
  tvCid: "t",
  animeCid: "a",
  createdAt: "2026-10-23T00:00:00.000Z",
  ...over,
});

describe("CredentialStore（Kysely 迁移切片）", () => {
  it("全局设置：写、读、覆盖写（upsert 语义）", async () => {
    const s = store();
    expect(await s.getGlobalSetting("daily_sweep_time")).toBeNull();
    await s.setGlobalSetting("daily_sweep_time", "06:00");
    await s.setGlobalSetting("daily_sweep_time", "21:30"); // 覆盖，不是报错
    expect(await s.getGlobalSetting("daily_sweep_time")).toBe("21:30");
  });

  it("账号设置：按 (account, key) 隔离 + upsert", async () => {
    const s = store();
    await s.setAccountSetting("acct_a", "quality_preference", "4K");
    await s.setAccountSetting("acct_b", "quality_preference", "1080p");
    await s.setAccountSetting("acct_a", "quality_preference", "medium");
    expect(await s.getAccountSetting("acct_a", "quality_preference")).toBe("medium");
    expect(await s.getAccountSetting("acct_b", "quality_preference")).toBe("1080p");
    expect(await s.getAccountSetting("acct_c", "quality_preference")).toBeNull();
  });

  it("connected_storages upsert：同 (provider, uid) 跨账号冲突是 no-op（所有权铁律）", async () => {
    const s = store();
    await s.upsertConnectedStorage(storage({ id: "cs_a", accountId: "acct_a", payloadText: JSON.stringify({ cookie: "A" }) }));
    // acct_b 试图绑定同一物理盘：绝不能偷占或覆盖
    await s.upsertConnectedStorage(storage({ id: "cs_b", accountId: "acct_b", payloadText: JSON.stringify({ cookie: "EVIL" }) }));
    const found = await s.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.accountId).toBe("acct_a");
    expect(found?.payload).toBe(JSON.stringify({ cookie: "A" }));
    expect(await s.listConnectedStorages("acct_b")).toHaveLength(0);
  });

  it("connected_storages upsert：同账号重新绑定刷新 payload 与 CIDs", async () => {
    const s = store();
    await s.upsertConnectedStorage(storage());
    await s.upsertConnectedStorage(
      storage({ payloadText: JSON.stringify({ cookie: "NEW" }), rootCid: "r2", moviesCid: null, label: "我的盘" }),
    );
    const found = await s.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.id).toBe("cs_1");
    expect(found?.payload).toBe(JSON.stringify({ cookie: "NEW" }));
    expect(found?.rootCid).toBe("r2");
    expect(found?.moviesCid).toBeNull();
    expect(found?.label).toBe("我的盘");
    expect(await s.listConnectedStorages("acct_default")).toHaveLength(1);
  });

  it("upsert 保留 frozen 状态（重扫不解除冻结）", async () => {
    const s = store();
    await s.upsertConnectedStorage(storage());
    await s.setConnectedStorageStatus("cs_1", "frozen", "cookie died", "2026-10-23T01:00:00.000Z");
    await s.upsertConnectedStorage(storage({ payloadText: JSON.stringify({ cookie: "rescanned" }) }));
    const found = await s.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.status).toBe("frozen");
    expect(found?.frozenReason).toBe("cookie died");
    expect(found?.payload).toBe(JSON.stringify({ cookie: "rescanned" }));
  });

  it("setConnectedStorageStatus：active ⇄ frozen 及原因/时间戳", async () => {
    const s = store();
    await s.upsertConnectedStorage(storage());
    await s.setConnectedStorageStatus("cs_1", "frozen", "logged out", "2026-10-23T02:00:00.000Z");
    let found = await s.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.status).toBe("frozen");
    expect(found?.frozenReason).toBe("logged out");
    expect(found?.frozenAt).toBe("2026-10-23T02:00:00.000Z");
    await s.setConnectedStorageStatus("cs_1", "active", null, null);
    found = await s.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.status).toBe("active");
    expect(found?.frozenReason).toBeNull();
    expect(found?.frozenAt).toBeNull();
  });

  it("deleteConnectedStorage：按 (id, account) 删，删错账号不动", async () => {
    const s = store();
    await s.upsertConnectedStorage(storage());
    expect(await s.deleteConnectedStorage("cs_1", "acct_other")).toBe(false);
    expect(await s.findConnectedStorageByUid("pan115", "100000001")).not.toBeNull();
    expect(await s.deleteConnectedStorage("cs_1", "acct_default")).toBe(true);
    expect(await s.findConnectedStorageByUid("pan115", "100000001")).toBeNull();
  });

  it("listConnectedStorages 按 created_at 排序；hasAny 反映空/非空", async () => {
    const s = store();
    expect(await s.hasAnyConnectedStorage()).toBe(false);
    // 两个不同的物理盘（uid 不同才会是两行；同 uid 同账号会冲突合并）
    await s.upsertConnectedStorage(storage({ id: "cs_old", providerUid: "1", createdAt: "2026-01-01T00:00:00.000Z" }));
    await s.upsertConnectedStorage(storage({ id: "cs_new", providerUid: "2", createdAt: "2026-12-01T00:00:00.000Z" }));
    const list = await s.listConnectedStorages("acct_default");
    expect(list.map((r) => r.id)).toEqual(["cs_old", "cs_new"]);
    expect(await s.hasAnyConnectedStorage()).toBe(true);
  });
});
