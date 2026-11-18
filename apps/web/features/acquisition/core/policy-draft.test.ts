import { describe, expect, it } from "vitest";
import { PRIORITY_GROUP_ID_MAX_LENGTH } from "../../../lib/subscription-policy-validation";
import {
  PRESETS,
  createBlankDraft,
  draftToPolicy,
  joinTerms,
  makePriorityGroup,
  mapPolicyLoadResponse,
  mapSavedPolicy,
  splitTerms,
  toggleTerm,
  validateDraft,
  type PolicyDraft,
} from "./policy-draft";
import {
  diagnoseEmptyPreview,
  formatPreviewThrottleCopy,
  mapPreviewResponse,
  previewHeadlineCopy,
  previewReasonCopy,
  reducePreviewState,
  ruleExcludesEverything,
  type PreviewOutcome,
  type PreviewState,
} from "./policy-preview";

/**
 * 共享适配层与预览状态的测试（G1/G2/G3/G4/G7）。
 *
 * 这些断言防的是「同一逻辑两份实现」这一类缺陷：ID 长度两端不一致、全角逗号不切、
 * 正则被逗号切碎、预览迟到结果覆盖新表单。
 */

function draft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return { ...createBlankDraft(), subtitleTerms: "", ...overrides };
}

function outcome(overrides: Partial<PreviewOutcome> = {}): PreviewOutcome {
  return {
    searchedKeywords: 3,
    total: 10,
    matchedCount: 4,
    excludedCount: 6,
    matched: ["a", "b", "c", "d"],
    excluded: [
      { name: "x", reason: "excluded" },
      { name: "y", reason: "missing_term" },
      { name: "z", reason: "episode_filtered" },
    ],
    matchedWithSubtitleCount: 0,
    matchedPackCount: 0,
    excludedByReason: {},
    cached: false,
    ...overrides,
  };
}

describe("G1 优先级组 ID 落在服务端上限内", () => {
  it("有 randomUUID 时生成 ≤ 64 字符的 ID（不再 42 字符被拒）", () => {
    const group = makePriorityGroup();
    expect(group.id.length).toBeLessThanOrEqual(PRIORITY_GROUP_ID_MAX_LENGTH);
    expect(group.id).toMatch(/^[\w-]+$/);
    expect(group.id.startsWith("group_")).toBe(true);
  });

  it("无 randomUUID 的 HTTP 上下文同样 ≤ 64 字符", () => {
    const group = makePriorityGroup(null, () => 0.5);
    expect(group.id.length).toBeLessThanOrEqual(PRIORITY_GROUP_ID_MAX_LENGTH);
  });

  it("同一时刻生成的 ID 不重复", () => {
    const ids = new Set([makePriorityGroup(), makePriorityGroup(), makePriorityGroup()].map((group) => group.id));
    expect(ids.size).toBe(3);
  });
});

describe("G2 草稿往返与分词", () => {
  it("全角逗号 / 顿号 / 分号 / 空白都切成同一组词", () => {
    for (const input of ["2160p，简中", "2160p、简中", "2160p；简中", "2160p 简中", "2160p, 简中"]) {
      expect(splitTerms(input, false)).toEqual(["2160p", "简中"]);
    }
  });

  it("正则模式按行切，不切逗号（S\\d{2,3} 必须保持完整）", () => {
    expect(splitTerms("S\\d{2,3}\nCAM", true)).toEqual(["S\\d{2,3}", "CAM"]);
    expect(splitTerms("S\\d{2,3},CAM", true)).toEqual(["S\\d{2,3},CAM"]);
  });

  it("往返无损：draft → policy → draft 得到同一份词表", () => {
    const original = draft({ mustContain: "2160p, 简中", mustNotContain: "CAM", episodeFilter: "S01-S02", cooldownDays: 3 });
    const policy = draftToPolicy(original);
    const readBack = mapSavedPolicy(policy);
    expect(readBack).not.toBeNull();
    expect(draftToPolicy(readBack!)).toEqual(policy);
  });

  it("全角逗号往返也还原成两个词（不是带全角逗号的一个词）", () => {
    const policy = draftToPolicy(draft({ mustContain: "1080p，简中" }));
    expect(policy.mustContain).toEqual(["1080p", "简中"]);
    expect(joinTerms(policy.mustContain, false)).toBe("1080p, 简中");
  });

  it("空白与重复被丢弃", () => {
    expect(draftToPolicy(draft({ mustContain: "2160p, , 2160p, 简中" })).mustContain).toEqual(["2160p", "简中"]);
  });

  it("toggleTerm 增删可逆、大小写不敏感", () => {
    const once = toggleTerm("1080p", "HDR", false);
    expect(once).toBe("1080p, HDR");
    expect(toggleTerm(once, "hdr", false)).toBe("1080p");
  });
});

