import { describe, expect, it } from "vitest";
import { parseBearerToken } from "./bearer-scheme";

/**
 * Bearer 方案的唯一真源。此前这个正则在三处各写一份（proxy 粗筛、真实实现的
 * resolveBearerAccountId、五个测试文件里的 mock 复刻版），第四轮复核对真实实现
 * 做变异（去掉 trim）时 6 个文件 98 个用例全绿——mock 与真实实现漂移了。
 * 抽成共享模块后测试 mock 直接 import 它，漂移在结构上不可能发生；这里的用例
 * 则钉住规则本身的每个分支。
 */
describe("parseBearerToken（Bearer 方案的唯一真源）", () => {
  it("标准形态 → token", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("scheme 大小写无关（RFC 7235）", () => {
    expect(parseBearerToken("bearer abc")).toBe("abc");
    expect(parseBearerToken("BEARER abc")).toBe("abc");
    expect(parseBearerToken("BeArEr abc")).toBe("abc");
  });

  it("token 前后空白被忽略（与 proxy 的 \\s 粗筛对齐）", () => {
    expect(parseBearerToken("Bearer   abc")).toBe("abc");
    expect(parseBearerToken("Bearer abc   ")).toBe("abc");
    expect(parseBearerToken("Bearer\tabc")).toBe("abc");
    expect(parseBearerToken("Bearer \t abc \t")).toBe("abc");
  });

  it("缺 scheme / 别的 scheme / 无 token → null", () => {
    expect(parseBearerToken("abc")).toBeNull();
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken("Token abc")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
    expect(parseBearerToken("Bearer   ")).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it("token 内部的点号/下划线/连字符原样保留（JWT 三段式不被吃掉）", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2N0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(parseBearerToken(`Bearer ${jwt}`)).toBe(jwt);
  });

  it(" Bearer 前置空白不算（头值以 scheme 开头，前导空白是非法的）", () => {
    // 与真实实现同一口径：不做 trim(header)，只 trim token。
    expect(parseBearerToken(" Bearer abc")).toBeNull();
  });
});
