import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "@media-track/shared";
import {
  GUARDED_PAGE_COUNT,
  LOGIN_EXEMPT_PAGES,
  PAGE_PERMISSION_TABLE,
} from "../../platform/next-context/page-permission-table";

/**
 * S5.7 页面登录守卫清单门禁（静态层）。
 *
 * 与 route-auth-inventory.test.ts（/api 侧）同源同思路：一个新增的页面若忘了包
 * 守卫，「设了访问密码就要登录」就会在那个 URL 上静默失效——而这类漏包不会有
 * 任何测试报错（页面照常渲染，只是没闸机）。所以用静态清单把 7 个入口钉死。
 *
 * 为什么必须是 AST 判定而不是源码文本包含：注释里写一行 <PageLoginGuard />
 * 就能让 includes() 双双放行（/api 侧两層兜底都踩过这个坑，见那个文件的注释）。
 * 这里要求：真的 import 了 PageLoginGuard，且它作为 JSX 元素出现在某个
 * <Suspense> 的后代里（cacheComponents 要求请求期读取必须在 Suspense 边界内，
 * 放在边界外会让构建期预渲染直接失败——S5.7 实测）。
 */

const APP_ROOT = fileURLToPath(new URL("../../app", import.meta.url)).replace(/\/$/, "");

/** 递归收集 app/ 下所有 page.tsx（含 [param] 动态段目录）。 */
function collectPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...collectPages(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out.sort();
}

interface GuardWiring {
  importsGuard: boolean;
  /** PageLoginGuard 作为 JSX 元素出现的次数。 */
  jsxCount: number;
  /** 其中被 <Suspense> 包住的次数。 */
  insideSuspense: number;
}