describe("G3 默认与预设不再把字幕做成 AND 硬条件", () => {
  /** 仓库内真实标题样本（来自 user-message-thread 测试夹具）。 */
  const REAL_TITLE = "[喵萌奶茶屋] 黄泉的使者 13 [1080p][简日双语]";

  it("没有任何预设的 mustContain 含「简中字幕」四字连写", () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.build(createBlankDraft()).mustContain).not.toContain("简中字幕");
    }
  });

  it("默认 1080p 规则能命中真实的带字幕 1080p 标题", () => {
    const defaultDraft = PRESETS["1080p"].build(createBlankDraft());
    const policy = draftToPolicy(defaultDraft);
    // mustContain 只剩画质词，因此这条真实标题可以通过词表检查。
    expect(policy.mustContain).toEqual(["1080p"]);
    expect(REAL_TITLE.toLowerCase()).toContain(policy.mustContain[0]!.toLowerCase());
  });

  it("字幕偏好默认 require=false，词表覆盖 CHS/简繁/双语/中字/内嵌", () => {
    const policy = draftToPolicy(PRESETS["1080p"].build(createBlankDraft()));
    expect(policy.subtitlePreference?.require).toBe(false);
    for (const term of ["CHS", "简繁", "双语", "中字", "内嵌"]) {
      expect(policy.subtitlePreference?.terms).toContain(term);
    }
  });
});

describe("G7 本地预检", () => {
  it("看不懂的集数写法就地报错", () => {
    const issues = validateDraft(draft({ episodeFilter: "第一季" }));
    expect(issues[0]?.field).toBe("episodeFilter");
  });

  it("坏正则就地报错", () => {
    const issues = validateDraft(draft({ useRegex: true, mustContain: "([", mustNotContain: "" }));
    expect(issues[0]?.field).toBe("mustContain");
  });

  it("正常草稿没有问题", () => {
    expect(validateDraft(draft({ episodeFilter: "S01-S03" }))).toEqual([]);
  });
});

describe("预览响应映射", () => {
  it("200 读全字段（含字幕计数 / 缓存 / 源健康）", () => {
    const mapped = mapPreviewResponse(200, { ...outcome(), matchedWithSubtitleCount: 2, cached: true, sourceHealth: { status: "healthy", unhealthySources: [] } });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.outcome.matchedWithSubtitleCount).toBe(2);
    expect(mapped.outcome.cached).toBe(true);
  });

  it("502 不是「0 命中」", () => {
    const mapped = mapPreviewResponse(502, { error: "搜索失败，无法预览" });
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.copy).toContain("搜索失败");
  });

  it("**429 带 retryAfterMs 且文案说出剩余秒数**（裸「稍后再试」会让人反复点到全被拒）", () => {
    const mapped = mapPreviewResponse(429, { error: "预览太频繁", retryAfterMs: 12_000 });
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.retryAfterMs).toBe(12_000);
    expect(mapped.copy).toContain("12 秒");
  });

  it("429 没带 retryAfterMs ⇒ 按 60 秒兜底并写出秒数", () => {
    const mapped = mapPreviewResponse(429, {});
    if (mapped.ok) throw new Error("应当失败");
    expect(mapped.retryAfterMs).toBe(60_000);
    expect(mapped.copy).toContain("60 秒");
  });

  it("formatPreviewThrottleCopy 把毫秒向上取整成秒", () => {
    expect(formatPreviewThrottleCopy(9_024)).toContain("10 秒");
    expect(formatPreviewThrottleCopy(500)).toContain("1 秒");
  });

  it("字幕缺失的排除原因有独立文案", () => {
    expect(previewReasonCopy("subtitle_missing")).toContain("字幕");
  });
});

