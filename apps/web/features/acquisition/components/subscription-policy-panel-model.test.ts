import { describe, expect, it } from "vitest";
import {
  draftToPolicy,
  mapPolicyLoadResponse,
  mapPreviewResponse,
  mapSavedPolicy,
  previewHeadlineCopy,
  previewReasonCopy,
  ruleExcludesEverything,
  type PreviewOutcome,
} from "./subscription-policy-panel-model";

/**
 * 订阅策略面板的映射层测试（批次 5）。
 *
 * 重点断言 plan §4.1 对规则预览的要求，以及两条会让面板**说谎**的边界：
 *   ① **502 绝不能变成「0 命中」。** 搜索失败时没有诚实的数字可展示；把失败显示成
 *      「命中 0 个」会让人去放宽一条本来没问题的规则。
 *   ② **「排除了一切」与「没搜到」要分得开。** 前者是用户的规则写太严，后者是搜索没结果，
 *      屏幕上两行都写作 0——所以 ruleExcludesEverything 只在「有候选且命中 0」时为真。
 */

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
    ...overrides,
  };
}

describe("mapPreviewResponse — 200", () => {
  it("四个数 + 两份清单都读出来", () => {
    const state = mapPreviewResponse(200, outcome());
    expect(state.kind).toBe("previewed");
    if (state.kind !== "previewed") return;
    expect(state.outcome).toEqual(outcome());
  });

  it("**字段缺失/类型不对 ⇒ 0 / 空，不是 undefined**", () => {
    // 面板会把 undefined 渲染成 "命中 undefined 个"
    const state = mapPreviewResponse(200, {});
    if (state.kind !== "previewed") throw new Error("kind");
    expect(state.outcome.matchedCount).toBe(0);
    expect(state.outcome.excludedCount).toBe(0);
    expect(state.outcome.matched).toEqual([]);
    expect(state.outcome.excluded).toEqual([]);
  });

  it("excluded 里坏行被跳过，不是整份清单报废", () => {
    const state = mapPreviewResponse(200, {
      excluded: [{ name: "x", reason: "excluded" }, { name: "y" }, null, "z", { name: "w", reason: "?" }],
    });
    if (state.kind !== "previewed") throw new Error("kind");
    expect(state.outcome.excluded).toEqual([{ name: "x", reason: "excluded" }]);
  });

  it("matched 里非字符串被滤掉", () => {
    const state = mapPreviewResponse(200, { matched: ["a", 1, null, "b"] });
    if (state.kind !== "previewed") throw new Error("kind");
    expect(state.outcome.matched).toEqual(["a", "b"]);
  });
});

describe("mapPreviewResponse — 非 200", () => {
  it("**502 ⇒ failed，绝不是「命中 0 个」**", () => {
    const state = mapPreviewResponse(502, { error: "搜索失败，无法预览" });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.copy).toContain("搜索失败");
  });

  it("**429 ⇒ failed（限速，不是空结果）**", () => {
    const state = mapPreviewResponse(429, { error: "too many requests" });
    expect(state.kind).toBe("failed");
  });

  it("**400 ⇒ failed 且带上服务端的话**（看不懂的 filter 要让人看见错在哪）", () => {
    const state = mapPreviewResponse(400, { error: "episodeFilter 看不懂：形如 S01-S03" });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.copy).toContain("episodeFilter");
  });

  it("404 ⇒ failed", () => {
    expect(mapPreviewResponse(404, { error: "title not tracked" }).kind).toBe("failed");
  });

  it("**非 200 但没带 error ⇒ 有一句兜底文案，不是空字符串**", () => {
    const state = mapPreviewResponse(500, {});
    if (state.kind !== "failed") throw new Error("kind");
    expect(state.copy.length).toBeGreaterThan(0);
  });

  it("body 不是对象 ⇒ 不抛", () => {
    expect(mapPreviewResponse(502, null).kind).toBe("failed");
    expect(mapPreviewResponse(502, "x").kind).toBe("failed");
  });
});

describe("previewHeadlineCopy", () => {
  it("有候选时点名命中/排除/总数", () => {
    expect(previewHeadlineCopy(outcome())).toBe("命中 4 个，排除 6 个（共 10 个候选）");
  });

  it("**没搜到 ⇒ 说没搜到，并说明用了几个关键词**", () => {
    const copy = previewHeadlineCopy(outcome({ total: 0, matchedCount: 0, excludedCount: 0, matched: [], excluded: [] }));
    expect(copy).toContain("没搜到候选");
    expect(copy).toContain("3");
  });
});

describe("previewReasonCopy", () => {
  it("三种排除原因各有各的说法", () => {
    expect(previewReasonCopy("excluded")).toBe("命中排除词");
    expect(previewReasonCopy("missing_term")).toBe("缺必须包含的词");
    expect(previewReasonCopy("episode_filtered")).toBe("不在集数范围内");
  });
});

describe("ruleExcludesEverything", () => {
  it("有候选且命中 0 ⇒ true", () => {
    expect(ruleExcludesEverything(outcome({ matchedCount: 0 }))).toBe(true);
  });

  it("**没搜到 ⇒ false**（那是搜索的问题，不是规则的问题）", () => {
    expect(ruleExcludesEverything(outcome({ total: 0, matchedCount: 0 }))).toBe(false);
  });

  it("有命中 ⇒ false", () => {
    expect(ruleExcludesEverything(outcome())).toBe(false);
  });
});

