import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    expect(routes.length).toBe(39);
    const open = routes.filter((r) => OPEN_ROUTES.has(r.path));
    const selfGuarded = routes.filter((r) => SELF_GUARDED_ROUTES.has(r.path));
    const guarded = routes.filter(
      (r) => !OPEN_ROUTES.has(r.path) && !SELF_GUARDED_ROUTES.has(r.path),
    );
    expect(open.length).toBe(OPEN_ROUTES.size);
    expect(selfGuarded.length).toBe(SELF_GUARDED_ROUTES.size);
    expect(guarded.length).toBe(22);
  });

  it("22 个非白名单路由全部引用 requireApiAccount 登录链", () => {
    const missing = routes
      .filter((r) => !OPEN_ROUTES.has(r.path) && !SELF_GUARDED_ROUTES.has(r.path))
      .filter((r) => !r.source.includes("requireApiAccount"))
      .map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it("12 个白名单路由不挂登录链（保持免登录）", () => {
    const leaked = routes
      .filter((r) => OPEN_ROUTES.has(r.path))
      .filter((r) => r.source.includes("requireApiAccount"))
      .map((r) => r.path);
    expect(leaked).toEqual([]);
  });

  it("白名单路由各自的鉴权机制仍在位（不被登录链顶替）", () => {
    const byPath = new Map(routes.map((r) => [r.path, r.source]));
    for (const path of ["workflows/run-next", "workflows/run-type3"]) {
      expect(byPath.get(path), path).toContain("workerApiGuard");
    }
    for (const path of ["update/hold", "update/busy"]) {
      expect(byPath.get(path), path).toContain("isUpdaterToken");
    }
    expect(byPath.get("update/status")).toContain("resolveCurrentIsOwner");
    expect(byPath.get("auth/token")).toContain("resolveApiKey");
  });

  it("agent/* 路由仍用独立 token 守卫（未配 token 返 404 的契约不变）", () => {
    for (const path of SELF_GUARDED_ROUTES) {
      expect(routes.find((r) => r.path === path)?.source ?? "", path).toContain("agentApiGuard");
    }
  });
});
