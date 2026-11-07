import type { SubscriptionPolicyWrite } from "@media-track/workflow";

type PriorityGroup = NonNullable<SubscriptionPolicyWrite["priorityGroups"]>[number];

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
  if (typeof id !== "string" || !/^[\w-]{1,40}$/.test(id) || typeof name !== "string" || !name.trim() || name.length > 40) {
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
