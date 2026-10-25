import { describe, expect, it, vi } from "vitest";
import {
  ELECTRON_ABI,
  rebuildBundledSqliteForElectron,
  resolveBundledSqliteDir,
} from "../after-pack.js";

/**
 * 任务单 S2.4（P18/P11）：桌面端打包对 better-sqlite3 的原生 ABI 偷换，从
 * 「README 里一步手动 npx + 靠人眼验证」升级为 afterPack 自动执行 + 强制验证。
 * 验证必须能杀死那个 silent no-op 失败模式（@electron/rebuild 假成功前科）。
 */
describe("resolveBundledSqliteDir", () => {
  it("darwin：.app/Contents/Resources/app 下 standalone 的拷贝", () => {
    expect(resolveBundledSqliteDir("/out", "darwin", "Mediary Scout")).toBe(
      "/out/Mediary Scout.app/Contents/Resources/app/apps/web/.next/standalone/node_modules/better-sqlite3",
    );
  });

  it("win/linux：<out>/resources/app 下 standalone 的拷贝", () => {
    expect(resolveBundledSqliteDir("/out", "win32", "Mediary Scout")).toBe(
      "/out/resources/app/apps/web/.next/standalone/node_modules/better-sqlite3",
    );
    expect(resolveBundledSqliteDir("/out", "linux", "Mediary Scout")).toBe(
      "/out/resources/app/apps/web/.next/standalone/node_modules/better-sqlite3",
    );
  });
});

describe("rebuildBundledSqliteForElectron", () => {
  const dir = "/bundle/better-sqlite3";
  const electronBin = "/path/to/electron";

  /** 哈希 mock：默认第一次 before、第二次 after（模拟二进制被换掉）。 */
  function changingHash(over: { before?: string; after?: string } = {}) {
    let call = 0;
    return vi.fn(() => (call++ === 0 ? (over.before ?? "before") : (over.after ?? "after")));
  }

  function deps(over: Record<string, unknown> = {}) {
    return {
      dir,
      electronVersion: "33.4.11",
      electronBin,
      /** prebuild-install 的 bin 入口（注入以便断言） */
      prebuildInstallBin: "/node_modules/prebuild-install/bin.js",
      exec: vi.fn(() => Buffer.from("")),
      hashFile: changingHash(),
      exists: () => true,
      log: vi.fn(),
      ...over,
    };
  }

  /** exec mock：prebuild-install 调用返回空，electron 验证调用返回给定 ABI。 */
  function execWithAbi(abi: string) {
    return vi.fn((_cmd: string, args: string[]) =>
      args.some((a) => String(a).includes("prebuild-install")) ? Buffer.from("") : Buffer.from(abi),
    );
  }

  it("用 prebuild-install 抓 Electron ABI 预编译二进制（免工具链）", async () => {
    const exec = execWithAbi(String(ELECTRON_ABI));
    await rebuildBundledSqliteForElectron(deps({ exec }) as never);
    // 第一次 exec = prebuild-install；且带了 -r electron -t <version>
    const [cmd, args, opts] = exec.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(cmd).toBe("node");
    expect(args[0]).toBe("/node_modules/prebuild-install/bin.js");
    expect(args).toContain("-r");
    expect(args).toContain("electron");
    expect(args).toContain("-t");
    expect(args).toContain("33.4.11");
    expect(opts.cwd).toBe(dir);
  });

  it("二进制没换掉（silent no-op）→ 抛错，绝不静默放行", async () => {
    await expect(
      rebuildBundledSqliteForElectron(deps({ hashFile: changingHash({ before: "same", after: "same" }) }) as never),
    ).rejects.toThrow(/did not change/i);
  });

  it("换成功后用 Electron-as-node 实加载验证，读到错的 ABI → 抛错", async () => {
    await expect(
      rebuildBundledSqliteForElectron(deps({ exec: execWithAbi("128") }) as never,
      ),
    ).rejects.toThrow(/ABI/i);
  });

  it("验证通过时记录日志并返回替换后的哈希", async () => {
    const log = vi.fn();
    const result = await rebuildBundledSqliteForElectron(deps({ exec: execWithAbi(String(ELECTRON_ABI)), log }) as never);
    expect(result.hash).toBe("after");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("130"));
  });

  it("ELECTRON_ABI 与 electron 33 的 modules 版本一致（130）", () => {
    expect(ELECTRON_ABI).toBe(130);
  });
});
