import { describe, expect, it } from "vitest";
import {
  comparePlannedVsActual,
  planOrganizeMoves,
  seasonNumberFromEpisodeCode,
  type OrganizeInputFile,
} from "../src/organize-plan.js";

/**
 * Batch 4 的决策半边（plan §3.4 / §3.6）。
 *
 * 三条验收各自对应一组用例：
 *   ① 命名规范的单季包 → L1 全自动放对
 *   ② 命名混乱的包 → 进 manual_review 而非静默放错
 *   ③ planned 与 actual 不一致 → 停止并报人工
 *
 * 这里刻意不碰网盘：目录 id 由注入的 resolver 给出。真正被测的是「哪些文件敢放、
 * 哪些不敢、为什么」，以及「执行结果与计划不符时能不能发现」。
 */

function file(fileName: string, fileId = fileName): OrganizeInputFile {
  return { fileId, fileName };
}

/** 单季 TV 包的规范命名。 */
function wellNamed(): OrganizeInputFile[] {
  return [
    file("孤独摇滚 S01E01.mkv"),
    file("孤独摇滚 S01E02.mkv"),
    file("孤独摇滚 S01E03.mkv"),
    file("孤独摇滚 S01E04.mkv"),
  ];
}

function plan(
  files: readonly OrganizeInputFile[],
  targetSeasons: readonly number[] = [1],
  dirFor: (season: number) => string = (season) => `dir_S${season}`,
) {
  return planOrganizeMoves({ files, targetSeasons, resolveTargetDirectory: dirFor });
}

describe("seasonNumberFromEpisodeCode", () => {
  it("SxxExx 带出季号", () => {
    expect(seasonNumberFromEpisodeCode("S01E05")).toBe(1);
    expect(seasonNumberFromEpisodeCode("S12E1050")).toBe(12);
  });

  it("返回的是码自己的声明，不是文件名的事实", () => {
    // 「第1050集」被规范化成 S01E1050，季号是上游假定的默认值。这个函数如实返回 1
    // （码确实这么写），但**调用方必须另问 episodeCodeNamesSeason**——否则就是把
    // 一个假定当成事实，而那正是「静默放错季」的来路。
    expect(seasonNumberFromEpisodeCode("S01E1050")).toBe(1);
    expect(seasonNumberFromEpisodeCode("S02E01")).toBe(2);
  });
});

describe("planOrganizeMoves — ① 命名规范的单季包走 L1", () => {
  it("四集全部解析出唯一集码 ⇒ deterministic，四条 move", () => {
    const result = plan(wellNamed());
    expect(result.kind).toBe("deterministic");
    if (result.kind !== "deterministic") return;
    expect(result.moves).toHaveLength(4);
    expect(result.moves.map((m) => m.episodeCode)).toEqual([
      "S01E01",
      "S01E02",
      "S01E03",
      "S01E04",
    ]);
  });

  it("每条 move 都带目标目录（由注入的 resolver 给出，不自己猜）", () => {
    const result = plan(wellNamed(), [1], (season) => `show_${season}_dir`);
    if (result.kind !== "deterministic") throw new Error("unexpected");
    for (const move of result.moves) {
      expect(move.targetDirectoryId).toBe("show_1_dir");
      expect(move.seasonNumber).toBe(1);
    }
  });

  it("文件名里的季号与目标季一致时才放行", () => {
    const result = plan([file("Show S02E01.mkv")], [2]);
    expect(result.kind).toBe("deterministic");
    if (result.kind !== "deterministic") return;
    expect(result.moves[0]!.seasonNumber).toBe(2);
  });

  it("空包 ⇒ deterministic 零条（不是 manual_review）", () => {
    const result = plan([]);
    expect(result.kind).toBe("deterministic");
  });
});

