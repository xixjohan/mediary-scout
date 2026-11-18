import type { SubtitlePreference, SubscriptionPolicyWrite } from "@media-track/workflow";

type PriorityGroup = NonNullable<SubscriptionPolicyWrite["priorityGroups"]>[number];

/**
 * 优先级组 ID 的长度上限。
 *
 * 客户端历史上生成的是 `group_` + 完整 UUID（42 字符），超过 40 后被这里拒绝，
 * 于是「带任何优先级组的策略/模板都存不进」。现在两端共用一个上限，客户端
 * 生成 18 字符 ID（`group_` + 12 位十六进制），服务端放宽到 64 容忍旧 ID 的写法。
 */
export const PRIORITY_GROUP_ID_MAX_LENGTH = 64;

function parseGroupTerms(group: Record<string, unknown>, key: "mustContain" | "mustNotContain", index: number): string[] {
  const value = group[key] ?? [];
  if (!Array.isArray(value) || value.length > 12 || value.some((term) => typeof term !== "string" || term.length > 64)) {
    throw new Error(`第 ${index + 1} 组${key}无效`);
  }
  return value.map((term) => (term as string).trim()).filter(Boolean);
}

function parsePriorityGroup(value: unknown, index: number): PriorityGroup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`第 ${index + 1} 组格式错误`);
  const group = value as Record<string, unknown>;
  const id = group["id"];
  const name = group["name"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > PRIORITY_GROUP_ID_MAX_LENGTH ||
    !/^[\w-]+$/.test(id) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 40
  ) {
    throw new Error(`第 ${index + 1} 组名称或 ID 无效`);
  }
  return {
    id,
    name: name.trim(),
    mustContain: parseGroupTerms(group, "mustContain", index),
    mustNotContain: parseGroupTerms(group, "mustNotContain", index),
  };
}

export function parseSubscriptionPriorityGroups(value: unknown):
  | { ok: true; priorityGroups: PriorityGroup[] }
  | { ok: false; error: string } {
  try {
    const rawGroups = value ?? [];
    if (!Array.isArray(rawGroups) || rawGroups.length > 8) throw new Error("priorityGroups 最多支持 8 组");
    const priorityGroups = rawGroups.map(parsePriorityGroup);
    if (new Set(priorityGroups.map((group) => group.id)).size !== priorityGroups.length) {
      throw new Error("priorityGroups 的 ID 不能重复");
    }
    return { ok: true, priorityGroups };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "priorityGroups 无法解析" };
  }
}

/**
 * 字幕偏好校验。
 *
 * `terms` 是 OR 词表（任一词命中即有字幕）。空词表 + `require: true` 是自相矛盾的
 * 配置（要求必须有字幕，却没有任何词可判定），按 400 拒绝而不是静默放行——
 * 那种策略会把所有候选当「无字幕」拒掉。
 */
export function parseSubtitlePreference(value: unknown):
  | { ok: true; subtitlePreference: SubtitlePreference | undefined }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, subtitlePreference: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "subtitlePreference 必须是对象" };
  }
  const raw = value as Record<string, unknown>;
  const terms = raw["terms"] ?? [];
  if (!Array.isArray(terms) || terms.length > 32 || terms.some((term) => typeof term !== "string" || term.length > 32)) {
    return { ok: false, error: "subtitlePreference.terms 必须是最多 32 个不超过 32 字的字符串" };
  }
  const cleaned = [...new Set(terms.map((term) => (term as string).trim()).filter(Boolean))];
  const require = raw["require"] === true;
  if (require && cleaned.length === 0) {
    return { ok: false, error: "勾选「必须有中文字幕」时至少要有一个字幕词" };
  }
  return { ok: true, subtitlePreference: { terms: cleaned, require } };
}
