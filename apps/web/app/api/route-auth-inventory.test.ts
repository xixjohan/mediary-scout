import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * S5.4 路由鉴权清单门禁（静态层）。
 *
 * 与 tools/eslint-local-rules.mjs 的 `local/api-auth-required` 规则同源：
 * 两者编码同一份白名单，一层在测试、一层在 lint，互为兜底。
 *
 * 白名单（保持免登录，各自机制不变）：
 *   · /api/health                          —— 探活，公开
 *   · /api/auth/*                          —— 登录面自身（bootstrap/login/logout/password/register/token）
 *   · /api/workflows/run-next|run-type3    —— x-media-track-worker-secret（workerApiGuard）
 *   · /api/update/hold|busy                —— updater token（isUpdaterToken）
 *   · /api/update/status                   —— owner session（resolveCurrentIsOwner）
 *   · /api/agent/*                         —— 独立 Bearer token（agentApiGuard，docs/agent-api.md）
 * 其余每个路由都必须经 requireApiAccount 登录认证（session cookie → Bearer JWT → 单用户局域网默认账号）。
 */

const API_ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

/**
 * 「有没有真的调用这个函数」——AST 判定，不是源码文本包含。
 * 两层兜底（本文件 + ESLint 规则）都曾用 `source.includes(...)`，等于没兜底：
 * 留一行含 requireApiAccount 的注释就能双双放行（逐维核查的探针实证过）。
 * 只认 CallExpression 的标识符 callee；注释和字符串字面量都不是 CallExpression。
 */
/** 该文件是否真的从某个模块 import 了 `name`（默认 import / 具名 import 都算）。 */
function importsName(source: string, name: string): boolean {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) return;
      if (clause.name && clause.name.text === name) found = true;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = el.propertyName?.text ?? el.name.text;
          if (imported === name) found = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * 「调用」= AST 里真的有一次 `name(...)` 调用。第三轮起加了这道判定，挡住
 * 「注释/字符串里提一句就放行」；第四轮补上第二半：调用的必须是从别处 **import**
 * 的那个函数，而不是本地同名函数——否则新文件里写一个自己的
 * `function requireApiAccount() { return "acct_x" }` 再调用它，清单测试照样放行，
 * 而路由数断言（40）只在路由数量变化时才红。
 */
