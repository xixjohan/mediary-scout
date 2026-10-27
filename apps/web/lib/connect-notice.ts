/**
 * Connect notice — 顶栏横幅（S5.1 已整体移除）。
 *
 * 原两态（未开通推广 / 已开通确认且可关闭）连同一个 dismissed key 常量全部
 * 清空：那个 localStorage key 零引用，留着只会让人以为关闭逻辑还活着。
 * 本文件只保留永久保险丝（见下）。
 */

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
