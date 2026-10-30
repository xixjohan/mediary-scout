import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 页脚铭牌（GitHubNameplate）的门禁。
 *
 * 两条都是回归防线，各对应一次真实错误：
 *
 * 1. **仓库链接必须指向当前仓库（origin）**。曾硬编码指向 upstream 作者的仓库
 *    （fancydirty/mediary-scout），而这是一个 fork——访客点「开源自部署」落到
 *    上游项目，看不到自己部署的这份代码，issue/PR 也会提错地方。所以这里不写死
 *    期望值，而是从 `git remote get-url origin` 取当前仓库，两边归一化后比对：
 *    换机器、换 fork、改名都不需要改测试。
 *
 * 2. **页脚不得再出现「请作者喝杯咖啡」入口**（产品决定去掉）。只删按钮会留下
 *    一座没人能打开的打赏弹窗（死代码 + 两张收款码资产），所以断言整个组件树里
 *    不再渲染 SupportAuthorLink，且 apps/web 下不再出现该文案。
 */

const COMPONENTS_ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const NAMEPLATE = `${COMPONENTS_ROOT}/github-nameplate.tsx`;

/** `https://github.com/owner/repo.git` / `git@github.com:owner/repo.git` → `owner/repo`。 */
function normalizeRepoUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const https = cleaned.match(/github\.com[:/]([^/]+\/[^/]+)$/i);
  if (https?.[1]) return https[1].toLowerCase();
  return cleaned.toLowerCase();
}

function originRepo(): string {
  const fromGit = (() => {
    try {
      return normalizeRepoUrl(execSync("git remote get-url origin", { encoding: "utf8" }));
    } catch {
      return "";
    }
  })();
  if (fromGit.includes("/")) return fromGit;
  // 兜底：某些环境（如解包后的源码树）没有 git  remote，退回报仓 config。
  try {
    const cfg = readFileSync(`${COMPONENTS_ROOT}/../../.git/config`, "utf8");
    const m = cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
    if (m?.[1]) return normalizeRepoUrl(m[1]);
  } catch {
    /* 没有 .git/config 就让下面的断言失败并说明原因 */
  }
  return "";
}

/**
 * 该文件里所有**会进到用户眼前**的文本：字符串字面量 + JSX 文本。
 *
 * 刻意不用整篇源码 includes()：注释里提一句这个文案就会误报（nameplate 的说明
 * 注释就在解释「为什么移除它」），而反过来注释也能让 includes() 假绿——本项目
 * 在 /api 侧两层兜底上已经踩过这个坑（见 route-auth-inventory.test.ts 的注释）。
 * AST 只认字面量，注释和字符串外的内容都不算。
 */
function userVisibleText(source: string): string[] {
  const file = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
    if (ts.isJsxText(node)) texts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
}

/** 该文件是否从某个模块 import 了 `name`（默认 / 具名都算）。 */
function importsName(source: string, name: string): boolean {
  const file = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        if ((el.propertyName?.text ?? el.name.text) === name) found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** 源码里所有字符串字面量 + JSX 文本中出现过 `needle` 就算命中（排除注释由调用方负责）。 */
function collectSources(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...collectSources(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe("GitHubNameplate — 仓库链接指向当前仓库", () => {
  it("origin 能解析出来（否则这条门禁失去参照，必须先修环境）", () => {
    expect(originRepo()).toMatch(/^[^/\s]+\/[^/\s]+$/);
  });

  it("铭牌的 GitHub 链接归一化后等于 origin（不许再指向上游/别的仓库）", () => {
    const source = readFileSync(NAMEPLATE, "utf8");
    const file = ts.createSourceFile("nameplate.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hrefs: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(file) === "href") {
        const init = node.initializer;
        const text = init && ts.isStringLiteral(init) ? init.text : init?.getText(file);
        if (text) hrefs.push(text.replace(/^["']|["']$/g, ""));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    const githubHrefs = hrefs.filter((h) => /github\.com/i.test(h));
    expect(githubHrefs.length).toBeGreaterThan(0);
    for (const href of githubHrefs) {
      expect(normalizeRepoUrl(href)).toBe(originRepo());
    }
  });
});

describe("GitHubNameplate — 不再有打赏入口", () => {
  it("铭牌不再渲染 SupportAuthorLink（只删按钮会留下打不开的死弹窗）", () => {
    expect(importsName(readFileSync(NAMEPLATE, "utf8"), "SupportAuthorLink")).toBe(false);
  });

  it("apps/web 下任何组件都不再引用 SupportAuthorLink", () => {
    const offenders = collectSources(COMPONENTS_ROOT, [".tsx", ".ts"]).filter((p) =>
      importsName(readFileSync(p, "utf8"), "SupportAuthorLink"),
    );
    expect(offenders).toEqual([]);
  });

  it("apps/web 的组件里不再出现「请作者喝杯咖啡」文案（AST 只认字面量，注释不算）", () => {
    const offenders = collectSources(COMPONENTS_ROOT, [".tsx", ".ts"])
      .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx")) // 测试文件自己会提到这个文案
      .filter((p) => userVisibleText(readFileSync(p, "utf8")).some((t) => t.includes("请作者喝杯咖啡")));
    expect(offenders).toEqual([]);
  });
});
