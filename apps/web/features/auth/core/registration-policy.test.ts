import { describe, expect, it } from "vitest";
import { resolveRegistrationOpen } from "./registration-policy";

/**
 * 自助注册开关。
 *
 * 关键不变量只有两条，但都必须钉死：
 *  1. **缺省开放**——新部署实例要能自己认领，默认关掉会把人锁在登录页；
 *  2. 只有**明确否定值**才关闭——任何意料之外的写法（拼错、空格、大写）都应
 *     落回"开放"，而不是让运维以为开了其实是关的。
 */

describe("resolveRegistrationOpen", () => {
  it("未设置 / 空串 ⇒ 开放（新实例必须能认领）", () => {
    expect(resolveRegistrationOpen(undefined)).toBe(true);
    expect(resolveRegistrationOpen("")).toBe(true);
    expect(resolveRegistrationOpen("   ")).toBe(true);
  });

  it("三种明确否定值 ⇒ 关闭（0 / false / off，容忍大小写与空格）", () => {
    for (const raw of ["0", "false", "off", " OFF ", "False"]) {
      expect(resolveRegistrationOpen(raw), raw).toBe(false);
    }
  });

  it("其余任何值 ⇒ 开放（拼错不得变成静默关闭）", () => {
    for (const raw of ["1", "true", "on", "yes", "no", "disabled", "x"]) {
      expect(resolveRegistrationOpen(raw), raw).toBe(true);
    }
  });
});