describe("planOrganizeMoves — ② 命名混乱进 manual_review", () => {
  it("解析不出集码 ⇒ no_episode_code，**不放置**", () => {
    const result = plan([...wellNamed(), file("random-clip.mp4")]);
    expect(result.kind).toBe("manual_review");
    if (result.kind !== "manual_review") return;
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.reason).toBe("no_episode_code");
    expect(result.unresolved[0]!.fileName).toBe("random-clip.mp4");
    // 能放的仍然放进 moves，供前端预填——但不执行
    expect(result.moves).toHaveLength(4);
  });

  it("一个包跨多季 ⇒ 目标季不唯一 ⇒ ambiguous_season", () => {
    const result = plan([file("Show S01E01.mkv"), file("Show S02E01.mkv")], [1, 2]);
    // 两个文件各自季号明确、且都在 targetSeasons 里 ⇒ 其实可以放。
    // 真正的不唯一来自「第 N 集」这种不带季号的名字：
    expect(result.kind).toBe("deterministic");
  });

  it("**第 N 集 + 多个候选季 ⇒ ambiguous_season**（不猜）", () => {
    // 文件名没说季号，targetSeasons 有两个 ⇒ 目标季不唯一 ⇒ 转人工
    const result = plan([file("海贼王 第1050集.mp4")], [1, 2]);
    expect(result.kind).toBe("manual_review");
    if (result.kind !== "manual_review") return;
    expect(result.unresolved[0]!.reason).toBe("ambiguous_season");
    expect(result.unresolved[0]!.suggestedEpisodeCode).toBe("S01E1050");
  });

  it("第 N 集 + 唯一目标季 ⇒ 可以放，**且集码按该季重打**", () => {
    // 文件否认知季号，所以落库的集码绝不能继续声明上游假定的 S01
    const result = plan([file("海贼王 第1050集.mp4")], [3]);
    expect(result.kind).toBe("deterministic");
    if (result.kind !== "deterministic") return;
    expect(result.moves[0]!.seasonNumber).toBe(3);
    expect(result.moves[0]!.episodeCode).toBe("S03E1050");
  });

  it("文件名明确命名季时，集码原样保留（那是文件名的事实）", () => {
    const result = plan([file("Show S02E07.mkv")], [2]);
    if (result.kind !== "deterministic") throw new Error("unexpected");
    expect(result.moves[0]!.episodeCode).toBe("S02E07");
  });

  it("文件命名的季不在 targetSeasons 里 ⇒ ambiguous_season（不猜邻居季）", () => {
    const result = plan([file("Show S05E01.mkv")], [1, 2]);
    expect(result.kind).toBe("manual_review");
    if (result.kind !== "manual_review") return;
    expect(result.unresolved[0]!.reason).toBe("ambiguous_season");
    expect(result.unresolved[0]!.suggestedSeasonNumber).toBe(5);
  });

  it("两个文件争同一集 ⇒ duplicate_episode_code，后一个进人工", () => {
    const result = plan([file("Show S01E01.mkv", "a"), file("Show.S01E01.mkv", "b")]);
    expect(result.kind).toBe("manual_review");
    if (result.kind !== "manual_review") return;
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.reason).toBe("duplicate_episode_code");
    expect(result.unresolved[0]!.fileId).toBe("b");
    // 先出现的胜出，且仍然只放进 moves 不执行
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.fileId).toBe("a");
  });

  it("**没有任何路径会静默放错**：unresolved 非空时 kind 必为 manual_review", () => {
    // 四种毛病各一：无集码 / 命名了不写的季 / 未命名季而候选不唯一 / 争同一集
    const messy = [
      file("a.mkv"),
      file("Show S09E01.mkv"),
      file("第3集.mp4"),
      file("Show S01E01.mkv", "x"),
      file("Show.S01E01.mkv", "y"),
    ];
    const result = plan(messy, [1, 2]);
    expect(result.kind).toBe("manual_review");
    if (result.kind !== "manual_review") return;
    expect(result.unresolved.map((u) => u.reason).sort()).toEqual([
      "ambiguous_season",
      "ambiguous_season",
      "duplicate_episode_code",
      "no_episode_code",
    ]);
    // 能放的那一个仍然只进 moves，不被执行
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]!.fileId).toBe("x");
  });
});

describe("comparePlannedVsActual — ③ planned 与 actual 不符即停", () => {
  const planned = planOrganizeMoves({
    files: [file("Show S01E01.mkv", "f1"), file("Show S01E02.mkv", "f2")],
    targetSeasons: [1],
    resolveTargetDirectory: () => "dir_season_01",
  });
  if (planned.kind !== "deterministic") throw new Error("fixture");
  const moves = planned.moves;

  it("完全一致 ⇒ match", () => {
    expect(
      comparePlannedVsActual(moves, [
        { fileId: "f1", directoryId: "dir_season_01" },
        { fileId: "f2", directoryId: "dir_season_01" },
      ]),
    ).toEqual({ kind: "match" });
  });

  it("少搬了一个 ⇒ missing（带上是哪一条）", () => {
    const drift = comparePlannedVsActual(moves, [{ fileId: "f1", directoryId: "dir_season_01" }]);
    expect(drift.kind).toBe("missing");
    if (drift.kind !== "missing") return;
    expect(drift.moves.map((m) => m.fileId)).toEqual(["f2"]);
  });

  it("搬错目录 ⇒ wrong_target", () => {
    const drift = comparePlannedVsActual(moves, [
      { fileId: "f1", directoryId: "dir_season_02" },
      { fileId: "f2", directoryId: "dir_season_01" },
    ]);
    expect(drift.kind).toBe("wrong_target");
    if (drift.kind !== "wrong_target") return;
    expect(drift.moves).toHaveLength(1);
    expect(drift.moves[0]!.actualDirectoryId).toBe("dir_season_02");
  });

  it("多搬了计划外的文件 ⇒ unexpected", () => {
    const drift = comparePlannedVsActual(moves, [
      { fileId: "f1", directoryId: "dir_season_01" },
      { fileId: "f2", directoryId: "dir_season_01" },
      { fileId: "f3", directoryId: "dir_season_01" },
    ]);
    expect(drift.kind).toBe("unexpected");
    if (drift.kind !== "unexpected") return;
    expect(drift.fileIds).toEqual(["f3"]);
  });

  it("一条都没搬 ⇒ missing 报全部（不是空 match）", () => {
    const drift = comparePlannedVsActual(moves, []);
    expect(drift.kind).toBe("missing");
    if (drift.kind !== "missing") return;
    expect(drift.moves).toHaveLength(2);
  });

  it("**missing 优先于 wrong_target**：文件不在位比放错位置更根本", () => {
    const drift = comparePlannedVsActual(moves, [
      { fileId: "f1", directoryId: "wrong" },
      // f2 完全没搬
    ]);
    expect(drift.kind).toBe("missing");
  });
});