function analyze(source: string): GuardWiring {
  const file = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: GuardWiring = { importsGuard: false, jsxCount: 0, insideSuspense: 0 };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        if ((el.propertyName?.text ?? el.name.text) === "PageLoginGuard") result.importsGuard = true;
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      if (tag !== "PageLoginGuard") return;
      result.jsxCount += 1;
      // 向上找祖先链上最近的 JSX 元素，看是不是 <Suspense>。
      let cur: ts.Node = node.parent;
      while (cur) {
        if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isJsxFragment(cur)) {
          const open = ts.isJsxElement(cur) ? cur.openingElement : null;
          if (open && open.tagName.getText(file) === "Suspense") {
            result.insideSuspense += 1;
            break;
          }
          if (ts.isJsxFragment(cur)) break;
        }
        cur = cur.parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

describe("S5.7 页面登录守卫清单（app/**/page.tsx）", () => {
  const pages = collectPages(APP_ROOT);

  it("扫描到的页面入口数量符合预期（新增页面必须显式表态，别让清单悄悄变空）", () => {
    // 11 个受管页面（含 /library 与 /account）+ 3 个系统页面 + login（豁免）。
    // 数量变化 = 有人加了/删了页面，必须回来看一眼（新增页是否也包了登录守卫）。
    expect(pages.length).toBe(15);
  });

  it("除 /login 外每个页面入口都 import 并在 <Suspense> 内渲染 PageLoginGuard", () => {
    const offenders: string[] = [];
    for (const path of pages) {
      if (path.endsWith("/login/page.tsx")) continue; // 登录面自身必须豁免
      const wiring = analyze(readFileSync(path, "utf8"));
      if (!wiring.importsGuard || wiring.jsxCount !== 1 || wiring.insideSuspense !== 1) {
        offenders.push(`${path.replace(`${APP_ROOT}/`, "")}: import=${wiring.importsGuard} jsx=${wiring.jsxCount} inSuspense=${wiring.insideSuspense}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("/login 不得包守卫（否则 /login → /login 无限环；它也不在 proxy 的 matcher 里）", () => {
    const login = pages.find((p) => p.endsWith("/login/page.tsx"));
    expect(login).toBeDefined();
    const wiring = analyze(readFileSync(login!, "utf8"));
    expect(wiring.jsxCount).toBe(0);
  });

  it("根目录 not-found.tsx 存在且同样包守卫（未匹配路由不能绕过「设了密码就要登录」）", () => {
    const notFound = `${APP_ROOT}/not-found.tsx`;
    let source = "";
    try {
      source = readFileSync(notFound, "utf8");
    } catch {
      throw new Error(`缺少 ${notFound}：未匹配路由（404）会绕过页面守卫。需自建 not-found.tsx 并包 <Suspense><PageLoginGuard /></Suspense>`);
    }
    const wiring = analyze(source);
    expect(wiring.importsGuard).toBe(true);
    expect(wiring.insideSuspense).toBe(1);
  });

  /**
   * 页面 → 权限点清单（`platform/next-context/page-permission-table.ts`）。
   *
   * 原型缺陷（2026-11-15 权限收敛时）：`/settings` 本体加了 `system:settings` 判定，
   * 但 `/settings/mediaserver`、`/settings/extensions` 仍是「登录即可」——成员只要
   * 手输 URL 就能进配置面，页面级关停形同虚设（隐藏 ≠ 关闭）。
   *
   * 子页面自身的守卫强度无法由「有没有 PageLoginGuard」保证。这里改成**全量**
   * 表驱动：每个 page.tsx 都必须显式归类，且源码里真的按表里的钥匙判定。
   * 新增页面未归类 → 直接红，不可能再靠「复制一个 PageLoginGuard」蒙混过去。
   */
  const pageKey = (path: string): string =>
    path
      .replace(`${APP_ROOT}/`, "")
      .replace(/\/?page\.tsx$/, "");

  it("每个受管页面都在权限清单里（新增页面必须显式归类）", () => {
    const missing = pages
      .map(pageKey)
      .filter((key) => key !== "" ? !(key in PAGE_PERMISSION_TABLE) : !("" in PAGE_PERMISSION_TABLE))
      .filter((key) => !(LOGIN_EXEMPT_PAGES as readonly string[]).includes(key));
    expect(missing).toEqual([]);
  });

  it("清单条目数与声明常量一致（加页面必须同时说明为什么这把钥匙）", () => {
    expect(Object.keys(PAGE_PERMISSION_TABLE)).toHaveLength(GUARDED_PAGE_COUNT);
  });

  it("表里声明的权限点都在权限目录里（防拼错成不存在的权限）", () => {
    const catalogIds = new Set(PERMISSION_CATALOG.flatMap((m) => m.leaves.map((l) => l.id)));
    const unknown = Object.entries(PAGE_PERMISSION_TABLE)
      .filter(([, entry]) => entry.permission !== null && !catalogIds.has(entry.permission))
      .map(([key, entry]) => `${key} → ${entry.permission}`);
    expect(unknown).toEqual([]);
  });

  it("带权限点的页面真的按声明的权限点判定；permission=null 的页面不得带权限判定", () => {
    const violations: string[] = [];
    for (const path of pages) {
      const key = pageKey(path);
      if ((LOGIN_EXEMPT_PAGES as readonly string[]).includes(key)) continue;
      const entry = PAGE_PERMISSION_TABLE[key];
      if (!entry) continue; // 由上一条用例报缺失
      const source = readFileSync(path, "utf8");
      if (entry.permission === null) {
        // 登录即可的页面（如 /account）：一旦有人给它加权限判定，成员就会被
        // 再次挡在门外——这正是上一轮的缺陷原型，故反向断言。
        if (source.includes("decidePageAccess")) {
          violations.push(`${key}: 声明为登录即可，却调用了 decidePageAccess`);
        }
        continue;
      }
      if (!source.includes("decidePageAccess") || !source.includes(`"${entry.permission}"`)) {
        violations.push(`${key}: 未按 ${entry.permission} 判定（仅登录，权限不生效）`);
      }
    }
    expect(violations).toEqual([]);
  });
});
