import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { STORAGE_BRANDS } from "@media-track/workflow";
import { STORAGE_PROBES } from "./workflow-runtime";

/** apps/web 根目录——结构门禁要按相对路径读源文件。 */
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * 探活表必须对每个已登记品牌都有条目。
 *
 * 表用 `Record<StorageProvider, …>` 声明，往联合类型里加一家网盘而漏掉探活是
 * **编译错误**——这是主要防线。这条运行时断言守住另一半：DB 里出现一个注册表
 * 认识、但这张表因为笔误/动态改动而缺掉的 provider（编译期查不出的情况，比如
 * 表被 Object.assign 扩充过）。
 */
describe("STORAGE_PROBES 覆盖每个已登记品牌", () => {
  it("注册表里每个 provider 都在探活表里", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(
        typeof STORAGE_PROBES[brand.provider],
        `${brand.provider} 登记了却没接探活`,
      ).toBe("function");
    }
  });

  it("探活表没有多余条目（不留下死代码）", () => {
    const registered = new Set(STORAGE_BRANDS.map((b) => b.provider));
    const orphans = Object.keys(STORAGE_PROBES).filter((p) => !registered.has(p as never));
    expect(orphans, `探活表里有注册表不认识的品牌：${orphans.join(", ")}`).toEqual([]);
  });
});

/**
 * provisionDriveCategoryDirs 的品牌分发不能再出现 `provider === "quark"` 这类三元。
 *
 * 原尾部是 `provider === "quark" ? 注册表 : 115 bootstrap`：加第六家 cookie 盘时，
 * 它会被**静默送进 115 的 client** 去建目录（G1 静默失败类）。现在走注册表的
 * createBootstrap，每家自己说怎么建目录。
 */
describe("品牌分发不再有 provider === 硬判", () => {
  it("workflow-runtime.ts 里没有 provider === \"quark\"/\"pan115\" 字面量", () => {
    const source = readFileSync(`${WEB_ROOT}/lib/workflow-runtime.ts`, "utf8");
    // 只查字符串字面量，注释里讨论历史写法不算（AST 语义）
    const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const offenders: string[] = [];
    // 两种形态都要认：`provider === "quark"`（provider 是裸标识符/形参）和
    // `x.provider === "quark"`（属性访问）。只认后者会漏掉前者——变异测试抓到过。
    const isProviderOperand = (node: ts.Node, file: ts.SourceFile): boolean => {
      if (ts.isIdentifier(node)) return node.text === "provider";
      return ts.isPropertyAccessExpression(node) && node.name.getText(file) === "provider";
    };

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) {
        const t = node.text;
        if (t === "quark" || t === "pan115") {
          // 允许出现在与 provider 无关的位置（如 connectPan115Cookie 里硬编码的
          // 115 专属流程）——只拦 `provider === X` / `provider !== X` 形态。
          const parent = node.parent;
          if (
            ts.isBinaryExpression(parent) &&
            (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
              parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
            isProviderOperand(parent.left, file)
          ) {
            offenders.push(t);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(offenders, `workflow-runtime.ts 又有 provider === 硬判：${offenders.join(", ")}`).toEqual([]);
  });
});
