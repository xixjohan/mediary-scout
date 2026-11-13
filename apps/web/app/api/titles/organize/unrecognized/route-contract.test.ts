import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 「一键补后缀」路由的结构门禁（防回归）。
 *
 * 背景：115 转存会把文件名截断在发布组后缀上，扩展名丢失后整理器认不出这些文件。
 * 修复思路是**先读文件头判定容器再改名**，绝不按体积或文件名猜扩展名——把 mkv
 * 改成 mp4 这类错误不可逆（播放器/Plex 会按错误容器解析）。
 *
 * 这条门禁钉住三件事：
 * 1. 必须真的读文件头（`sniffVideoContainer`）；
 * 2. 扩展名必须来自容器判定（`extensionForContainer`），不能内联硬编码字符串；
 * 3. 必须校验盘归属，避免用他人 storageId 改名。
 */

const ROUTE_PATH = fileURLToPath(new URL("./route.ts", import.meta.url));
const SOURCE = readFileSync(ROUTE_PATH, "utf8");

function createSource(): ts.SourceFile {
  return ts.createSourceFile("route.ts", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

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

describe("补后缀路由结构门禁", () => {
  it("必须读文件头判定容器", () => {
    expect(callsFunction("sniffVideoContainer")).toBe(true);
  });

  it("扩展名必须来自容器判定，而不是写死", () => {
    expect(callsFunction("extensionForContainer")).toBe(true);
    // 改名目标必须由容器推导，禁止 `newName = \`${name}.mp4\`` 之类的硬编码
    expect(SOURCE).not.toMatch(/newName\s*=\s*`[^`]*\.(mp4|mkv)`/);
  });

  it("必须校验网盘归属", () => {
    expect(callsFunction("listConnectedStorages")).toBe(true);
  });

  it("必须只处理服务端自己扫出来的候选（不采信客户端文件名）", () => {
    expect(callsFunction("scanUnrecognizedMedia")).toBe(true);
  });
});
