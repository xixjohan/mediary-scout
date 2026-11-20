import { describe, expect, it } from "vitest";
import { runStrmOrphanGate } from "./check-strm-orphan-cleanup.mjs";

/**
 * 门禁有效性测试：只在当前仓库上断言通过。
 *
 * 反向能力由门禁实现里的「函数体提取 + 符号查找 + catch 块扫描」保证——把清理
 * 挪回 `full_sync` 条件块、或在 catch 里 `return []`，都会让它变红。
 */
describe("check-strm-orphan-cleanup gate", () => {
  it("当前仓库通过全部五项检查", () => {
    expect(runStrmOrphanGate()).toBe(true);
  });
});
