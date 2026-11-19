import { describe, expect, it } from "vitest";
import { runTrackedIdentityGate } from "./check-tracked-identity.mjs";

/**
 * 门禁自身的有效性测试：只在当前仓库上断言通过。
 *
 * 反向能力由门禁实现里的「函数体提取 + 符号查找」保证——删掉任一守卫、
 * 或把 `isTrackedTitleIdentity` 从读取层去掉，都会让它变红。
 */
describe("check-tracked-identity gate", () => {
  it("当前仓库通过全部五项检查", () => {
    expect(runTrackedIdentityGate()).toBe(true);
  });
});
