import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 整理路由的结构门禁（防回归）。
 *
 * 背景：`/api/titles/organize` 曾用「工作流运行记录」反推标题是否可整理，
 * 盘里已有的内容没有 run，于是必然返回 `title not tracked`（404），用户无法整理。
 * 修复同时补了两件事：按盘过滤追踪态、对客户端声明的盘做归属校验。
 *
 * 本文件用 AST 而不是源码文本匹配来断言——文本包含的判据只要留一行注释就能绕过
 * （`route-auth-inventory.test.ts` 已被这一点坑过）。
 */

const ROUTE_PATH = fileURLToPath(new URL("./route.ts", import.meta.url));
const SOURCE = readFileSync(ROUTE_PATH, "utf8");

function createSource(): ts.SourceFile {
  return ts.createSourceFile("route.ts", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** 被调用的函数名：同时支持 `foo()` 与 `this.foo()` / `repo.foo()`。 */
function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** 是否存在对 `name(...)` 的真实调用（注释/字符串不算）。 */
function callsFunction(name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && calleeName(node) === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(createSource(), visit);
  return found;
}

/** 调用 `name(...)` 时，第一个实参对象里是否有名为 `prop` 的属性。 */
function passesObjectProperty(name: string, prop: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && calleeName(node) === name) {
      // 属性可能包在条件/spread 里，因此在实参子树内任意对象字面量里找。
      const search = (candidate: ts.Node): void => {
        if (found) return;
        if (ts.isObjectLiteralExpression(candidate)) {
          const hit = candidate.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === prop,
          );
          if (hit) {
            found = true;
            return;
          }
        }
        ts.forEachChild(candidate, search);
      };
      node.arguments.forEach(search);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(createSource(), visit);
  return found;
}

describe("organize 路由结构门禁", () => {
  it("不得再返回裸的 title not tracked 文案（必须给 code + 可操作提示）", () => {
    expect(SOURCE).not.toContain("title not tracked");
  });

  it("必须给未追踪场景返回可识别的错误码", () => {
    expect(SOURCE).toContain("NOT_TRACKED");
  });

  it("必须校验客户端声明的网盘归属", () => {
    expect(callsFunction("listConnectedStorages")).toBe(true);
  });

  it("追踪态必须按盘过滤，避免跨盘错配", () => {
    expect(callsFunction("listTrackedSeasonStates")).toBe(true);
    expect(passesObjectProperty("listTrackedSeasonStates", "connectedStorageId")).toBe(true);
  });
});