function callsFunction(source: string, name: string): boolean {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** 既 import 了 `name`、又真的调用它——防「本地同名函数」自娱自乐。 */
function usesImportedFunction(source: string, name: string): boolean {
  return importsName(source, name) && callsFunction(source, name);
}

const OPEN_ROUTES = new Set([
  "health",
  "auth/bootstrap",
  "auth/login",
  "auth/logout",
  "auth/password",
  "auth/register",
  "auth/token",
  "workflows/run-next",
  "workflows/run-type3",
  "update/hold",
  "update/busy",
  "update/status",
]);

const SELF_GUARDED_ROUTES = new Set([
  "agent/acquire",
  "agent/activity",
  "agent/config",
  "agent/library",
  "agent/patrol",
]);

function routeFiles(dir: string = API_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

const routes = routeFiles().map((full) => ({
  path: full.slice(API_ROOT.length + 1, -"/route.ts".length),
  source: readFileSync(full, "utf8"),
}));

describe("S5.4 /api 路由鉴权清单", () => {
  it("枚举到的路由数量与分类稳定（新增路由必须显式归类）", () => {
    expect(routes.length).toBe(62);
    const open = routes.filter((r) => OPEN_ROUTES.has(r.path));
    const selfGuarded = routes.filter((r) => SELF_GUARDED_ROUTES.has(r.path));
    const guarded = routes.filter(
      (r) => !OPEN_ROUTES.has(r.path) && !SELF_GUARDED_ROUTES.has(r.path),
    );
    expect(open.length).toBe(OPEN_ROUTES.size);
    expect(selfGuarded.length).toBe(SELF_GUARDED_ROUTES.size);
    expect(guarded.length).toBe(45);
  });

  it("45 个非白名单路由全部引用 requireApiAccount 登录链", () => {
    const missing = routes
      .filter((r) => !OPEN_ROUTES.has(r.path) && !SELF_GUARDED_ROUTES.has(r.path))
      .filter((r) => !usesImportedFunction(r.source, "requireApiAccount"))
      .map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it("12 个白名单路由不挂登录链（保持免登录）", () => {
    const leaked = routes
      .filter((r) => OPEN_ROUTES.has(r.path))
      .filter((r) => usesImportedFunction(r.source, "requireApiAccount"))
      .map((r) => r.path);
    expect(leaked).toEqual([]);
  });

  // L6：机制判定与登录链同一把尺子（callsFunction，AST 走查）。此前是文本
  // toContain——留一句注释说「workerApiGuard 已校验」就能让这条断言绿，
  // 而守卫其实已经没了。注释与字符串字面量都不算调用。
  it("白名单路由各自的鉴权机制仍在位（不被登录链顶替）", () => {
    const byPath = new Map(routes.map((r) => [r.path, r.source]));
    const mechanisms: Array<[string, string]> = [
      ["workflows/run-next", "workerApiGuard"],
      ["workflows/run-type3", "workerApiGuard"],
      ["update/hold", "isUpdaterToken"],
      ["update/busy", "isUpdaterToken"],
      ["update/status", "resolveCurrentIsOwner"],
      ["auth/token", "resolveApiKey"],
    ];
    for (const [path, fn] of mechanisms) {
      expect(callsFunction(byPath.get(path) ?? "", fn), `${path} 必须真的调用 ${fn}`).toBe(true);
    }
  });

  it("agent/* 路由仍用独立 token 守卫（未配 token 返 404 的契约不变）", () => {
    for (const path of SELF_GUARDED_ROUTES) {
      const source = routes.find((r) => r.path === path)?.source ?? "";
      expect(callsFunction(source, "agentApiGuard"), `${path} 必须真的调用 agentApiGuard`).toBe(true);
    }
  });
});

describe("callsFunction 判定（M3：注释与字符串不算调用）", () => {
  it("真的 import + 调用 → true", () => {
    const src = `import { requireApiAccount } from "../../lib/auth-chain";
export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  return Response.json({});
}`;
    expect(callsFunction(src, "requireApiAccount")).toBe(true);
  });

  it("只在注释里提到 → false", () => {
    const src = `export async function GET(request: NextRequest) {
  // 这里必须调用 requireApiAccount(request)
  return Response.json({});
}`;
    expect(callsFunction(src, "requireApiAccount")).toBe(false);
  });

  it("只在字符串字面量里出现 → false", () => {
    const src = `export async function GET(request: NextRequest) {
  const name = "requireApiAccount";
  return Response.json({ name });
}`;
    expect(callsFunction(src, "requireApiAccount")).toBe(false);
  });

  it("本地同名函数 + 调用它 → callsFunction 为 true，但 usesImportedFunction 为 false", () => {
    // 第四轮复核的 low：AST 判定原本只看「有没有一次 name(...) 调用」，于是新文件里
    // 写一个自己的 requireApiAccount 桩再调用它，清单测试照样放行——而兜底的
    // 路由数断言（40）只在路由数量变化时才红。加「必须真的 import」这一半。
    const src = `function requireApiAccount(request: NextRequest): string {
  return "acct_default";
}
export async function GET(request: NextRequest) {
  return Response.json({ account: requireApiAccount(request) });
}`;
    expect(callsFunction(src, "requireApiAccount")).toBe(true);
    expect(importsName(src, "requireApiAccount")).toBe(false);
    expect(usesImportedFunction(src, "requireApiAccount")).toBe(false);
  });

  it("import 了但没调用 → usesImportedFunction 为 false（声明不等于生效）", () => {
    const src = `import { requireApiAccount } from "../../lib/auth-chain";
export async function GET(request: NextRequest) {
  return Response.json({ ok: true });
}`;
    expect(callsFunction(src, "requireApiAccount")).toBe(false);
    expect(importsName(src, "requireApiAccount")).toBe(true);
    expect(usesImportedFunction(src, "requireApiAccount")).toBe(false);
  });

  it("import 了 requireApiAccount 并调用（真实路由的形态）→ true", () => {
    const src = `import { requireApiAccount } from "../../lib/auth-chain";
export async function GET(request: NextRequest) {
  const account = await requireApiAccount(request);
  if (account instanceof Response) return account;
  return Response.json({ account });
}`;
    expect(usesImportedFunction(src, "requireApiAccount")).toBe(true);
  });

  it("同名本地函数（不是导入的那个）→ 也算调用（保守：宁可放行也不误伤，lint 层同语义）", () => {
    const src = `function requireApiAccount() { return 1; }
export async function GET() { return Response.json({ n: requireApiAccount() }); }`;
    expect(callsFunction(src, "requireApiAccount")).toBe(true);
  });

  it("不同名的调用 → false", () => {
    expect(callsFunction(`export async function GET() { return agentApiGuard(); }`, "requireApiAccount")).toBe(false);
  });
});
