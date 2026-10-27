import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isLiveSearch, searchProviderKind } from "./search-provider";

/**
 * 搜索提供方：env 只能在一个地方被读。
 *
 * 「当前是 TMDB 实时还是 demo？」这个判断原先散在 3 个文件 8 处，每处各自
 * `process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb"`。问题不是重复，而是
 * **这个语义没有单一出处**——加第三种提供方时要找齐 8 处，漏一处就出现
 * 「搜索页走实时、海报墙走 demo」的分裂。
 *
 * 收敛后 MEDIA_TRACK_SEARCH_PROVIDER 退化为「选默认项」：读它、翻成一个枚举，
 * 其余代码只问枚举。
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** 除了 search-provider.ts 自己，谁都不该直接读这个 env。 */
const ENV_VAR = "MEDIA_TRACK_SEARCH_PROVIDER";
const OWNER = "lib/search-provider.ts";

/** 收集一个文件里所有 `process.env.X` / `env.X` 的属性访问名。
 *  两种写法都要认：`process.env.FOO`（obj 是名字为 env 的属性访问）和裸
 *  `env.FOO`（obj 是名为 env 的标识符——search-provider.ts 的形参就是后者，
 *  漏认它会让「owner 自己确实读它」变成假红）。 */
function envReads(rel: string): string[] {
  const source = readFileSync(`${WEB_ROOT}/${rel}`, "utf8");
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const isEnvObject = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === "env";
    return ts.isPropertyAccessExpression(node) && node.name.getText(file) === "env";
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && isEnvObject(node.expression)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function webSourceFiles(): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full.replace(`${WEB_ROOT}/`, ""));
    }
  };
  walk(`${WEB_ROOT}/lib`);
  walk(`${WEB_ROOT}/app`);
  walk(`${WEB_ROOT}/components`);
  return out;
}

describe("searchProviderKind", () => {
  it("tmdb → tmdb", () => {
    expect(searchProviderKind({ MEDIA_TRACK_SEARCH_PROVIDER: "tmdb" })).toBe("tmdb");
  });

  it("demo → demo", () => {
    expect(searchProviderKind({ MEDIA_TRACK_SEARCH_PROVIDER: "demo" })).toBe("demo");
  });

  it("未设置 → demo（缺省即演示，不炸）", () => {
    expect(searchProviderKind({})).toBe("demo");
  });

  it("空串/大小写/未知值都退化为 demo，不抛错", () => {
    expect(searchProviderKind({ MEDIA_TRACK_SEARCH_PROVIDER: "" })).toBe("demo");
    expect(searchProviderKind({ MEDIA_TRACK_SEARCH_PROVIDER: "TMDB" })).toBe("demo");
    expect(searchProviderKind({ MEDIA_TRACK_SEARCH_PROVIDER: "bogus" })).toBe("demo");
  });
});

describe("isLiveSearch", () => {
  it("只有 tmdb 是实时", () => {
    expect(isLiveSearch({ MEDIA_TRACK_SEARCH_PROVIDER: "tmdb" })).toBe(true);
    expect(isLiveSearch({ MEDIA_TRACK_SEARCH_PROVIDER: "demo" })).toBe(false);
    expect(isLiveSearch({})).toBe(false);
  });
});

describe("结构门禁 — env 只能在一个地方被读", () => {
  it("除 search-provider.ts 外，没有文件再直接读 MEDIA_TRACK_SEARCH_PROVIDER", () => {
    const offenders: string[] = [];
    for (const rel of webSourceFiles()) {
      if (rel === OWNER) continue;
      if (envReads(rel).includes(ENV_VAR)) offenders.push(rel);
    }
    expect(offenders, `这些文件又自己读了搜索提供方 env：${offenders.join(", ")}`).toEqual([]);
  });

  it("search-provider.ts 自己确实读它（否则上面一条是假绿）", () => {
    expect(envReads(OWNER)).toContain(ENV_VAR);
  });
});
