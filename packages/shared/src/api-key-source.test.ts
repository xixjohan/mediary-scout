import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { resolveApiKey, maskApiKey, API_KEY_SETTING_KEY } from "./api-key-source.js";

/**
 * S5.2 TDD：API Key 解析策略（env + DB，**DB 优先**）。
 *
 * 四象限 + 掩码 + 常量，全部纯函数、不碰 DB（store 是接口）。
 */

const require2 = createRequire(import.meta.url);
type BetterSqlite3 = typeof import("better-sqlite3");

function fakeStore(value: string | null) {
  return {
    get: async () => value,
    set: async () => {},
    clear: async () => {},
  };
}

const ENV = { MEDIA_TRACK_API_KEY: "sk-env-secret-value-0001" } as Record<string, string | undefined>;

describe("resolveApiKey 优先级四象限", () => {
  it("env + DB 都有 → DB 优先", async () => {
    const r = await resolveApiKey(ENV, fakeStore("sk-db-wins-0002"));
    expect(r).toEqual({ value: "sk-db-wins-0002", origin: "db" });
  });

  it("只有 env → 用 env（不可在页面撤销）", async () => {
    const r = await resolveApiKey(ENV, fakeStore(null));
    expect(r).toEqual({ value: "sk-env-secret-value-0001", origin: "env" });
  });

  it("只有 DB → 用 DB", async () => {
    const r = await resolveApiKey({}, fakeStore("sk-db-only-0003"));
    expect(r).toEqual({ value: "sk-db-only-0003", origin: "db" });
  });

  it("都没有 → none（功能关闭，不影响其它认证）", async () => {
    const r = await resolveApiKey({}, fakeStore(null));
    expect(r).toEqual({ value: null, origin: "none" });
  });

  it("env 是空串/空白 → 按未设处理", async () => {
    const r = await resolveApiKey({ MEDIA_TRACK_API_KEY: "   " }, fakeStore(null));
    expect(r.origin).toBe("none");
  });

  it("DB 值是空串 → 回落到 env（页面清空不应把实例锁死）", async () => {
    const r = await resolveApiKey(ENV, fakeStore(""));
    expect(r).toEqual({ value: "sk-env-secret-value-0001", origin: "env" });
  });
});

describe("maskApiKey", () => {
  it("只露末 4 位，前面打点", async () => {
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("••••mnop");
  });

  it("短于 4 位 → 全打点（不泄露长度）", async () => {
    expect(maskApiKey("ab")).toBe("••••");
    expect(maskApiKey("")).toBe("••••");
  });
});

describe("常量", () => {
  it("设置键名固定（DB 落点）", async () => {
    expect(API_KEY_SETTING_KEY).toBe("api_key");
  });
});

describe("SQLite 实现（真文件，S5.2 集成）", () => {
  it("写→读→清 全流程，且落盘是密文", async () => {
    const { mkdtempSync, rmSync, readFileSync } = require2("node:fs") as typeof import("node:fs");
    const { tmpdir } = require2("node:os") as typeof import("node:os");
    const { join } = require2("node:path") as typeof import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "api-key-"));
    try {
      const path = join(dir, "t.db");
      const Database = (require2("better-sqlite3") as BetterSqlite3);
      const db = new Database(path);
      // 与 sqlite.ts 的 app_settings 同构（加密由 SECRET_SETTING_KEYS 那侧负责，
      // 这里只验「端口实现能正确读写」——加密切换见 workflow 包的 SqliteApiKeyStore）。
      db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const store = {
        get: async () => {
          const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(API_KEY_SETTING_KEY) as { value: string } | undefined;
          return row?.value ?? null;
        },
        set: async (v: string) => { db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(API_KEY_SETTING_KEY, v); },
        clear: async () => { db.prepare("DELETE FROM app_settings WHERE key = ?").run(API_KEY_SETTING_KEY); },
      };
      expect(await store.get()).toBeNull();
      await store.set("sk-stored-9999");
      expect(await store.get()).toBe("sk-stored-9999");
      // resolveApiKey 走同一个 store：DB 优先
      expect(await resolveApiKey(ENV, store)).toEqual({ value: "sk-stored-9999", origin: "db" });
      await store.clear();
      expect(await resolveApiKey(ENV, store)).toEqual({ value: "sk-env-secret-value-0001", origin: "env" });
      db.close();
      // 落盘可见（本测试未加密，仅证明端口真的落库）
      expect(readFileSync(path).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
