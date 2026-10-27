import { describe, it, expect } from "vitest";
import { readFileSync, accessSync, constants } from "node:fs";
import { pickFreePort, waitForHealthy, buildServerEnv, httpProbe, resolveServerEntry } from "../src/server-launch.js";

describe("pickFreePort", () => {
  it("returns a usable positive port", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe("buildServerEnv", () => {
  it("sets SQLite path, loopback host, port, and run-as-node", () => {
    const env = buildServerEnv({ port: 4123, sqlitePath: "/data/app.db", baseEnv: { EXISTING: "keep" } });
    expect(env.MEDIA_TRACK_SQLITE_PATH).toBe("/data/app.db");
    expect(env.PORT).toBe("4123");
    expect(env.HOSTNAME).toBe("127.0.0.1");
    // 巡检零点 bug 的源头特例已退役：per-slot 认领语义下桌面无需任何调度 flag。
    expect(env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.MEDIA_TRACK_DESKTOP).toBe("1"); // desktop shell identity → honest PanSou copy
    expect(env.EXISTING).toBe("keep"); // preserves the base env
  });

  it("defaults to the real-product adapters so the desktop is functional (not fake/demo)", () => {
    // Without these, the spawned server uses the fake storage executor + demo search
    // (adapter defaults to "fake"). Match the container's docker-compose adapters so a
    // fresh desktop performs real 115/quark/guangya acquisitions once a drive is added.
    const env = buildServerEnv({ port: 1, sqlitePath: "/x.db", baseEnv: {} });
    expect(env.MEDIA_TRACK_SEARCH_PROVIDER).toBe("tmdb");
    expect(env.MEDIA_TRACK_WORKFLOW_ADAPTER).toBe("pansou");
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("115");
    expect(env.MEDIA_TRACK_AGENT_ADAPTER).toBe("vercel-ai"); // required when storage=115 (validateRuntimeConfig)
  });

  it("lets the launching env override an adapter default, but never the desktop-essential keys", () => {
    const env = buildServerEnv({
      port: 9,
      sqlitePath: "/x.db",
      baseEnv: {
        MEDIA_TRACK_STORAGE_ADAPTER: "fake", // a dev may force fake mode
        MEDIA_TRACK_SQLITE_PATH: "/hijack.db", // must NOT win over the desktop path
        PORT: "1234", // must NOT win over the chosen port
      },
    });
    expect(env.MEDIA_TRACK_STORAGE_ADAPTER).toBe("fake"); // override honored
    expect(env.MEDIA_TRACK_SQLITE_PATH).toBe("/x.db"); // essential key wins
    expect(env.PORT).toBe("9"); // essential key wins
  });
});

describe("waitForHealthy", () => {
  it("resolves once the probe returns true", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 20);
    await expect(waitForHealthy({ probe: async () => ready, timeoutMs: 500, intervalMs: 5 })).resolves.toBeUndefined();
  });
  it("rejects when the probe never becomes true before the timeout", async () => {
    await expect(waitForHealthy({ probe: async () => false, timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(/timed out/);
  });
  it("treats a throwing probe as not-ready (does not reject early)", async () => {
    let calls = 0;
    const probe = async () => { calls++; if (calls < 3) throw new Error("connrefused"); return true; };
    await expect(waitForHealthy({ probe, timeoutMs: 500, intervalMs: 5 })).resolves.toBeUndefined();
  });
});

describe("httpProbe", () => {
  it("returns false for an unreachable host", async () => {
    const probe = httpProbe("http://127.0.0.1:1/");
    await expect(probe()).resolves.toBe(false);
  });
});

describe("resolveServerEntry", () => {
  it("points at the packaged resources path when packaged", () => {
    expect(resolveServerEntry({ isPackaged: true, resourcesPath: "/App/Contents/Resources", repoRoot: "/repo" }))
      .toBe("/App/Contents/Resources/app/apps/web/server.js");
  });
  it("points at the local standalone build in dev", () => {
    expect(resolveServerEntry({ isPackaged: false, resourcesPath: "/x", repoRoot: "/repo" }))
      .toBe("/repo/apps/web/.next/standalone/apps/web/server.js");
  });
});

describe("scripts/run-local-real.sh — 与产品真相保持一致", () => {
  /**
   * 为什么有这条：本地起真实实例的适配器值，曾经是手抄的，而且抄错了——抄成了
   * dev/e2e 那套 fake + demo（`MEDIA_TRACK_AGENT_ADAPTER=fake`、
   * `MEDIA_TRACK_SEARCH_PROVIDER=demo`）。后果是搜索只在 3 条硬编码样本里匹配，
   * 用户搜「奥特曼」得到「没有匹配结果」，看起来像功能坏了，其实是配置抄错。
   *
   * 产品真相就在上面的 `buildServerEnv` 里（桌面端与容器都用它）。所以这里不让
   * 脚本自己声明「我用的是真实配置」——那样它说了算，迟早又漂移——而是拿脚本的
   * 默认值跟 buildServerEnv 逐项比对。任何一侧改了另一侧没改，这条就红。
   *
   * 脚本仍允许用环境变量覆盖单个适配器（开发时可能要强制 fake 模式），parity 钉
   * 的是**默认值**，不是禁止覆盖。
   */
  const SCRIPT = new URL("../../../scripts/run-local-real.sh", import.meta.url);

  it("脚本存在、可执行、且是 fail-fast 的 sh", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src.startsWith("#!/bin/sh")).toBe(true);
    expect(src).toMatch(/^set -eu$/m);
    expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
  });

  it("适配器默认值与 buildServerEnv 逐项相同（搜索/工作流/存储/agent 四项）", () => {
    const productEnv = buildServerEnv({ port: 1, sqlitePath: "/x.db", baseEnv: {} });
    const src = readFileSync(SCRIPT, "utf8");

    // 只认 `NAME="${NAME:-default}"` 这一种写法：显式默认值，且可被环境变量覆盖。
    const scriptDefaults = new Map<string, string>();
    const re = /^MEDIA_TRACK_([A-Z0-9_]+)="\$\{MEDIA_TRACK_[A-Z0-9_]+:-([a-z0-9-]+)\}"$/gm;
    for (const m of src.matchAll(re)) scriptDefaults.set(m[1], m[2]);

    const keys = ["SEARCH_PROVIDER", "WORKFLOW_ADAPTER", "STORAGE_ADAPTER", "AGENT_ADAPTER"] as const;
    for (const key of keys) {
      const product = productEnv[`MEDIA_TRACK_${key}`];
      const script = scriptDefaults.get(key);
      expect(script, `脚本缺少 MEDIA_TRACK_${key} 的默认值`).toBeDefined();
      expect(script, `MEDIA_TRACK_${key} 与产品真相（server-launch.ts）漂移了`).toBe(product);
    }
    // 四项都得真的是「真实配置」——尤其 agent 必须是 vercel-ai：storage=115 或
    // workflow=pansou 时 validateRuntimeConfig 会直接拒启，而 fake 会让 worker
    // 永远排不干队列（那种错配是静默的，比启动失败更难发现）。
    expect(scriptDefaults.get("AGENT_ADAPTER")).toBe("vercel-ai");
    expect(scriptDefaults.get("SEARCH_PROVIDER")).toBe("tmdb");
    expect(scriptDefaults.get("SEARCH_PROVIDER")).not.toBe("demo");
  });
});
