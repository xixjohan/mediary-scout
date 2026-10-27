import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 「媒体库 → 订阅」正名的门禁。
 *
 * 为什么需要它：这个页面（`?tab=library`）的注释原文是 "Poster-wall view of
 * every tracked title"——它展示的是**全部追踪中的作品**（tracking/partial/
 * complete/reserved），本来就是订阅列表，叫「媒体库」是误称。但「媒体库」在
 * 仓库里出现 20+ 处且承担**两个不同含义**：
 *
 *   A/C 类 = 追踪列表语义（导航标签、页标题、空态、返回标签、取消追踪提示）
 *   B   类 = 用户私有数据范围（登录页「你的获取记录、收藏都与其他用户互不可见」、
 *            设置页「不影响他们的网盘和媒体库」、远程访问风险提示）
 *
 * 混改会造成「登录页说你的媒体库、侧边栏说订阅」的分裂——用户在两个地方
 * 看到同一个词指不同的东西。所以这里两侧都断言：A/C 类必须改成「订阅」，
 * B 类必须原样保留。
 *
 * 用 AST 只认字符串字面量与 JSX 文本：注释里提一句旧文案不该算命中
 * （本项目的注释就在解释「为什么改名」），反过来纯文本 includes() 也会被
 * 注释绕过——两类假绿在 /api 侧已经踩过（见 route-auth-inventory.test.ts）。
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** 文件里所有会进到用户眼前的文本：字符串字面量 + JSX 文本（不含注释）。 */
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

function read(rel: string): string {
  return readFileSync(`${WEB_ROOT}/${rel}`, "utf8");
}

/** A/C 类：追踪列表语义，必须已改成「订阅」、不得再出现「媒体库」。 */
const TRACKING_LIST_FILES = [
  "components/app-sidebar.tsx",
  "components/library-quick-find.tsx",
  "app/page.tsx",
  "app/show/[tmdbId]/page.tsx",
  "components/untrack-button.tsx",
  "app/not-found.tsx",
  "components/demo-acquire-playback.tsx",
];

/** B 类：用户私有数据范围，必须原样保留「媒体库」。 */
const DATA_OWNERSHIP_FILES = [
  "app/login/page.tsx",
  "app/settings/page.tsx",
  "lib/settings-attention.ts",
  "components/settings/remote-access-section.tsx",
  // demo 数据的 overview 文案：「产品化后 Type 1 也会留下媒体库记录」讲的是数据/
  // 记录归属，同属 B 类。原先不在这两张表里，等于没有守卫——本次补上，验收标准
  // 「grep 媒体库 只剩 B 类」才是被完整强制执行的。
  "lib/demo-candidates.ts",
];

describe("订阅页正名 — A/C 类（追踪列表语义）已改为「订阅」", () => {
  for (const rel of TRACKING_LIST_FILES) {
    it(`${rel} 不再出现「媒体库」字面量`, () => {
      const texts = userVisibleText(read(rel));
      const offenders = texts.filter((t) => t.includes("媒体库"));
      expect(offenders, `仍以追踪列表语义渲染「媒体库」：${JSON.stringify(offenders)}`).toEqual([]);
    });
  }

  it("侧边导航标签是「订阅」", () => {
    // JSX 文本带缩进空白，不能按数组精确匹配。
    expect(userVisibleText(read("components/app-sidebar.tsx")).some((t) => t.trim() === "订阅")).toBe(true);
  });

  it("订阅页主标题是「我的订阅」", () => {
    expect(userVisibleText(read("components/library-quick-find.tsx"))).toContain("我的订阅");
  });

  it("订阅页空态是「订阅还是空的」", () => {
    expect(userVisibleText(read("app/page.tsx"))).toContain("订阅还是空的");
  });

  it("详情页从订阅列表返回时，返回标签是「订阅」", () => {
    const source = read("app/show/[tmdbId]/page.tsx");
    expect(source).toContain('from === "library" ? "订阅"');
  });
});

describe("订阅页正名 — B 类（数据所有权语义）必须原样保留", () => {
  for (const rel of DATA_OWNERSHIP_FILES) {
    it(`${rel} 仍以数据所有权语义渲染「媒体库」`, () => {
      const texts = userVisibleText(read(rel));
      expect(texts.some((t) => t.includes("媒体库")), `B 类文案被误改：${rel}`).toBe(true);
    });
  }

  it("登录页的多用户隔离说明未被动过", () => {
    const texts = userVisibleText(read("app/login/page.tsx")).join("\n");
    expect(texts).toContain("拥有一份只属于你的媒体库");
  });
});
