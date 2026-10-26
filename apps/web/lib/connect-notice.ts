/**
 * Connect notice — top banner on home page.
 *
 * 两态:
 * - 未开通(无 TUNNEL_TOKEN):推广横幅,邀请开通远程访问。
 * - 已开通(有 TUNNEL_TOKEN):「远程访问已上线」确认横幅(可关闭)。
 * Pure logic, testable without DB.
 */

export const CONNECT_NOTICE_DISMISSED_KEY = "connect_notice_dismissed_at";

export interface ConnectNoticeConditions {
  isDemo: boolean;
  /** 桌面版(Electron)不提供远程访问 —— 横幅绝不出现。 */
  isDesktop: boolean;
  accountId: string | null;
  dismissedAt: string | null;
  hasTunnelToken: boolean;
}

/**
 * 判断是否显示 Connect 通知横幅。
 *
 * S5.1（2026-10-27，用户需求 #1）：**横幅已整体移除**。此函数保留为
 * 永久保险丝——无论条件如何都返回 false，任何将来的重新接线都不可能
 * 让「🎉 付费远程访问现已上线」再次出现在页面上。
 */
export function shouldShowConnectNotice(
  _conditions: ConnectNoticeConditions
): boolean {
  return false;
}
