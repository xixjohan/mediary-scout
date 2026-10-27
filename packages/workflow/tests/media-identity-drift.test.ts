import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
/** media-identity.ts 自身：正则与格式字面量的合法归宿。 */
const MODULE = "packages/workflow/src/media-identity.ts";
/** 不检查的目录：测试自己、构建产物、文档、站点、worker。 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".git", "docs", "site", "workers"]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * 漂移守护：**除 media-identity.ts 外，生产源码里不得再出现 id 格式的模板字面量或解析正则。**
 *
 * 对应规格验收标准第 1 条——「迁移完成的判据是 grep 归零，不是新模块存在」。没有它，
 * 只加模块不换调用点也能让全部测试绿（假绿），而漂移正是本任务要防的东西：今天
 * `demo-candidates.ts` 与 `workflow-runtime.ts` 已经在用同一格式的两份不同正则。
 *
 * ## 为什么排除测试文件
 *
 * 测试夹具里的字面量（`replace-request.test.ts` 一家约 40 处）**是有意的独立金丝雀**，
 * 不是漏迁。若测试也全部改用 builder，那么一旦 builder 的格式改了，夹具会跟着静默改，
 * 没有任何东西能发现「wire format 变了」——而那会换掉四张表的 title_key 主键。
 * 保留字面量意味着格式一变，这批测试立刻红。
 *
 * 真正的格式守护是 `media-identity.test.ts` 的「格式契约」一条：它显式断言
 * `buildTitleId(...)` 等于字面量 `"tmdb_tv_283428"`。格式一变它立刻红，那才会推动
 * 人去核对四张表的 title_key。
 *
 * （曾经还有一条「金丝雀仍在」的测试，断言夹具里仍存在字面量；已撤掉——它只在**全部**
 * 夹具同时被迁移时才红，是弱哨兵而非守护，留着比不留更危险。）
 */
describe("媒体身份格式只存在于 media-identity.ts（生产源码）", () => {
  const offenders = sourceFiles(join(ROOT, "packages"), [])
    .concat(sourceFiles(join(ROOT, "apps", "web"), []))
    .filter((f) => relative(ROOT, f) !== MODULE)
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const hits: string[] = [];
      // 模板字面量：`tmdb_tv_${...}` / `tmdb_movie_${...}`
      for (const m of text.matchAll(/`tmdb_(?:tv|movie)_\$\{/g)) hits.push(m[0]);
      // 解析正则：/^tmdb_(tv|movie)_/  ...
      for (const m of text.matchAll(/\/\^?tmdb_(?:tv|movie)[_(-]/g)) hits.push(m[0]);
      return hits.map((hit) => `${relative(ROOT, file)}: ${hit}`);
    });

  it("**一个都没有**（有的话说明又有人在模块外造/解析 id，漂移重新开始）", () => {
    expect(offenders).toEqual([]);
  });

});
