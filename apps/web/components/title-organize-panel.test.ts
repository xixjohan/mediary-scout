import { describe, expect, it } from "vitest";
import {
  mapOrganizeResponse,
  unresolvedReasonCopy,
  type OrganizeReviewFile,
} from "./title-organize-panel";

/**
 * Batch 4 的 L2 前端呈现（plan §3.4）。
 *
 * 验收「命名混乱的包 → 进 manual_review 而非静默放错」的浏览器侧半边：响应必须被
 * 读成一个**要用户点头的清单**，而不是一个进度条。所以断言集中在
 * mapOrganizeResponse 的四种终局上——尤其 409 绝不能变成「成功」。
 */

function reviewFile(overrides: Partial<OrganizeReviewFile> = {}): OrganizeReviewFile {
  return { fileId: "f1", fileName: "Show S01E01.mkv", ...overrides };
}

describe("mapOrganizeResponse — 200 organized", () => {
  it("读出 moves", () => {
    const state = mapOrganizeResponse(200, {
      status: "organized",
      copy: "整理计划：2 个文件可确定性放置",
      moves: [reviewFile(), reviewFile({ fileId: "f2", fileName: "Show S01E02.mkv" })],
    });
    expect(state.kind).toBe("organized");
    if (state.kind !== "organized") return;
    expect(state.moves).toHaveLength(2);
    expect(state.copy).toContain("确定性放置");
  });

  it("moves 缺失时退化为空数组（不是崩）", () => {
    const state = mapOrganizeResponse(200, { status: "organized", copy: "x" });
    expect(state.kind).toBe("organized");
    if (state.kind !== "organized") return;
    expect(state.moves).toEqual([]);
  });
});

describe("mapOrganizeResponse — 200 manual_review", () => {
  it("**拆出 placeable 与 unresolved 两组**", () => {
    const state = mapOrganizeResponse(200, {
      status: "manual_review",
      copy: "整理计划：1 个文件可放置，1 个需人工复核",
      review: {
        placeable: [reviewFile()],
        unresolved: [reviewFile({ fileId: "f2", fileName: "random.mp4", reason: "no_episode_code" })],
      },
    });
    expect(state.kind).toBe("manual_review");
    if (state.kind !== "manual_review") return;
    expect(state.placeable).toHaveLength(1);
    expect(state.unresolved).toHaveLength(1);
    expect(state.unresolved[0]!.fileName).toBe("random.mp4");
  });

  it("**unresolved 带 reason 和建议集号**（用户要拿它改判）", () => {
    const state = mapOrganizeResponse(200, {
      status: "manual_review",
      copy: "x",
      review: {
        placeable: [],
        unresolved: [
          reviewFile({
            fileName: "海贼王 第1050集.mp4",
            reason: "ambiguous_season",
            suggestedEpisodeCode: "S01E1050",
          }),
        ],
      },
    });
    if (state.kind !== "manual_review") throw new Error("unexpected");
    expect(state.unresolved[0]!.reason).toBe("ambiguous_season");
    expect(state.unresolved[0]!.suggestedEpisodeCode).toBe("S01E1050");
  });

  it("review 字段整体缺失时不崩", () => {
    const state = mapOrganizeResponse(200, { status: "manual_review", copy: "x" });
    if (state.kind !== "manual_review") throw new Error("unexpected");
    expect(state.placeable).toEqual([]);
    expect(state.unresolved).toEqual([]);
  });
});

describe("mapOrganizeResponse — 409 是停止，不是成功", () => {
  it("drift ⇒ stopped，带 409", () => {
    const state = mapOrganizeResponse(409, {
      status: "drift",
      copy: "整理中断：1 个文件没有搬到目标目录（Show S01E02.mkv）",
    });
    expect(state.kind).toBe("stopped");
    if (state.kind !== "stopped") return;
    expect(state.status).toBe(409);
    expect(state.copy).toContain("整理中断");
  });

  it("failed ⇒ stopped", () => {
    const state = mapOrganizeResponse(409, { status: "failed", copy: "drive gone" });
    expect(state.kind).toBe("stopped");
    if (state.kind !== "stopped") return;
    expect(state.copy).toBe("drive gone");
  });

  it("**409 绝不映射成 organized**（盘没确认就不能说成功）", () => {
    const state = mapOrganizeResponse(409, { status: "organized", copy: "x", moves: [] });
    expect(state.kind).toBe("stopped");
  });

  it("未知状态码也当作停止（fail-closed）", () => {
    for (const status of [400, 401, 404, 500]) {
      expect(mapOrganizeResponse(status, { copy: "x" }).kind).toBe("stopped");
    }
  });

  it("非 JSON 体（null）不崩", () => {
    const state = mapOrganizeResponse(500, null);
    expect(state.kind).toBe("stopped");
    if (state.kind !== "stopped") return;
    expect(state.copy).toBe("");
  });
});

describe("unresolvedReasonCopy", () => {
  it("三种原因各有可读文案", () => {
    expect(unresolvedReasonCopy(reviewFile({ reason: "no_episode_code" }))).toContain("集号");
    expect(unresolvedReasonCopy(reviewFile({ reason: "ambiguous_season" }))).toContain("哪一季");
    expect(unresolvedReasonCopy(reviewFile({ reason: "duplicate_episode_code" }))).toContain("同一集");
  });

  it("未知原因有兜底文案（不显示 undefined）", () => {
    expect(unresolvedReasonCopy(reviewFile())).toBe("无法自动放置");
  });
});
