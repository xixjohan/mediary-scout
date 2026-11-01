/** 设置页 tab 的纯模型：id/标签/解析/URL 写回。UI 无关，node 环境可测。 */

export const SETTINGS_TABS = [
  { id: "drives", label: "网盘" },
  { id: "services", label: "资源与服务" },
  { id: "preferences", label: "获取偏好" },
  { id: "patrol", label: "巡检与通知" },
  { id: "account", label: "账号与用户" },
  { id: "remote", label: "远程访问" },
  { id: "update", label: "更新" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = "drives";

const TAB_IDS = new Set<string>(SETTINGS_TABS.map((tab) => tab.id));

/**
 * 仅远程访问（桌面版无）与更新（演示站藏）由运行时插槽内容决定显隐。
 * 「账号与用户」为核心基础面板，原生常驻显示，绝不被动态观察误杀。
 */
export const OBSERVED_SETTINGS_TABS = ["remote", "update"] as const;

export type ObservedSettingsTabId = (typeof OBSERVED_SETTINGS_TABS)[number];

/** 受观察 tab 的可见性映射。缺省 = 不可见（fail-closed，与 tablist 保持一致）。 */
export type SettingsTabVisibility = Partial<Record<ObservedSettingsTabId, boolean>>;

/** legacy 深链锚点（account-identity 菜单）→ 账号 tab。 */
const ACCOUNT_HASHES = new Set(["#password", "#accounts", "#roles"]);

export function resolveSettingsTab(
  param: string | null | undefined,
  visible: SettingsTabVisibility | boolean,
  hash?: string,
): SettingsTabId {
  const visibility: SettingsTabVisibility =
    typeof visible === "boolean" ? {} : visible;
  const candidate =
    param && TAB_IDS.has(param)
      ? (param as SettingsTabId)
      : !param && hash && ACCOUNT_HASHES.has(hash)
        ? "account"
        : DEFAULT_SETTINGS_TAB;
  if (isObservedTab(candidate) && visibility[candidate] !== true) return DEFAULT_SETTINGS_TAB;
  return candidate;
}

function isObservedTab(tab: SettingsTabId): tab is ObservedSettingsTabId {
  return (OBSERVED_SETTINGS_TABS as readonly SettingsTabId[]).includes(tab);
}

/** 写回 URL query：保留其他参数（?w 工作区）；默认 tab 不留 tab 参数。 */
export function settingsTabQuery(current: URLSearchParams, tab: SettingsTabId): string {
  const next = new URLSearchParams(current);
  if (tab === DEFAULT_SETTINGS_TAB) next.delete("tab");
  else next.set("tab", tab);
  next.sort();
  return next.toString();
}
