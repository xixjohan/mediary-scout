/**
 * 统一账号展示名称与头像徽章格式化纯函数（服务端与客户端共享，彻底杜绝水合不一致）。
 */

export function formatAccountDisplayName(username?: string | null): string {
  if (!username) return "管理员";
  const trimmed = username.trim();
  if (!trimmed || trimmed === "default" || trimmed === "acct_default") {
    return "管理员";
  }
  return trimmed;
}

export function formatAccountInitial(displayName?: string | null): string {
  const name = formatAccountDisplayName(displayName).trim();
  return name.charAt(0).toUpperCase() || "管";
}
