import {
  DEFAULT_SUBTITLE_TERMS,
  parseEpisodeFilter,
  type SubtitlePreference,
  type SubscriptionPolicyWrite,
} from "@media-track/workflow";

/**
 * 订阅策略草稿的共享适配层。
 *
 * 这个模块是「UI 字符串 ⇄ 线上数组 ⇄ 已存策略/模板」三种形状的**唯一**转换实现。
 * 之前向导和作品详情面板各写一份 `mapSavedPolicy`/`draftToPolicy`/切分逻辑，
 * 于是「全角逗号不切分」「正则被逗号切碎」「优先级组 ID 超长」这些缺陷在两处
 * 各长各的。收敛到一处之后，两端行为一致，坏规则只可能有一种形状。
 *
 * 纯函数，不读时钟、不碰 I/O —— 可以直接在 node 里测。
 */

export interface SeasonEpisodeRangeDraft {
  seasonNumber: number;
  startEpisode: number;
  endEpisode: number | null;
}

export interface PolicyPriorityGroupDraft {
  id: string;
  name: string;
  mustContain: string;
  mustNotContain: string;
}

export interface PolicyDraft {
  mustContain: string;
  mustNotContain: string;
  episodeFilter: string;
  useRegex: boolean;
  cooldownDays: number;
  customKeywords?: string;
  priorityGroups?: PolicyPriorityGroupDraft[];
  seasonEpisodeRanges?: SeasonEpisodeRangeDraft[];
  /** 必须有中文字幕（硬拒绝）。false = 字幕只是排序加分。 */
  subtitleRequire: boolean;
  /** 字幕词（OR 关系），逗号分隔显示。 */
  subtitleTerms: string;
}

export type PresetKind = "1080p" | "4k" | "anime" | "custom";

/**
 * 预设构造器（策略模式）。
 *
 * 每个预设只负责「把 base 草稿改成自己的硬条件」。关键约定：**画质词进 mustContain，
 * 字幕词不进**——字幕写法有 CHS/简繁/双语/中字/内嵌 等多种，做成 AND 子串会让
 * 规则恒 false（这正是默认 `1080p, 简中字幕` 的缺陷）。
 */
export const PRESETS: Record<PresetKind, { label: string; description: string; build: (base: PolicyDraft) => PolicyDraft }> = {
  "1080p": {
    label: "1080p 极速内嵌",
    description: "只看 1080p，排除枪版与预告片；字幕只做优选不强制",
    build: (base) => ({ ...base, mustContain: "1080p", mustNotContain: "CAM/枪版, 预告片" }),
  },
  "4k": {
    label: "4K 原盘",
    description: "只看 2160p，排除枪版、预告片与国语配音",
    build: (base) => ({ ...base, mustContain: "2160p", mustNotContain: "CAM/枪版, 预告片, 国语配音" }),
  },
  anime: {
    label: "动漫压制标准",
    description: "1080p 内嵌优先，排除先行版与枪版",
    build: (base) => ({ ...base, mustContain: "1080p, 简日内嵌", mustNotContain: "先行版, 枪版" }),
  },
  custom: {
    label: "自定义微调",
    description: "手动编辑全部规则",
    build: (base) => base,
  },
};

/** 新草稿的默认值：画质硬条件 + 字幕软偏好（require=false）。 */
export function createBlankDraft(): PolicyDraft {
  return {
    mustContain: "1080p",
    mustNotContain: "CAM/枪版, 预告片",
    episodeFilter: "",
    useRegex: false,
    cooldownDays: 0,
    customKeywords: "",
    priorityGroups: [],
    seasonEpisodeRanges: [],
    subtitleRequire: false,
    subtitleTerms: DEFAULT_SUBTITLE_TERMS.join(", "),
  };
}

/**
 * 优先级组 ID。
 *
 * 用 `crypto.randomUUID()` 的前 12 位而不是整串：整串是 36 字符，加上 `group_`
 * 前缀就是 42，超出服务端 64 上限曾经是 40 ⇒ 带优先级组的策略一律 400。
 * 12 位十六进制（48 bit）对「一个账号最多 8 组」的碰撞风险可以忽略。
 * 无 crypto 的 HTTP 上下文退回时间戳 + 随机后缀，长度同样受控。
 */