describe("draftToPolicy — 草稿到线上形状", () => {
  const draft = (overrides: Partial<import("./subscription-policy-panel-model").PolicyDraft> = {}) => ({
    mustContain: "2160p, 简中",
    mustNotContain: "CAM, 枪版",
    episodeFilter: "S01-S02",
    useRegex: false,
    cooldownDays: 3,
    ...overrides,
  });

  it("逗号分隔的词表拆成数组", () => {
    expect(draftToPolicy(draft())).toEqual({
      mustContain: ["2160p", "简中"],
      mustNotContain: ["CAM", "枪版"],
      episodeFilter: "S01-S02",
      useRegex: false,
      cooldownDays: 3,
    });
  });

  it("**往返无损**（存进去的读回来还是同一份）", () => {
    const policy = draftToPolicy(draft());
    const readBack = mapSavedPolicy(policy);
    const again = readBack === null ? null : draftToPolicy(readBack);
    expect(again).toEqual(policy);
  });

  it("**空项被丢掉**（2160p, , 简中 是两个词，不是三个）", () => {
    // 空词会匹配一切，等于把过滤静默关掉
    expect(draftToPolicy(draft({ mustContain: "2160p, , 简中" })).mustContain).toEqual(["2160p", "简中"]);
    expect(draftToPolicy(draft({ mustContain: "  " })).mustContain).toEqual([]);
    expect(draftToPolicy(draft({ mustContain: "" })).mustContain).toEqual([]);
  });

  it("词表前后空格被 trim", () => {
    expect(draftToPolicy(draft({ mustContain: "  2160p  ,  简中  " })).mustContain).toEqual(["2160p", "简中"]);
  });

  it("episodeFilter 被 trim", () => {
    expect(draftToPolicy(draft({ episodeFilter: "  S01-S02  " })).episodeFilter).toBe("S01-S02");
  });
});

describe("mapSavedPolicy", () => {
  it("读回一份策略", () => {
    expect(
      mapSavedPolicy({
        mustContain: ["2160p"],
        mustNotContain: ["CAM"],
        episodeFilter: "S01-S02",
        useRegex: false,
        cooldownDays: 3,
      }),
    ).toEqual({
      mustContain: "2160p",
      mustNotContain: "CAM",
      episodeFilter: "S01-S02",
      useRegex: false,
      cooldownDays: 3,
    });
  });

  it("**null ⇒ null**（没配过，不是空草稿）", () => {
    expect(mapSavedPolicy(null)).toBeNull();
  });

  it("词表拼接成逗号分隔（面板用输入框编辑）", () => {
    const draft = mapSavedPolicy({ mustContain: ["2160p", "简中"], mustNotContain: [] });
    expect(draft?.mustContain).toBe("2160p, 简中");
    expect(draft?.mustNotContain).toBe("");
  });

  it("坏字段不抛", () => {
    expect(mapSavedPolicy({ mustContain: 5, cooldownDays: "x", useRegex: "yes" })).toEqual({
      mustContain: "",
      mustNotContain: "",
      episodeFilter: "",
      useRegex: false,
      cooldownDays: 0,
    });
  });
});

describe("mapPolicyLoadResponse — 挂载时回填（GET /api/titles/subscription-policy）", () => {
  /**
   * 这条映射修的是一个真 bug：面板此前从不 GET 已保存的策略，于是刷新页面后
   * 表单永远空白、标题永远说「还没配规则」——用户存过的规则从眼前消失。
   * 映射抽成纯函数，四种终局在没有 fetch 的情况下可测。
   */
  it("200 + 有策略 ⇒ 回填成草稿（刷新后规则还在眼前）", () => {
    const draft = mapPolicyLoadResponse(200, {
      policy: { mustContain: ["2160p", "简中"], mustNotContain: [], episodeFilter: "S01-S02", useRegex: true, cooldownDays: 3 },
    });
    expect(draft).toEqual({
      mustContain: "2160p, 简中",
      mustNotContain: "",
      episodeFilter: "S01-S02",
      useRegex: true,
      cooldownDays: 3,
    });
  });

  it("200 + policy: null ⇒ null（没配过规则，不是空草稿）", () => {
    expect(mapPolicyLoadResponse(200, { policy: null })).toBeNull();
  });

  it("404（这部片没被追踪）⇒ null，降级成「还没配规则」而不是抛到页面外", () => {
    expect(mapPolicyLoadResponse(404, { error: "title not tracked" })).toBeNull();
  });

  it("5xx ⇒ null（网络/上游失败同样降级，面板仍是可用表单）", () => {
    expect(mapPolicyLoadResponse(502, { error: "boom" })).toBeNull();
  });

  it("200 但 body 形状坏了 ⇒ null（不让坏数据进表单）", () => {
    expect(mapPolicyLoadResponse(200, { policy: "garbage" })).toBeNull();
    expect(mapPolicyLoadResponse(200, null)).toBeNull();
  });
});
