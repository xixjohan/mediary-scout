import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  getTrackedSeasonStatusView,
  InMemoryWorkflowRepository,
  type AirStatus,
  type EpisodeState,
  type MediaTitle,
  type MetadataStatus,
  type TrackedSeason,
} from "@media-track/workflow";
import { missingAiredEpisodeCodes } from "./subscription-missing";

/** 本文件在 apps/web/lib/ 下，而消费方路径（app/api/...、lib/...）相对 apps/web/。 */
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * 「还缺哪些集」的**单一事实来源**门禁。
 *
 * 背景：这个数字原先有两套互不一致的算法——
 *   - `GET /api/agent/library` 逐集过滤 `airStatus === "aired" && !obtained`
 *   - `getLibraryWall` 用 `Math.min(latestAiredEpisode, totalEpisodes)` 减已获取数
 * 两者在 `latestAiredEpisode` 与集表不同步（provider_ahead、manual 补集、
 * storage_only）时会给出不同答案。订阅页待办区要展示这个数字，就必须与
 * agent 看到的是同一个，否则用户会问「为什么 API 说缺 3 集、页面说缺 2 集」。
 *
 * 所以计算收进一个函数，两侧共用；本文件同时用 AST 钉住「两侧都不许自己
 * 再写一遍过滤」。
 */

function ep(code: string, airStatus: AirStatus, obtained: boolean): EpisodeState {
  return {
    trackedSeasonId: "season-1",
    episodeCode: code,
    airDate: null,
    title: code,
    airStatus,
    obtained,
    metadataStatus: "confirmed" as MetadataStatus,
    verifiedFileIds: [],
  };
}

describe("missingAiredEpisodeCodes", () => {
  it("只取「已播出且未获取」的集码", () => {
    const episodes = [
      ep("E01", "aired", true), // 已获取
      ep("E02", "aired", false), // ← 缺
      ep("E03", "unaired", false), // 未播出，不算缺
      ep("E04", "unknown", false), // 未知，不算缺
      ep("E05", "aired", true),
    ];
    expect(missingAiredEpisodeCodes(episodes)).toEqual(["E02"]);
  });

  it("全获取时返回空数组", () => {
    expect(missingAiredEpisodeCodes([ep("E01", "aired", true), ep("E02", "aired", true)])).toEqual([]);
  });

  it("provider_ahead 的集虽在表里也不算缺（未播出）", () => {
    // provider_ahead 的 airStatus 是 unknown，不能算成「缺」——那是尚未播出的集。
    const episodes = [ep("E01", "aired", true), ep("E02", "unknown", false)];
    expect(missingAiredEpisodeCodes(episodes)).toEqual([]);
  });

  it("保留集表顺序，不打乱", () => {
    const episodes = [ep("E10", "aired", false), ep("E02", "aired", false), ep("E01", "aired", true)];
    expect(missingAiredEpisodeCodes(episodes)).toEqual(["E10", "E02"]);
  });
});

/**
 * 结构性门禁：两个消费方都必须走共享函数，不许各自再写一遍过滤。
 *
 * 只靠行为测试不够——行为测试只证明「共享函数是对的」，证明不了「没人偷偷
 * 用另一套算法」。所以再用 AST 检查 import 关系与内联过滤。
 */
describe("单一算法门禁 — 两个消费方都走共享函数", () => {
  const CONSUMERS = [
    "app/api/agent/library/route.ts",
    "lib/title-hub.ts",
  ];

  /** 模块说明符归一化：`../../../../lib/subscription-missing` 与 `./subscription-missing`
   *  都应识别为指向同一个模块（消费方分布在 apps/web 不同深度）。 */
  function specifierTargets(specifier: string, moduleBasename: string): boolean {
    return specifier.replace(/\.js$/, "").split("/").pop() === moduleBasename;
  }

  function imports(rel: string, moduleBasename: string, name: string): boolean {
    const source = readFileSync(`${WEB_ROOT}/${rel}`, "utf8");
    const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (specifierTargets(node.moduleSpecifier.text, moduleBasename)) {
          const clause = node.importClause;
          if (!clause) return;
          if (clause.name?.text === name) found = true;
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if ((el.propertyName?.text ?? el.name.text) === name) found = true;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  }

  for (const rel of CONSUMERS) {
    it(`${rel} 引入 subscription-missing 的 missingAiredEpisodeCodes`, () => {
      expect(imports(rel, "subscription-missing", "missingAiredEpisodeCodes")).toBe(true);
    });

    it(`${rel} 不再内联 airStatus === "aired" 过滤`, () => {
      const source = readFileSync(`${WEB_ROOT}/${rel}`, "utf8");
      expect(source, `${rel} 又自己写了一套缺失判定`).not.toContain('airStatus === "aired"');
    });
  }
});

/**
 * 与 workflow 包**规范分类**的等价性门禁。
 *
 * 光有「两个 web 消费方走同一函数」不够：那只证明它们彼此一致，证明不了与
 * 详情页季行用的是同一个口径。详情页季行的 missingAiredCount 来自
 * `getTrackedSeasonStatusView`（packages/workflow/src/queries.ts），其判据是
 * `displayState === "missing_aired"`——一个独立的实现。
 *
 * 两者一旦分叉，用户会看到「待办区说缺 3 集、详情页说缺 2 集」。所以这里
 * 直接拿规范实现做对照：同一份 episode 状态，两条路必须给出同一集合。
 *
 * 已知的等价依据（读码得出，测试负责盯住它别被改坏）：
 *   displayState === "missing_aired"  ⟺  !obtained ∧ airStatus === "aired"
 * 其中 `obtained ∧ provider_ahead` 归为 provider_ahead 而非 obtained，两侧
 * 都正确地不把它算成缺失。
 */
describe("与 getTrackedSeasonStatusView 的等价性", () => {
  it("同一份 episode 状态，两条路给出同一缺失集合", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = {
      id: "title_show",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 3,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
    const episodes: EpisodeState[] = [
      ...createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }).map((episode) =>
        episode.episodeCode === "S01E01"
          ? { ...episode, obtained: true, verifiedFileIds: ["file_1"] }
          : episode,
      ),
      // provider_ahead：已获取但 provider 提前给出。不算缺失。
      {
        trackedSeasonId: season.id,
        episodeCode: "S01E04",
        airDate: null,
        title: "S01E04",
        airStatus: "unknown",
        obtained: true,
        metadataStatus: "provider_ahead",
        verifiedFileIds: ["file_4"],
      },
    ];
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "run_1",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-06-11T00:00:00.000Z",
        finishedAt: "2026-06-11T00:01:00.000Z",
        auditEvents: [],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const view = await getTrackedSeasonStatusView({ repository, trackedSeasonId: season.id });

    expect(view).not.toBeNull();
    // 规范实现自己也要给出预期，否则两边同时错也会「等价」。
    expect(view?.missingAiredEpisodes).toEqual(["S01E02"]);
    expect(view?.providerAheadEpisodes).toEqual(["S01E04"]);
    // 共享函数（保持集表顺序）与规范实现（按集号排序）比对集合。
    expect([...missingAiredEpisodeCodes(episodes)].sort()).toEqual([...(view?.missingAiredEpisodes ?? [])].sort());
  });
});