describe("G4/G6 空态诊断顺序", () => {
  it("源异常优先于「规则太严」", () => {
    expect(diagnoseEmptyPreview({
      outcome: outcome({ matchedCount: 0, sourceHealth: { status: "unreachable", unhealthySources: ["pansou"] } }),
      hasPriorityGroups: false,
    })).toBe("source_error");
  });

  it("未上映优先于无候选", () => {
    expect(diagnoseEmptyPreview({
      outcome: outcome({ matchedCount: 0, total: 0, releaseDate: "2099-01-01" }),
      hasPriorityGroups: false,
      now: "2026-11-16",
    })).toBe("unreleased");
  });

  it("全被优先级组排掉时给出专属提示", () => {
    expect(diagnoseEmptyPreview({
      outcome: outcome({ matchedCount: 0, excluded: [{ name: "x", reason: "priority_unmatched" }] }),
      hasPriorityGroups: true,
    })).toBe("priority_unmatched");
  });

  it("有命中时不需要诊断", () => {
    expect(diagnoseEmptyPreview({ outcome: outcome(), hasPriorityGroups: false })).toBeNull();
  });

  it("ruleExcludesEverything 不把「没搜到」读成「规则太严」", () => {
    expect(ruleExcludesEverything(outcome({ matchedCount: 0 }))).toBe(true);
    expect(ruleExcludesEverything(outcome({ matchedCount: 0, total: 0 }))).toBe(false);
  });

  it("headline 说出「其中 N 个带中文字幕」与缓存", () => {
    const copy = previewHeadlineCopy(outcome({ matchedWithSubtitleCount: 2, cached: true }));
    expect(copy).toContain("2 个带中文字幕");
    expect(copy).toContain("缓存结果");
  });

  it("**headline 说明整季包与单集不是同一单位**（「137 条」到底是多少内容）", () => {
    const copy = previewHeadlineCopy(outcome({ matchedCount: 137, excludedCount: 158, total: 295, matchedPackCount: 20 }));
    expect(copy).toContain("命中 137 条");
    expect(copy).toContain("20 条为整季包");
  });

  it("无整季包时 headline 不多嘴", () => {
    expect(previewHeadlineCopy(outcome())).not.toContain("整季包");
  });

  it("**排除原因多是「别的作品」⇒ 诊断为 wrong_title**（指向搜索召回，不是规则太严）", () => {
    expect(diagnoseEmptyPreview({
      outcome: outcome({
        matchedCount: 0,
        excluded: [
          { name: "a", reason: "wrong_title" },
          { name: "b", reason: "wrong_title" },
          { name: "c", reason: "missing_term" },
        ],
        excludedByReason: { wrong_title: 2, missing_term: 1 },
      }),
      hasPriorityGroups: false,
    })).toBe("wrong_title");
  });

  it("排除原因是「缺包含词」为主 ⇒ 仍诊断为规则太严", () => {
    expect(diagnoseEmptyPreview({
      outcome: outcome({
        matchedCount: 0,
        excluded: [
          { name: "a", reason: "missing_term" },
          { name: "b", reason: "missing_term" },
          { name: "c", reason: "wrong_title" },
        ],
        excludedByReason: { missing_term: 2, wrong_title: 1 },
      }),
      hasPriorityGroups: false,
    })).toBe("rule_excludes_all");
  });

  it("wrong_title 有独立文案", () => {
    expect(previewReasonCopy("wrong_title")).toContain("不是同一部作品");
  });
});

describe("预览状态机：迟到的旧结果被丢弃", () => {
  const start = (requestId: string): PreviewState => ({ kind: "previewing", requestId, progress: { done: 0, total: 0 } });

  it("旧 requestId 的 done 不会覆盖新一次预览", () => {
    const state = start("r2");
    expect(reducePreviewState(state, { type: "done", requestId: "r1", outcome: outcome() })).toBe(state);
  });

  it("invalidate 回到 idle，之后的旧事件全部忽略", () => {
    const invalidated = reducePreviewState(start("r1"), { type: "invalidated" });
    expect(invalidated.kind).toBe("idle");
    expect(reducePreviewState(invalidated, { type: "done", requestId: "r1", outcome: outcome() })).toBe(invalidated);
  });

  it("progress 与 done 按同一 requestId 推进", () => {
    const progressed = reducePreviewState(start("r3"), { type: "progress", requestId: "r3", progress: { done: 2, total: 4 } });
    expect(progressed.kind).toBe("previewing");
    if (progressed.kind !== "previewing") return;
    expect(progressed.progress.done).toBe(2);
    expect(reducePreviewState(progressed, { type: "done", requestId: "r3", outcome: outcome() }).kind).toBe("previewed");
  });
});

describe("mapPolicyLoadResponse", () => {
  it("404 / 坏形状 ⇒ null（降级成「还没配规则」）", () => {
    expect(mapPolicyLoadResponse(404, { error: "title not tracked" })).toBeNull();
    expect(mapPolicyLoadResponse(200, { policy: "garbage" })).toBeNull();
    expect(mapPolicyLoadResponse(500, null)).toBeNull();
  });

  it("200 + 策略 ⇒ 回填草稿，含字幕偏好", () => {
    const loaded = mapPolicyLoadResponse(200, {
      policy: {
        mustContain: ["2160p"],
        mustNotContain: [],
        subtitlePreference: { terms: ["CHS"], require: true },
      },
    });
    expect(loaded?.mustContain).toBe("2160p");
    expect(loaded?.subtitleRequire).toBe(true);
    expect(loaded?.subtitleTerms).toBe("CHS");
  });
});
