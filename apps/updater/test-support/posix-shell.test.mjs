import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARGV_NEWLINE_SKIP_REASON,
  POSIX_MODE_SKIP_REASON,
  SHELL_SUITE_TIMEOUT_MS,
  SH_BIN,
  argvCarriesNewlines,
  pathWithStubs,
  posixModeAssertable,
  toPosixPath,
} from "./posix-shell.mjs";

/**
 * 跨平台测试适配层的单元测试 + **同类缺陷门禁**。
 *
 * 缺陷原型（2026-11-17 实测）：`run-update.test.mjs` 用
 * `${bin}:${process.env.PATH}` 拼桩目录。Windows 上 `bin` 是 `E:\...`，Git-Bash
 * 的 `sh` 按 `:` 切分后得到 `E`、`\Work...` 碎片 → 桩目录不可见 → 「打桩的测试」
 * 实际调用宿主机真 `docker`/`git`，表现为随机退出码与 60s 超时（12 条红）。
 *
 * 修好之后要防复发：**任何测试都不得自己拼 PATH 前缀、不得直接 exec .sh**。
 * 下面两条静态断言扫源码——这两类写法一旦重新出现，就是同一类缺陷回来了。
 */
describe("posix-shell 适配层", () => {
  it("toPosixPath 把盘符路径转成 /c/... 形态，已是 POSIX 则不动", () => {
    expect(toPosixPath("E:\\WorkProject\\x")).toBe("/e/WorkProject/x");
    expect(toPosixPath("C:\\Users\\hlr\\AppData")).toBe("/c/Users/hlr/AppData");
    expect(toPosixPath("/e/WorkProject/x")).toBe("/e/WorkProject/x");
    expect(toPosixPath("/tmp/a")).toBe("/tmp/a");
  });

  it("pathWithStubs 把桩目录前置，保留基础 PATH（由 shell 自己翻译分隔符）", () => {
    const result = pathWithStubs("E:\\tmp\\bin", "BASE");
    if (process.platform === "win32") {
      expect(result).toBe("/e/tmp/bin:BASE");
    } else {
      expect(result).toBe("E:\\tmp\\bin:BASE");
    }
    expect(pathWithStubs("/x/bin", "BASE")).toBe("/x/bin:BASE");
  });

  it("平台谓词与跳过原因一致（原因文案不能脱离谓词单独存在）", () => {
    expect(typeof posixModeAssertable()).toBe("boolean");
    expect(typeof argvCarriesNewlines()).toBe("boolean");
    expect(POSIX_MODE_SKIP_REASON).toContain("权限位");
    expect(ARGV_NEWLINE_SKIP_REASON).toContain("换行");
    // Windows 上超时必须更大（进程派生贵一到两个数量级）；Linux 保持 60s。
    expect(SHELL_SUITE_TIMEOUT_MS).toBe(process.platform === "win32" ? 300_000 : 60_000);
  });

  it("SH_BIN 必须是裸命令名（绝对路径的 Git sh 会重置 PATH 头部、让桩失效）", () => {
    expect(SH_BIN).toBe("sh");
    expect(SH_BIN.includes(":" ) && SH_BIN.includes("\\")).toBe(false);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本文件包含「缺陷写法」的正则字面量本身，必须排除在自扫描之外。 */
const SELF = "posix-shell.test.mjs";
const TEST_FILES = readdirSync(HERE)
  .filter((name) => name.endsWith(".test.mjs") && name !== SELF)
  .map((name) => ({ name, source: readFileSync(join(HERE, name), "utf8") }));

describe("同类缺陷门禁：测试不得自行拼 PATH / 直接 exec .sh", () => {
  it("没有测试再用 `${bin}:${process.env.PATH}` 这种拼法", () => {
    // 精确匹配「模板串里直接前置 Windows 形态目录」的写法；走 pathWithStubs 的不受影响。
    const offenders = TEST_FILES.filter(({ source }) =>
      /`\$\{bin\}:\$\{process\.env\.PATH/.test(source) || /\$\{stubBin\}:\$\{process\.env\.PATH/.test(source),
    ).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("没有测试直接 spawn/spawnSync 一个 .sh 文件（必须先经 SH_BIN）", () => {
    // 允许：spawn(SH_BIN, [...]) / spawnSync(SH_BIN, [...])。禁止第一参数就是变量
    // 且该变量在 setup 里被赋成 .sh 路径——这里用「第一参数不是 sh 也不是 SH_BIN」判。
    const allowed = /(spawn|spawnSync)\(\s*(SH_BIN|"sh")\s*,/;
    const offenders = TEST_FILES.filter(({ source }) => {
      const calls = source.match(/(spawn|spawnSync)\(\s*[^,)]+,\s*\[/g) ?? [];
      return calls.some((call) => !allowed.test(call)) && !calls.every((call) => allowed.test(call));
    }).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("环境变量类断言（chmod 语义）不在 Windows 上报红，而是显式分支", () => {
    const offenders = TEST_FILES.filter(({ source }) => {
      // 裸的 `expect(statSync(...).mode & 0o777)` 断言即为「未做平台裁决」。
      const raw = /expect\([^\n]*statSync\([^\n]*\.mode & 0o777/.test(source);
      return raw && !source.includes("posixModeAssertable");
    }).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
