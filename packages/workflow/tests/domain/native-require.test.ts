import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeRequire } from "../../src/native-require.js";

const SRC = join(__dirname, "..", "..", "src");

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
});

/**
 * workflow 包版本的守护测试，与 packages/shared/src/native-require.test.ts 同一条不变量、
 * 同一段理由（那里写了完整版）。两个包各一份是因为依赖方向是 shared ← workflow，
 * shared 不能反向引用；不变量本身必须两边都把守。
 *
 * 这条测试直接对应一个真实事故：sqlite.ts 与 sqlite-json-cache.ts 都带着 S4.3 的注释
 * 「静态 node:fs 会炸 Turbopack 客户端 chunk」，也都懒加载了 node:fs——但第 1 行的
 * `import { createRequire } from "node:module"` 从没被删掉，所以 `npm run build:web`
 * 一直红到今天。修好后（本包 2 处 + shared 包 2 处 node:module、1 处 node:fs）构建转绿，
 * 并用生产服务实测了设置页渲染。
 */
describe("workflow 源码不静态 import node:module / node:fs / node:path", () => {
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
