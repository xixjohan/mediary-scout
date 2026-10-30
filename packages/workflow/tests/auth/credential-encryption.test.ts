import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ENC_PREFIX } from "@media-track/shared";
import {
  SqliteWorkflowRepository,
  createSqliteWorkflowRepository,
  isSecretSettingKey,
} from "../../src/index.js";

/**
 * 凭据落盘加密（任务单 S1.5，P15）：
 * 仓储边界透明加解密——调用方看到明文，磁盘上是 enc:v1: 密文；
 * 旧明文行仍可读（迁移兼容），写入即完成加密。
 */
describe("凭据加密（SqliteWorkflowRepository 边界）", () => {
  const dirs: string[] = [];
  const tmpDb = () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-enc-"));
    dirs.push(dir);
    return join(dir, "mediary.db");
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.MEDIA_TRACK_CREDENTIAL_KEY;
  });

  const storageRow = (id: string) => ({
    id,
    accountId: "acct_default",
    provider: "pan115",
    providerUid: "100000001",
    label: null,
    payload: { cookie: "UID=103164004_A1_1; CID=99887766; SEID=topsecret" },
    rootCid: "1",
    moviesCid: "2",
    tvCid: "3",
    animeCid: "4",
    createdAt: "2026-10-23T00:00:00.000Z",
  });

  it("connected_storages.payload 落盘即密文，读出来是明文", async () => {
    const path = tmpDb();
    const repo = createSqliteWorkflowRepository({ path });
    await repo.upsertConnectedStorage(storageRow("cs_1"));

    // 绕过仓储直连磁盘：必须是密文，且不含 cookie 明文
    const raw = new Database(path);
    const row = raw.prepare("SELECT payload FROM connected_storages WHERE id = 'cs_1'").get() as {
      payload: string;
    };
    expect(row.payload.startsWith(ENC_PREFIX)).toBe(true);
    expect(row.payload).not.toContain("UID=103164004");
    expect(row.payload).not.toContain("topsecret");
    raw.close();

    // 经仓储读：明文 roundtrip
    const found = await repo.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.payload).toEqual({ cookie: "UID=103164004_A1_1; CID=99887766; SEID=topsecret" });
    const list = await repo.listConnectedStorages("acct_default");
    expect(list[0]?.payload).toEqual({ cookie: "UID=103164004_A1_1; CID=99887766; SEID=topsecret" });
    await repo.close?.();
  });

  it("密钥文件与库同目录；第二个进程/仓储实例能解开同一份数据", async () => {
    const path = tmpDb();
    const writer = createSqliteWorkflowRepository({ path });
    await writer.upsertConnectedStorage(storageRow("cs_1"));
    await writer.close?.();

    // 模拟另一个进程（脚本 / worker）打开同一个库
    const reader = createSqliteWorkflowRepository({ path });
    const found = await reader.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.payload).toEqual({ cookie: "UID=103164004_A1_1; CID=99887766; SEID=topsecret" });
    await reader.close?.();
  });

  it("敏感 account setting 落盘即密文；非敏感设置保持明文可读", async () => {
    const path = tmpDb();
    const repo = createSqliteWorkflowRepository({ path });
    await repo.setAccountSetting("acct_default", "llm_api_key", "sk-super-secret");
    await repo.setAccountSetting("acct_default", "llm_base_url", "https://api.example.com/v1");

    const raw = new Database(path);
    const rows = raw
      .prepare("SELECT key, value FROM account_settings ORDER BY key")
      .all() as Array<{ key: string; value: string }>;
    const secret = rows.find((r) => r.key === "llm_api_key");
    const plain = rows.find((r) => r.key === "llm_base_url");
    expect(secret?.value.startsWith(ENC_PREFIX)).toBe(true);
    expect(secret?.value).not.toContain("sk-super-secret");
    expect(plain?.value).toBe("https://api.example.com/v1");
    raw.close();

    expect(await repo.getAccountSetting("acct_default", "llm_api_key")).toBe("sk-super-secret");
    expect(await repo.getAccountSetting("acct_default", "llm_base_url")).toBe("https://api.example.com/v1");
    await repo.close?.();
  });

  it("全局 app_settings 的 cookie / session_secret / push_* 也加密", async () => {
    const path = tmpDb();
    const repo = createSqliteWorkflowRepository({ path });
    await repo.setSetting("pan115.cookie", "UID=abc; CID=1; SEID=xyz");
    await repo.setSetting("session_secret", "signing-secret");
    await repo.setSetting("push_serverchan", "SENDKEY-123");
    await repo.setSetting("daily_sweep_time", "06:00");

    const raw = new Database(path);
    const rows = raw.prepare("SELECT key, value FROM app_settings ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const key of ["pan115.cookie", "session_secret", "push_serverchan"]) {
      const row = rows.find((r) => r.key === key);
      expect(row?.value.startsWith(ENC_PREFIX), `${key} 应加密`).toBe(true);
    }
    expect(rows.find((r) => r.key === "daily_sweep_time")?.value).toBe("06:00");
    raw.close();

    expect(await repo.getSetting("pan115.cookie")).toBe("UID=abc; CID=1; SEID=xyz");
    expect(await repo.getSetting("session_secret")).toBe("signing-secret");
    expect(await repo.getSetting("push_serverchan")).toBe("SENDKEY-123");
    await repo.close?.();
  });

  it("旧明文行（升级前的库）照样读得出来，再写一次即转为密文", async () => {
    const path = tmpDb();
    // 先造一个「升级前」的库：仓储 schema + 明文凭据行
    const legacy = createSqliteWorkflowRepository({ path });
    await legacy.upsertConnectedStorage(storageRow("cs_legacy"));
    await legacy.close?.();
    const raw = new Database(path);
    raw.prepare("UPDATE connected_storages SET payload = ? WHERE id = 'cs_legacy'").run(
      JSON.stringify({ cookie: "UID=legacy; CID=9; SEID=old" }),
    );
    raw.close();

    const repo = createSqliteWorkflowRepository({ path });
    const found = await repo.findConnectedStorageByUid("pan115", "100000001");
    expect(found?.payload).toEqual({ cookie: "UID=legacy; CID=9; SEID=old" });

    // 重写（如重新扫码绑定）→ 落盘转为密文
    await repo.upsertConnectedStorage({ ...storageRow("cs_legacy"), payload: { cookie: "UID=new; CID=9; SEID=new" } });
    const raw2 = new Database(path);
    const row = raw2.prepare("SELECT payload FROM connected_storages WHERE id = 'cs_legacy'").get() as {
      payload: string;
    };
    expect(row.payload.startsWith(ENC_PREFIX)).toBe(true);
    raw2.close();
    await repo.close?.();
  });

  it(":memory: 库（直接构造）也能透明 roundtrip", async () => {
    const repo = new SqliteWorkflowRepository(new Database(":memory:"));
    await repo.upsertConnectedStorage(storageRow("cs_mem"));
    await repo.setSetting("pan115.cookie", "UID=mem; CID=1; SEID=mem");
    expect((await repo.findConnectedStorageByUid("pan115", "100000001"))?.payload).toEqual({
      cookie: "UID=103164004_A1_1; CID=99887766; SEID=topsecret",
    });
    expect(await repo.getSetting("pan115.cookie")).toBe("UID=mem; CID=1; SEID=mem");
  });

  it("isSecretSettingKey 注册表：密钥类加密，配置类不加密", () => {
    for (const key of ["pan115.cookie", "session_secret", "agent_api_token", "llm_api_key", "tmdb_api_key", "assrt_token", "jev_api_key", "prowlarr_api_key", "connect_instance_credential", "connect_tunnel_token", "push_serverchan", "push_bark"]) {
      expect(isSecretSettingKey(key), `${key} 应判为敏感`).toBe(true);
    }
    for (const key of ["daily_sweep_time", "llm_base_url", "llm_model_id", "quality_preference", "auto_update_enabled", "connect_hostname", "pan115.cookieMeta", "jev_base_url"]) {
      expect(isSecretSettingKey(key), `${key} 不应判为敏感`).toBe(false);
    }
  });
});
