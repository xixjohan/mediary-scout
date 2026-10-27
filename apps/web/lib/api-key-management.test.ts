import { describe, expect, it } from "vitest";
import {
  clearApiKey,
  readApiKeyState,
  rotateApiKey,
  type ApiKeyManagementStore,
} from "./api-key-management";

/**
 * S5.5 TDD：设置页 API Key 管理状态机。
 *
 * 三态读取（db / env / none）+ 轮换（生成或显式值写 DB）+ 清除
 * （DB 态可清；env 态拒绝——页面改不了部署期注入的值，只能告知用户）。
 * store 是端口（内存实现），不碰 SQLite。
 */

const ENV = { MEDIA_TRACK_API_KEY: "sk-env-secret-value-0001" } as Record<string, string | undefined>;
const ENV_EMPTY = {} as Record<string, string | undefined>;

function memoryStore(initial: string | null = null) {
  let value = initial;
  const store: ApiKeyManagementStore & { calls: string[] } = {
    calls: [],
    get: async () => value,
    set: async (next: string) => {
      store.calls.push(`set:${next}`);
      value = next;
    },
    clear: async () => {
      store.calls.push("clear");
      value = null;
    },
  };
  return store;
}

describe("readApiKeyState 三态", () => {
  it("DB 有值 → origin=db、掩码只露末 4 位", async () => {
    const state = await readApiKeyState(ENV, memoryStore("sk-db-1234"));
    expect(state).toEqual({ origin: "db", masked: "••••1234", configured: true });
  });

  it("只有 env → origin=env、同样给掩码（UI 据此禁清除）", async () => {
    const state = await readApiKeyState(ENV, memoryStore(null));
    expect(state).toEqual({ origin: "env", masked: "••••0001", configured: true });
  });

  it("都没有 → origin=none、masked=null", async () => {
    const state = await readApiKeyState(ENV_EMPTY, memoryStore(null));
    expect(state).toEqual({ origin: "none", masked: null, configured: false });
  });

  it("DB 空串视为清除 → 回落 env（与 resolveApiKey 同语义）", async () => {
    const state = await readApiKeyState(ENV, memoryStore("   "));
    expect(state.origin).toBe("env");
  });
});

describe("rotateApiKey 轮换", () => {
  it("无显式值时生成 64 位十六进制并写入 DB", async () => {
    const store = memoryStore(null);
    const result = await rotateApiKey(store);
    expect(result.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.masked).toBe(`••••${result.apiKey.slice(-4)}`);
    expect(result.origin).toBe("db");
    expect(store.calls).toEqual([`set:${result.apiKey}`]);
    // 轮换后立即生效：DB 优先盖过 env
    expect((await readApiKeyState(ENV, store)).origin).toBe("db");
  });

  it("接受显式值（trim 后写入），供「粘贴自己的 key」", async () => {
    const store = memoryStore(null);
    const result = await rotateApiKey(store, "  sk-my-own-key-7777  ");
    expect(result.apiKey).toBe("sk-my-own-key-7777");
    expect(result.masked).toBe("••••7777");
    expect(store.calls).toEqual(["set:sk-my-own-key-7777"]);
  });

  it("轮换覆盖既有 DB 值（旧 key 立即失效）", async () => {
    const store = memoryStore("sk-old-0000");
    const result = await rotateApiKey(store);
    expect(result.apiKey).not.toBe("sk-old-0000");
    expect(await store.get()).toBe(result.apiKey);
  });

  it("显式空串/空白 → 仍然生成（不把空值写进库）", async () => {
    const store = memoryStore(null);
    const result = await rotateApiKey(store, "   ");
    expect(result.apiKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clearApiKey 清除", () => {
  it("DB 态 → 清库成功，回到 none", async () => {
    const store = memoryStore("sk-db-1234");
    const result = await clearApiKey(ENV_EMPTY, store);
    expect(result).toEqual({ cleared: true, origin: "none", masked: null });
    expect(store.calls).toEqual(["clear"]);
  });

  it("DB 态但 env 也有值 → 清 DB 后回落到 env（不锁死实例）", async () => {
    const store = memoryStore("sk-db-1234");
    const result = await clearApiKey(ENV, store);
    expect(result).toEqual({ cleared: true, origin: "env", masked: "••••0001" });
  });

  it("env 态 → 拒绝清除且不碰库（页面改不了部署期注入的值）", async () => {
    const store = memoryStore(null);
    const result = await clearApiKey(ENV, store);
    expect(result).toEqual({ cleared: false, reason: "env-backed" });
    expect(store.calls).toEqual([]);
  });

  it("none 态 → 幂等成功", async () => {
    const store = memoryStore(null);
    const result = await clearApiKey(ENV_EMPTY, store);
    expect(result).toEqual({ cleared: true, origin: "none", masked: null });
  });
});

/**
 * L1（逐维核查补缺）：显式值没有长度下限——`POST {apiKey:"a"}` 会把一个
 * 1 字符的长期凭据写进库，而 generateApiKey() 生成的是 64 位十六进制。
 * 路由层同样没有校验，端到端能把弱 key 设成实例凭据。
 */
describe("rotateApiKey — 显式值强度下限（L1）", () => {
  /** 单值存储（端口语义：get/set/clear 都不带 key 参数），外加可观测的 values。 */
  const store = () => {
    let value: string | null = null;
    const seen: string[] = [];
    return {
      seen,
      get value() {
        return value;
      },
      get: async () => value,
      set: async (next: string) => {
        seen.push(`set:${next}`);
        value = next;
      },
      clear: async () => {
        seen.push("clear");
        value = null;
      },
    };
  };

  it("过短的显式值（<16）被拒，不写库", async () => {
    const s = store();
    await expect(rotateApiKey(s, "abc")).rejects.toThrow(/太短|长度/);
    expect(s.seen).toEqual([]);
    expect(s.value).toBeNull();
  });

  it("16 位及以上显式值被接受", async () => {
    const s = store();
    const result = await rotateApiKey(s, "0123456789abcdef");
    expect(result.apiKey).toBe("0123456789abcdef");
    expect(result.origin).toBe("db");
  });

  it("不显式给值时照旧生成 64 位（不受下限影响）", async () => {
    const s = store();
    const result = await rotateApiKey(s);
    expect(result.apiKey).toHaveLength(64);
  });
});
