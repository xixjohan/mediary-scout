import { describe, it, expect } from "vitest";
import { shouldShowConnectNotice } from "./connect-notice";
import type { ConnectNoticeConditions } from "./connect-notice";

/**
 * S5.1（2026-10-27）：付费远程访问横幅已整体移除（用户需求 #1）。
 * 保留纯函数作为"永久关闭"的保险丝：即便将来有人重新接线，
 * 它也永远返回 false，横幅不可能再出现在任何页面上。
 */
describe("shouldShowConnectNotice", () => {
  const baseConditions: ConnectNoticeConditions = {
    isDemo: false,
    isDesktop: false,
    accountId: "acc_123",
    dismissedAt: null,
    hasTunnelToken: false,
  };

  it("横幅已移除：任何条件组合都不再显示", () => {
    expect(shouldShowConnectNotice(baseConditions)).toBe(false);
    expect(shouldShowConnectNotice({ ...baseConditions, isDemo: true })).toBe(false);
    expect(shouldShowConnectNotice({ ...baseConditions, isDesktop: true })).toBe(false);
    expect(shouldShowConnectNotice({ ...baseConditions, accountId: null })).toBe(false);
    expect(shouldShowConnectNotice({ ...baseConditions, dismissedAt: "2026-10-27T00:00:00.000Z" })).toBe(false);
    expect(shouldShowConnectNotice({ ...baseConditions, hasTunnelToken: true })).toBe(false);
  });
});
