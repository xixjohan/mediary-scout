import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 「入口可达性」静态门禁。
 *
 * 缺陷原型（2026-11-16 实测）：改密从 `/settings` 迁到独立 `/account` 时，
 * 侧边栏账号菜单的 href 是**手写字符串拼接**，漏改了它——成员点「修改密码」
 * 落到 `/settings`，而该页对成员整体关闭，于是看到一个「权限不足」面板。
 * 这类 bug 的共同形态是：
 *
 *   一个只在部分角色可用的 URL，被某个**所有角色都能看到**的组件硬编码渲染。
 *
 * 它不会被任何现有测试发现：页面守卫是对的、改密功能是对的、侧边栏组件也
 * 渲染正常——错的是两者之间的那条隐式契约。
 *
 * 所以门禁不检查「有没有链接」，而是检查**链接的构造方式**：
 *  1. 受权限约束的 URL 只能通过具名构造器产出（`account-links.ts` 等）；
 *  2. 源码里不得出现这些 URL 的裸字面量/模板拼接；
 *  3. 两个权限域的构造器必须各自收敛到正确前缀（`/account` vs `/settings`）。
 */

/** Windows 下 fileURLToPath 给反斜杠且可能带尾分隔符；统一成正斜杠相对路径。 */
const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/\/$/, "");
/** 只扫源码目录；构建产物（.next/standalone）会带一份陈旧副本，扫它必误报。 */
const SOURCE_ROOTS = ["app", "features", "components", "lib", "platform", "composition"].map(
  (dir) => `${WEB_ROOT}/${dir}`,
);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = SOURCE_ROOTS.filter((dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}).flatMap(collectSourceFiles);

/**
 * 受权限约束的 URL：只有特定角色能进，因此不得在通用组件里裸写。
 * 每条规则给出「该 URL 属于哪个权限域」与「谁有权构造它」。
 */
interface GatedUrlRule {
  name: string;
  /** 命中即违规的正则：字面量、模板字符串、或字符串拼接。 */
  pattern: RegExp;
  /** 允许出现这些字面量的文件（构造器自身 + 守卫/测试断言处）。 */
  allowedFiles: readonly string[];
}

const RULES: readonly GatedUrlRule[] = [
  {
    name: "改密入口必须走 accountSelfServiceHref（/account 是个人面，成员可用）",
    // `/settings?tab=account`（含 `&w` 变体）与 `#password` 锚点组合
    pattern: /settings\?tab=account|tab=account#/,
    allowedFiles: [
      "features/auth/core/account-links.ts",
      "features/settings-system/core/settings-tabs-model.ts",
    ],
  },
  {
    name: "账号管理入口必须走 accountAdminHref（/settings 是实例配置面，仅 system:settings）",
    // 裸写 `/account#password` 这类字面量同样收口到构造器
    pattern: /\/account#/,
    allowedFiles: ["features/auth/core/account-links.ts"],
  },
];

/**
 * 只取**字符串字面量 / 模板串**的内容，注释不算。
 *
 * 与 `/api` 侧的 `route-auth-inventory` 同一教训：文本 contains 会让一句注释
 * 既「通过门禁」又「绕过门禁」。这里反向使用同一条原则——注释里写
 * 「旧链接是 /settings?tab=account」是**有价值的文档**，不该被判红；
 * 真正渲染给用户的 href 一定在字符串里。
 */
function urlStringsIn(source: string): string[] {
  const file = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      // 模板串拆成 head + 各 span 的中间片段：足以识别 `/settings?tab=account${...}`
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

function relPath(full: string): string {
  return full.replace(/\\/g, "/").replace(`${WEB_ROOT}/`, "");
}

describe("入口可达性：受权限约束的 URL 不得裸写", () => {
  it("扫描到的源码文件数量稳定（扫空会让门禁静默失效）", () => {
    expect(sourceFiles.length).toBeGreaterThan(200);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      const offenders = sourceFiles
        .filter((full) => {
          const rel = relPath(full);
          if (rule.allowedFiles.includes(rel)) return false;
          // 只看字符串内容：注释里引用旧链接是文档，不是渲染。
          return urlStringsIn(readFileSync(full, "utf8")).some((s) => rule.pattern.test(s));
        })
        .map(relPath);
      expect(offenders).toEqual([]);
    });
  }
});

describe("account-links 构造器：两个权限域各自收敛", () => {
  const load = async () => import("../../../features/auth/core/account-links");
  const W = "cs_a b&c";

  it("个人面恒指向 /account，绝不含 /settings（否则成员必然 403）", async () => {
    const { accountSelfServiceHref } = await load();
    expect(accountSelfServiceHref()).toBe("/account");
    expect(accountSelfServiceHref({ hash: "#password" })).toBe("/account#password");
    for (const href of [
      accountSelfServiceHref({ w: W }),
      accountSelfServiceHref({ w: W, hash: "password" }),
    ]) {
      expect(href.startsWith("/account?")).toBe(true);
      expect(href).not.toContain("/settings");
    }
  });

  it("实例配置面恒指向 /settings?tab=account，且保留 ?w 工作区上下文", async () => {
    const { accountAdminHref } = await load();
    expect(accountAdminHref()).toBe("/settings?tab=account");
    expect(accountAdminHref({ hash: "#accounts" })).toBe("/settings?tab=account#accounts");
    const withW = accountAdminHref({ w: "cs_abc" });
    expect(withW.startsWith("/settings?tab=account&")).toBe(true);
    expect(withW).toContain("w=cs_abc");
    expect(withW.endsWith("#accounts")).toBe(false);
  });

  it("w 与 hash 都要正确编码/规范化（否则会截断参数或丢掉锚点）", async () => {
    const { accountSelfServiceHref, accountAdminHref } = await load();
    // URLSearchParams 编码：空格 → +，& 与 / 都被转义
    expect(accountSelfServiceHref({ w: W, hash: "password" })).toBe("/account?w=cs_a+b%26c#password");
    expect(accountAdminHref({ w: W, hash: "accounts" })).toBe(
      "/settings?tab=account&w=cs_a+b%26c#accounts",
    );
  });

  it("两个构造器产出的前缀互斥——这是「同一个功能不留两个入口」的物理保证", async () => {
    const { accountSelfServiceHref, accountAdminHref } = await load();
    const self = accountSelfServiceHref({ hash: "#password", w: "cs_x" });
    const admin = accountAdminHref({ hash: "#accounts", w: "cs_x" });
    expect(self.startsWith("/account")).toBe(true);
    expect(admin.startsWith("/settings")).toBe(true);
    expect(self).not.toBe(admin);
  });
});
