import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "@media-track/shared";
import {
  ROUTE_PERMISSION_TABLE,
  WIRED_ROUTE_COUNT,
} from "../../platform/next-context/route-permission-table";

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

/**
 * 是否真的以指定字符串字面量调用了 `name` —— 即 `name(request, "library:manage")`。
 * 只查「调了 requirePermission」不够：把权限点写错成别的（或写个恒真变量）照样能过，
 * 门禁必须核对**权限点与清单一致**。
 */
function callsFunctionWithLiteral(source: string, name: string, literal: string): boolean {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      const hasLiteral = node.arguments.some(
        (arg) => ts.isStringLiteral(arg) && arg.text === literal,
      );
      if (hasLiteral) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
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

const MCP_ROUTES = new Set(["mcp"]);
const STRM_PLAY_ROUTES = new Set(["strm/play/[taskId]/[fileId]"]);

/**
 * 会话自省端点：它回答的就是「我是谁」，因此只可能要求登录，不可能要求权限点
 * （对未登录访客返回 401、对任何已登录账号返回自身资料，这是该端点的语义）。
 */
const IDENTITY_ROUTES = new Set(["auth/me"]);

function routeFiles(dir: string = API_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

const routes = routeFiles().map((full) => ({
  path: full.replace(/\\/g, "/").slice(API_ROOT.replace(/\\/g, "/").length + 1, -"/route.ts".length),
  source: readFileSync(full, "utf8"),
}));

describe("S5.4 /api 路由鉴权清单", () => {
  it("枚举到的路由数量与分类稳定（新增路由必须显式归类）", () => {
    expect(routes.length).toBe(124);
    const open = routes.filter((r) => OPEN_ROUTES.has(r.path));
    const selfGuarded = routes.filter((r) => SELF_GUARDED_ROUTES.has(r.path));
    const mcpGuarded = routes.filter((r) => MCP_ROUTES.has(r.path));
    const guarded = routes.filter(
      (r) => !OPEN_ROUTES.has(r.path) && !SELF_GUARDED_ROUTES.has(r.path) && !MCP_ROUTES.has(r.path) && !STRM_PLAY_ROUTES.has(r.path),
    );
    expect(open.length).toBe(OPEN_ROUTES.size);
    expect(selfGuarded.length).toBe(SELF_GUARDED_ROUTES.size);
    expect(mcpGuarded.length).toBe(MCP_ROUTES.size);
    const strmPlayGuarded = routes.filter((r) => STRM_PLAY_ROUTES.has(r.path));
    expect(strmPlayGuarded.length).toBe(STRM_PLAY_ROUTES.size);
    expect(guarded.length).toBe(105);
  });

  it("105 个非白名单路由全部引用登录链（requireApiAccount 或 requirePermission）", () => {
    // requirePermission 内部先走 resolveSecurityContext（未认证即 401），因此它同样
    // 是一条登录链——接上细粒度权限的端点不再需要单独调 requireApiAccount。
    const missing = routes
      .filter((r) => !OPEN_ROUTES.has(r.path) && !SELF_GUARDED_ROUTES.has(r.path) && !MCP_ROUTES.has(r.path) && !STRM_PLAY_ROUTES.has(r.path))
      .filter((r) => !usesImportedFunction(r.source, "requireApiAccount") && !usesImportedFunction(r.source, "requirePermission"))
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

  it("strm/play 与 mcp 独立协议路由各自的鉴权机制仍在位", () => {
    const playSource = routes.find((r) => r.path === "strm/play/[taskId]/[fileId]")?.source ?? "";
    expect(callsFunction(playSource, "verifyStrmPlayToken"), "strm/play 必须调用 verifyStrmPlayToken").toBe(true);
    const mcpSource = routes.find((r) => r.path === "mcp")?.source ?? "";
    expect(callsFunction(mcpSource, "resolveSecurityContext"), "mcp 必须调用 resolveSecurityContext").toBe(true);
  });
});

describe("细粒度权限清单（权限目录接线门禁）", () => {
  it("清单里的每个端点都真的用声明的权限点调了 requirePermission", () => {
    const violations: string[] = [];
    for (const [path, declared] of Object.entries(ROUTE_PERMISSION_TABLE)) {
      const source = routes.find((r) => r.path === path)?.source;
      if (!source) {
        violations.push(`${path}: 清单里的端点不存在（路由被删了却没清清单）`);
        continue;
      }
      if (!usesImportedFunction(source, "requirePermission")) {
        violations.push(`${path}: 未调用 requirePermission（仅登录，权限不生效）`);
        continue;
      }
      // 数组 = 同一文件里读/写用不同钥匙；每个声明点都必须真的被调用过。
      const expected = Array.isArray(declared) ? declared : [declared];
      for (const permission of expected) {
        if (!callsFunctionWithLiteral(source, "requirePermission", permission)) {
          violations.push(`${path}: 权限点与清单不一致（期望 ${permission}）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("已接线的端点数与清单条目一致（新增接线必须显式更新计数）", () => {
    // 这个数字是**评审锚点**：改它的人必须同时说明"为什么这条端点该给这把钥匙"。
    expect(Object.keys(ROUTE_PERMISSION_TABLE)).toHaveLength(WIRED_ROUTE_COUNT);
    expect(WIRED_ROUTE_COUNT).toBe(104);
  });

  it("清单里的权限点都在权限目录里（防拼错成不存在的权限）", () => {
    const catalogIds = new Set(PERMISSION_CATALOG.flatMap((m) => m.leaves.map((l) => l.id)));
    const unknown: string[] = [];
    for (const [path, declared] of Object.entries(ROUTE_PERMISSION_TABLE)) {
      const expected = Array.isArray(declared) ? declared : [declared];
      for (const permission of expected) {
        if (!catalogIds.has(permission)) unknown.push(`${path} → ${permission}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  /**
   * deny-by-default：非白名单路由**必须**在清单里。
   *
   * 上一条只校验「清单里写了的都对」——漏写一条不会红。这条反过来钉死覆盖面：
   * 白名单与独立协议路由之外的每一条都必须出现，于是「新增端点只加登录链、
   * 配了权限却从不执行」的历史缺陷在最早期就被拦下。
   */
  it("非白名单路由全部在清单里（新增端点必须显式归类）", () => {
    const exempt = new Set([
      ...OPEN_ROUTES,
      ...SELF_GUARDED_ROUTES,
      ...MCP_ROUTES,
      ...STRM_PLAY_ROUTES,
      ...IDENTITY_ROUTES,
    ]);
    const missing = routes
      .filter((r) => !exempt.has(r.path))
      .filter((r) => !(r.path in ROUTE_PERMISSION_TABLE))
      .map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it("callsFunctionWithLiteral 只认权限点字面量——写错权限点必须判红", () => {
    const wrong = `import { requirePermission } from "../../lib/auth-chain";
export async function POST(request: NextRequest) {
  const gate = await requirePermission(request, "storage:list");
  if (gate instanceof Response) return gate;
  return Response.json({});
}`;
    expect(callsFunctionWithLiteral(wrong, "requirePermission", "library:manage")).toBe(false);
    expect(callsFunctionWithLiteral(wrong, "requirePermission", "storage:list")).toBe(true);
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
