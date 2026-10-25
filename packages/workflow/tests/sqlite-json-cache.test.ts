import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteJsonCache,
  openSqliteJsonCache,
  type DurableJsonCache,
  type MediaSearchCache,
} from "../src/index.js";

/**
 * SqliteJsonCache 契约测试（任务单 S1.4b）：纯 SQLite 替代
 * PostgresMediaSearchCache 的持久化 JSON 缓存。语义与 PG 版一致：
 * 键归一化、TTL 过期懒删、定期清扫、读写克隆。
 */
describe("SqliteJsonCache", () => {
  it("同时满足 MediaSearchCache 与 DurableJsonCache 两个端口", () => {
    const cache = new SqliteJsonCache(new Database(":memory:"));
    const asMedia: MediaSearchCache = cache;
    const asDurable: DurableJsonCache = cache;
    expect(typeof asMedia.get).toBe("function");
    expect(typeof asDurable.getJson).toBe("function");
  });

  it("get/set  roundtrip，键按 trim+lowercase 归一化", async () => {
    const cache = new SqliteJsonCache(new Database(":memory:"));
    const candidates = [{ id: "c1" }];
    await cache.set("  Re:ZERO ", candidates as never);
    expect(await cache.get("re:zero")).toEqual(candidates);
    expect(await cache.get("RE:ZERO")).toEqual(candidates);
  });

  it("getJson 未命中返回 null；setJson 后按原名键 roundtrip", async () => {
    const cache = new SqliteJsonCache(new Database(":memory:"));
    expect(await cache.getJson("series-target:1396")).toBeNull();
    await cache.setJson("series-target:1396", { seasons: [1, 2] });
    expect(await cache.getJson("series-target:1396")).toEqual({ seasons: [1, 2] });
  });

  it("过期条目读时懒删并返回 null", async () => {
    const db = new Database(":memory:");
    const cache = new SqliteJsonCache(db);
    await cache.setJson("k", { v: 1 });
    db.prepare("UPDATE tmdb_search_cache SET expires_at = ? WHERE cache_key = 'k'").run(Date.now() - 1);
    expect(await cache.getJson("k")).toBeNull();
    const left = db.prepare("SELECT COUNT(*) AS n FROM tmdb_search_cache").get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("同键 upsert 覆盖 payload 与过期时间", async () => {
    const db = new Database(":memory:");
    const cache = new SqliteJsonCache(db);
    await cache.setJson("k", { v: 1 }, 60_000);
    await cache.setJson("k", { v: 2 }, 120_000);
    expect(await cache.getJson("k")).toEqual({ v: 2 });
    const row = db.prepare("SELECT expires_at FROM tmdb_search_cache WHERE cache_key = 'k'").get() as {
      expires_at: number;
    };
    expect(row.expires_at).toBeGreaterThan(Date.now() + 100_000);
  });

  it("首次 setJson 触发清扫：过期行被清，新鲜行保留", async () => {
    const db = new Database(":memory:");
    const cache = new SqliteJsonCache(db);
    db.prepare("INSERT INTO tmdb_search_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)")
      .run("stale", "{}", Date.now() - 1);
    db.prepare("INSERT INTO tmdb_search_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)")
      .run("fresh", "{}", Date.now() + 60_000);
    await cache.setJson("new", { v: 1 });
    const keys = db.prepare("SELECT cache_key FROM tmdb_search_cache ORDER BY cache_key").all() as Array<{
      cache_key: string;
    }>;
    expect(keys.map((r) => r.cache_key)).toEqual(["fresh", "new"]);
  });

  it("读写都返回克隆：调用方改对象不污染缓存", async () => {
    const cache = new SqliteJsonCache(new Database(":memory:"));
    const value = { nested: { n: 1 } };
    await cache.setJson("k", value);
    value.nested.n = 999;
    const read = await cache.getJson<{ nested: { n: number } }>("k");
    expect(read?.nested.n).toBe(1);
    if (read) read.nested.n = -1;
    expect((await cache.getJson<{ nested: { n: number } }>("k"))?.nested.n).toBe(1);
  });

  it("openSqliteJsonCache 落盘持久化：重开文件后仍可读", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-json-cache-"));
    const file = join(dir, "cache.db");
    try {
      const first = openSqliteJsonCache(file);
      await first.setJson("persist", { ok: true });
      first.close();

      const second = openSqliteJsonCache(file);
      expect(await second.getJson("persist")).toEqual({ ok: true });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
