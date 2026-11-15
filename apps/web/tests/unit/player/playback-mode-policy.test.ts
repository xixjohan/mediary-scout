import { describe, expect, it } from "vitest";
import {
  isPlaybackModeLocked,
  shouldHonorDeliveryPreference,
  shouldHonorDeliveryQuery,
} from "../../../lib/playback-mode-policy";

/**
 * 需求 2 的服务端策略：普通用户只能使用影视库设置的方式播放。
 *
 * 判据是 `storage:browse_any`（能否改盘上任意目录），而不是角色名——理由：
 * 能任意改盘的人本来就有完整运维权，再禁止他自选播放方式没有意义；而标准成员
 * 不该在播放器里制造"库配置 vs 我的偏好"两套真相。
 */

const member = { isMaster: false, permissions: new Set(["storage:list", "media:play"]) };
const owner = { isMaster: true, permissions: new Set(["*"]) };
const admin = { isMaster: false, permissions: new Set(["storage:browse_any", "storage:list"]) };

describe("isPlaybackModeLocked", () => {
  it("标准成员 → 锁定（只能用影视库设置）", () => {
    expect(isPlaybackModeLocked(member)).toBe(true);
  });

  it("站长 / 通配符 / browse_any → 不锁（他们本来就有运维权）", () => {
    expect(isPlaybackModeLocked(owner)).toBe(false);
    expect(isPlaybackModeLocked(admin)).toBe(false);
    expect(isPlaybackModeLocked({ isMaster: false, permissions: new Set(["*"]) })).toBe(false);
  });

  it("没有安全上下文（外部 STRM 客户端）→ 不锁", () => {
    // 那类请求不属于"应用内播放器"这条需求；STRM 任务配置才是它的真相源。
    expect(isPlaybackModeLocked(null)).toBe(false);
    expect(isPlaybackModeLocked(undefined)).toBe(false);
  });

  it("成员持有 media:play 也不解锁（播放权限 ≠ 覆盖权）", () => {
    expect(isPlaybackModeLocked({ isMaster: false, permissions: new Set(["media:play"]) })).toBe(true);
  });
});

describe("两个读写入口的派生判定", () => {
  it("偏好读取与 query 覆盖同源：锁定时都不生效", () => {
    expect(shouldHonorDeliveryPreference(member)).toBe(false);
    expect(shouldHonorDeliveryQuery(member)).toBe(false);
  });

  it("未锁定时都生效", () => {
    expect(shouldHonorDeliveryPreference(owner)).toBe(true);
    expect(shouldHonorDeliveryQuery(owner)).toBe(true);
  });

  it("两者必须一致（否则会出现「能存偏好但读不到」的错位）", () => {
    for (const actor of [member, owner, admin, null]) {
      expect(shouldHonorDeliveryPreference(actor)).toBe(shouldHonorDeliveryQuery(actor));
    }
  });
});
