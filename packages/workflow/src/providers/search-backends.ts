/**
 * 检索后端的选择模型（单一真相）。
 *
 * 「用哪几个搜索源」曾经只由设置页隐式决定：配了 Prowlarr 就加 Prowlarr，
 * 配了海搜就加海搜，用户在检索时**无法只挑一家**。这里把「后端」提升为显式
 * 的枚举，三处共用：装配（`getWorkerResourceProvider`）、冷却/缓存键、UI 展示。
 *
 * 语义刻意是**收窄**而不是**开关**：选择只作用于本次检索；不带后端 = 沿用
 * 账号已配置的全部后端。品牌约束（目标盘能否接收磁力等）仍然优先，不会被
 * 一次选择绕过。
 */

export type SearchBackend = "pansou" | "prowlarr" | "haisou";

export const SEARCH_BACKENDS: readonly SearchBackend[] = ["pansou", "prowlarr", "haisou"];

export const SEARCH_BACKEND_LABELS: Record<SearchBackend, string> = {
  pansou: "盘搜（PanSou）",
  prowlarr: "Prowlarr（磁力 / PT）",
  haisou: "海搜（Haisou）",
};

export function isSearchBackend(value: unknown): value is SearchBackend {
  return typeof value === "string" && (SEARCH_BACKENDS as readonly string[]).includes(value);
}

/** 去重 + 规范化顺序 + 丢弃未知值。空数组保持为空（= 不限制）。 */
export function normalizeSearchBackends(values: readonly unknown[] | undefined): SearchBackend[] {
  if (values === undefined) return [];
  const seen = new Set<SearchBackend>();
  for (const value of values) {
    if (isSearchBackend(value)) seen.add(value);
  }
  return SEARCH_BACKENDS.filter((backend) => seen.has(backend));
}

/** 该盘**能不能**用某个后端（品牌维度，不看是否已配置）。
 *
 *  Prowlarr 产磁力，而夸克/UC/天翼没有磁力转存通道 —— 选了也只会得到一批
 *  转不进去的候选，所以在装配层就该跳过。 */
export function backendSupportsMagnet(brandKinds: readonly string[]): boolean {
  return brandKinds.includes("prowlarr") || brandKinds.includes("pansou-magnet");
}

/** 缓存/冷却键里代表「本次选了哪些后端」的一段：排序后的后端名，空 = all。
 *
 *  为什么必须进键：不同后端返回的候选集合不同（Prowlarr 只有磁力/PT，PanSou
 *  只有网盘分享）。若两把选择共用同一个键，先选「盘搜」再选「Prowlarr」会
 *  在 30 分钟内拿到上一次的缓存——用户以为换源成功了，实际什么都没变。 */
export function searchBackendsKey(backends: readonly SearchBackend[]): string {
  return backends.length === 0 ? "all" : [...backends].sort().join("+");
}
