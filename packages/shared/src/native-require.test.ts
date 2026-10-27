import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeRequire } from "../src/native-require.js";

const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    // 测试文件不在客户端图里（只由 vitest 跑），不算违规。
    if (entry.name.endsWith(".test.ts")) return [];
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

describe("createNativeRequire", () => {
  it("**真能加载原生模块**（不然这个模块只是个摆设）", () => {
    const require = createNativeRequire(join(SRC, "x.ts"));
    expect(typeof require("better-sqlite3")).toBe("function");
    expect(typeof require("node:fs").mkdirSync).toBe("function");
  });

  it("**解析基准用的是传入的 import.meta.url**", () => {
    const require = createNativeRequire(join(SRC, "y.ts"));
    expect(require.resolve("better-sqlite3")).toContain("better-sqlite3");
  });
});

/**
 * 守护那个让 `npm run build:web` 红了数天的 bug：**shared 包源码里不能有
 * node:module / node:fs / node:path 的静态 import**。
 *
 * ## 为什么静态 import 就够致命
 *
 * `@media-track/shared` 经 barrel 被 workflow 的 sqlite.ts 引用，而 workflow 自己的
 * barrel（`@media-track/workflow` → dist/workflow-scope.js）又被 apps/web 的多个客户端
 * 组件导入。于是这些包里的任何 node: 静态 import 都会成为**客户端 chunk** 的依赖，
 * Turbopack 直接拒掉整个生产构建：
 *
 *   the chunking context (unknown) does not support external modules (request: node:module)
 *
 * 这是部署阻断，而且 `npm run gate` 抓不到——gate 是 layout + deps + eslint，
 * 不含 apps/web 的 tsc，也不含 web 构建。
 *
 * ## 这个不变量被写下过两次，都没有被执行
 *
 * `credential-crypto.ts` 和（workflow 包的）`sqlite-json-cache.ts` 都带着 S4.3 的注释
 * 「静态 node:fs 会炸 Turbopack 客户端 chunk」，也都把 node:fs 改成了调用时 require——
 * 但两者第 1 行都留着 `import { createRequire } from "node:module"`，所以那次修复对
 * 打包器从未生效。`sqlite-backup.ts` 更直接：整文件没有任何消费方，却因为被 barrel
 * 导出而把 node:fs 带进客户端图。
 *
 * 修完之后（node:module × 4 处、node:fs × 1 处，全部改成 native-require 的懒加载），
 * `npm run build:web` 由红转绿，并用生产服务实测了设置页渲染。
 *
 * ## 为什么只列这三个
 *
 * 实测 Turbopack 容忍 node:crypto / node:util（本包和 workflow 包里现存 7 处静态
 * node:crypto/node:util，构建是绿的）。把容忍的也列进去只会让这条测试无缘无故红，
 * 那就没人看了。真正的分界是「能让 CommonJS 加载器或文件系统进入客户端的东西」。
 */
describe("shared 源码不静态 import node:module / node:fs / node:path", () => {
  const FORBIDDEN = ["node:module", "node:fs", "node:path"];
  const offenders = sourceFiles(SRC).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const hits: string[] = [];
    for (const m of text.matchAll(/^\s*import\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?["'](node:[^"']+)["']/gm)) {
      if (FORBIDDEN.includes(m[1]!)) hits.push(m[0].trim());
    }
    for (const m of text.matchAll(/^\s*export\s+[^'"]*?\sfrom\s+["'](node:[^"']+)["']/gm)) {
      if (FORBIDDEN.includes(m[1]!)) hits.push(m[0].trim());
    }
    return hits.map((hit) => `${file.replace(SRC, "src")}: ${hit}`);
  });

  it("**一个都没有**（有的话客户端 chunk 被 node: 依赖污染，生产构建直接失败）", () => {
    expect(offenders).toEqual([]);
  });
});
