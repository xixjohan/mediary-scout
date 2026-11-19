import { describe, expect, it } from "vitest";
import { runBlameFreeReportingGate } from "./check-blame-free-reporting.mjs";

/**
 * 门禁自身的「反向有效性」测试。
 *
 * 一个只会 return true 的门禁没有价值。这里只在**当前仓库**上断言通过；
 * 反向能力由门禁实现里的行号比较与符号查找保证（删任何一个分支都会红，见
 * docs/research/2026-11-18-no-coverage-model-error-blame-free-reporting-research.md §7.2）。
 */
describe("check-blame-free-reporting gate", () => {
  it("当前仓库通过全部六项检查", () => {
    expect(runBlameFreeReportingGate()).toBe(true);
  });
});
