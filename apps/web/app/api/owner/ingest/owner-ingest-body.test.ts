import { describe, expect, it } from "vitest";
import { parseOwnerIngestSearchBody } from "./search/route";
import { parseOwnerIngestSubmitBody } from "./submit/route";
import { parseOwnerIngestInspectBody } from "./inspect/route";

/**
 * 三个端点的请求体解析（纯函数，不需要 HTTP）：
 *  - 搜索：只接受关键字 + 网盘，长度上限与 UI 的 maxLength=64 一致；可选 backends
 *    必须是已知后端，未知值丢弃（不得静默当成「全用」）；
 *  - 提交：candidateIds 必须非空，tmdbId/seasonNumber 只接受正整数
 *    （0 与负数会被静默丢弃——它们不是合法作品，也不该被当成合成标题的哨兵混进来）；
 *  - 校验：候选列表非空且有上限（防止一次请求把网盘打成风控对象）。
 */
describe("parseOwnerIngestSearchBody", () => {
  it("接受合法关键字与网盘", () => {
    expect(parseOwnerIngestSearchBody({ keyword: "  Frieren 4K ", storageId: "d1" })).toEqual({
      ok: true,
      body: { keyword: "Frieren 4K", storageId: "d1", backends: [], unknownBackends: [] },
    });
  });

  it("可选 backends 去重并按固定顺序规范化；未知后端单独上报（端点回 400，不静默当成全用）", () => {
    const result = parseOwnerIngestSearchBody({
      keyword: "kw",
      storageId: "d1",
      backends: ["prowlarr", "nope", "pansou", "prowlarr"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.backends).toEqual(["pansou", "prowlarr"]);
    expect(result.body.unknownBackends).toEqual(["nope"]);
  });

  it("backends 不是数组 → 视为未选择（全部已配置后端）", () => {
    const result = parseOwnerIngestSearchBody({ keyword: "kw", storageId: "d1", backends: "pansou" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.backends).toEqual([]);
    expect(result.body.unknownBackends).toEqual([]);
  });

  it("空关键字 / 超长关键字 / 缺网盘 → 拒绝", () => {
    expect(parseOwnerIngestSearchBody({ keyword: "   ", storageId: "d" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestSearchBody({ keyword: "x".repeat(65), storageId: "d" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestSearchBody({ keyword: "x" })).toMatchObject({ ok: false });
  });

  it("非对象请求体 → 拒绝", () => {
    expect(parseOwnerIngestSearchBody(null)).toMatchObject({ ok: false });
    expect(parseOwnerIngestSearchBody("str")).toMatchObject({ ok: false });
  });
});

describe("parseOwnerIngestSubmitBody", () => {
  const base = {
    storageId: "d1",
    searchRunId: "run_1",
    directoryId: "dir_1",
    candidateIds: ["c1", "c2"],
  };

  it("接受最小合法请求（不绑定作品）", () => {
    const result = parseOwnerIngestSubmitBody(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.candidates).toEqual(["c1", "c2"]);
    expect(result.body.tmdbId).toBeUndefined();
    expect(result.body.mediaType).toBeUndefined();
  });

  it("接受绑定作品（正 tmdbId + mediaType + season）", () => {
    const result = parseOwnerIngestSubmitBody({
      ...base,
      tmdbId: 1396,
      mediaType: "tv",
      seasonNumber: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.tmdbId).toBe(1396);
    expect(result.body.mediaType).toBe("tv");
    expect(result.body.seasonNumber).toBe(2);
  });

  it("tmdbId=0 / 负数 / 非法 mediaType 被丢弃（不得当成哨兵身份混入）", () => {
    const result = parseOwnerIngestSubmitBody({
      ...base,
      tmdbId: 0,
      mediaType: "anime2",
      seasonNumber: -1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.tmdbId).toBeUndefined();
    expect(result.body.mediaType).toBeUndefined();
    expect(result.body.seasonNumber).toBeUndefined();
  });

  it("缺 storageId / searchRunId / directoryId / candidates → 各自拒绝", () => {
    expect(parseOwnerIngestSubmitBody({ ...base, storageId: "" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestSubmitBody({ ...base, searchRunId: "" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestSubmitBody({ ...base, directoryId: "" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestSubmitBody({ ...base, candidateIds: [] })).toMatchObject({ ok: false });
    expect(parseOwnerIngestSubmitBody({ ...base, candidateIds: ["", "  "] })).toMatchObject({ ok: false });
  });
});

describe("parseOwnerIngestInspectBody", () => {
  const base = { storageId: "d1", searchRunId: "run_1", candidateIds: ["c1", "c2"] };

  it("接受合法请求", () => {
    expect(parseOwnerIngestInspectBody(base)).toEqual({
      ok: true,
      body: { storageId: "d1", searchRunId: "run_1", candidateIds: ["c1", "c2"] },
    });
  });

  it("缺任一必填 → 拒绝", () => {
    expect(parseOwnerIngestInspectBody({ ...base, storageId: "" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestInspectBody({ ...base, searchRunId: "" })).toMatchObject({ ok: false });
    expect(parseOwnerIngestInspectBody({ ...base, candidateIds: [] })).toMatchObject({ ok: false });
    expect(parseOwnerIngestInspectBody({ ...base, candidateIds: ["  "] })).toMatchObject({ ok: false });
  });

  it("候选数量有上限：一次请求不得无限探测", () => {
    const result = parseOwnerIngestInspectBody({ ...base, candidateIds: Array.from({ length: 30 }, (_, i) => `c${i}`) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.candidateIds).toHaveLength(12);
  });
});