export function makePriorityGroup(
  cryptoApi: Pick<Crypto, "randomUUID"> | null = typeof globalThis.crypto === "undefined" ? null : globalThis.crypto,
  random: () => number = Math.random,
): PolicyPriorityGroupDraft {
  const uuid = typeof cryptoApi?.randomUUID === "function" ? cryptoApi.randomUUID() : null;
  const suffix = uuid !== null
    ? uuid.replace(/-/g, "").slice(0, 12)
    : `${Date.now().toString(36).slice(-6)}${Math.floor(random() * 0x1000000).toString(36).padStart(5, "0").slice(0, 6)}`;
  return { id: `group_${suffix}`, name: "新优先级", mustContain: "", mustNotContain: "" };
}

/**
 * 词表切分。
 *
 * - 非正则：逗号（全角/半角）、顿号、分号、空白都算分隔符。用户粘贴「2160p，简中」
 *   得到两个词，而不是一个带全角逗号的词。
 * - 正则：**按行切**，不按逗号 —— `S\d{2,3}` 里有逗号，按逗号切会把一个表达式
 *   劈成两个非法片段，结果整条规则排除一切。
 */
export function splitTerms(value: string, useRegex: boolean): string[] {
  const text = value ?? "";
  const parts = useRegex ? text.split(/\r?\n/) : text.split(/[,，、;；\s]+/);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of parts) {
    const term = part.trim();
    if (term.length === 0) continue;
    // 匹配本身是大小写不敏感的，重复词不会改变判定，只会让规则变长。
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/** 词表 → 编辑框显示。与 splitTerms 严格互为逆运算（同一 useRegex 下）。 */
export function joinTerms(terms: readonly string[], useRegex: boolean): string {
  return terms.join(useRegex ? "\n" : ", ");
}

/** 药丸 chip 的增删：已存在则移除，不存在则追加。比较忽略大小写。 */
export function toggleTerm(current: string, chip: string, useRegex: boolean): string {
  const token = chip.trim();
  if (!token) return current;
  const terms = splitTerms(current, useRegex);
  const exists = terms.some((term) => term.toLowerCase() === token.toLowerCase());
  const next = exists ? terms.filter((term) => term.toLowerCase() !== token.toLowerCase()) : [...terms, token];
  return joinTerms(next, useRegex);
}

/** 草稿 → 线上写形状。 */
export function draftToPolicy(draft: PolicyDraft): SubscriptionPolicyWrite {
  const custom = splitTerms(draft.customKeywords ?? "", draft.useRegex);
  const subtitleTerms = splitTerms(draft.subtitleTerms, false);
  const priorityGroups = (draft.priorityGroups ?? []).map((group) => ({
    id: group.id,
    name: group.name.trim(),
    mustContain: splitTerms(group.mustContain, draft.useRegex),
    mustNotContain: splitTerms(group.mustNotContain, draft.useRegex),
  }));
  return {
    mustContain: splitTerms(draft.mustContain, draft.useRegex),
    mustNotContain: splitTerms(draft.mustNotContain, draft.useRegex),
    episodeFilter: draft.episodeFilter.trim(),
    useRegex: draft.useRegex,
    cooldownDays: draft.cooldownDays,
    ...(custom.length > 0 ? { customKeywords: custom } : {}),
    priorityGroups,
    seasonEpisodeRanges: (draft.seasonEpisodeRanges ?? []).map((range) => ({ ...range })),
    subtitlePreference: { terms: subtitleTerms, require: draft.subtitleRequire && subtitleTerms.length > 0 },
  };
}

/**
 * 已存策略 → 草稿。`null` ⇒ null（没配过），绝不降级成空草稿 ——
 * 面板对 null 显示「还没配规则」，对空草稿显示一张填满的表单，两者不能混。
 */
export function mapSavedPolicy(policy: unknown): PolicyDraft | null {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return null;
  const parsed = policy as Record<string, unknown>;
  const useRegex = parsed["useRegex"] === true;
  // 没存过字幕偏好 ⇒ 用默认词表（软偏好、不强制）；存过则原样读回（含空词表）。
  // 不能用 `terms.length > 0 ? ... : default` 兜底：那样「用户主动清空」会被读成默认，
  // 往返不再无损。
  const subtitle = parsed["subtitlePreference"] === undefined
    ? { terms: [...DEFAULT_SUBTITLE_TERMS], require: false }
    : readSubtitlePreference(parsed["subtitlePreference"]);
  return {
    mustContain: joinTerms(stringList(parsed["mustContain"]), useRegex),
    mustNotContain: joinTerms(stringList(parsed["mustNotContain"]), useRegex),
    episodeFilter: typeof parsed["episodeFilter"] === "string" ? (parsed["episodeFilter"] as string) : "",
    useRegex,
    cooldownDays: num(parsed["cooldownDays"]),
    customKeywords: joinTerms(stringList(parsed["customKeywords"]), useRegex),
    priorityGroups: Array.isArray(parsed["priorityGroups"])
      ? parsed["priorityGroups"].flatMap((rawGroup): PolicyPriorityGroupDraft[] => {
          if (typeof rawGroup !== "object" || rawGroup === null) return [];
          const group = rawGroup as Record<string, unknown>;
          if (typeof group["id"] !== "string" || typeof group["name"] !== "string") return [];
          return [{
            id: group["id"],
            name: group["name"],
            mustContain: joinTerms(stringList(group["mustContain"]), useRegex),
            mustNotContain: joinTerms(stringList(group["mustNotContain"]), useRegex),
          }];
        })
      : [],
    seasonEpisodeRanges: Array.isArray(parsed["seasonEpisodeRanges"])
      ? parsed["seasonEpisodeRanges"].flatMap((entry): SeasonEpisodeRangeDraft[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const range = entry as Record<string, unknown>;
          if (!Number.isInteger(range["seasonNumber"]) || !Number.isInteger(range["startEpisode"])) return [];
          const end = range["endEpisode"];
          if (end !== null && !Number.isInteger(end)) return [];
          return [{ seasonNumber: range["seasonNumber"] as number, startEpisode: range["startEpisode"] as number, endEpisode: end as number | null }];
        })
      : [],
    subtitleRequire: subtitle.require,
    subtitleTerms: joinTerms(subtitle.terms, false),
  };
}

/** GET /api/titles/subscription-policy 的响应 → 草稿或 null（任何不诚实答案都降级成 null）。 */
export function mapPolicyLoadResponse(status: number, body: unknown): PolicyDraft | null {
  if (status !== 200 || typeof body !== "object" || body === null) return null;
  return mapSavedPolicy((body as Record<string, unknown>)["policy"]);
}

/**
 * 模板/草稿的本地预检。
 *
 * 服务端仍会校验（它是权威），但本地先跑一遍只为一个目的：把「集数写法看不懂」
 * 「正则编不过」这两类错误贴在输入框旁，而不是让用户点一次保存才知道。
 */
export function validateDraft(draft: PolicyDraft): { field: "episodeFilter" | "mustContain" | "mustNotContain" | "priorityGroups"; message: string }[] {
  const issues: { field: "episodeFilter" | "mustContain" | "mustNotContain" | "priorityGroups"; message: string }[] = [];
  if (parseEpisodeFilter(draft.episodeFilter) === null) {
    issues.push({ field: "episodeFilter", message: "集数写法看不懂：形如 S01-S03、E01-E10、S02E05，用分号隔开" });
  }
  if (draft.useRegex) {
    for (const [field, label] of [["mustContain", "必须包含"], ["mustNotContain", "必须排除"]] as const) {
      const bad = splitTerms(draft[field], true).find((term) => !compiles(term));
      if (bad !== undefined) issues.push({ field, message: `${label}里的正则「${bad}」无法编译` });
    }
  }
  for (const group of draft.priorityGroups ?? []) {
    if (group.mustContain.trim() === "" && group.mustNotContain.trim() === "") continue;
    if (!group.name.trim()) {
      issues.push({ field: "priorityGroups", message: "优先级组需要填写组名" });
      break;
    }
  }
  return issues;
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

function readSubtitlePreference(value: unknown): SubtitlePreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { terms: [], require: false };
  }
  const raw = value as Record<string, unknown>;
  return {
    terms: Array.isArray(raw["terms"]) ? stringList(raw["terms"]) : [],
    require: raw["require"] === true,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
