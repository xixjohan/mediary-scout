import { describe, expect, it } from "vitest";
import type { ResourceCandidate } from "../src/domain.js";
import { toCandidateView, toCandidateViews } from "../src/resource-candidate-view.js";

/**
 * 「payload 绝不下前端」的守卫。
 *
 * 最强的测试不是逐字段断言，而是**敌意 payload**：把 URL 形态的字符串塞进一大堆
 * 键名下，再对序列化后的视图做 URL 形态深扫。这样即使将来有人往 payload 里加一个
 * 新键，只要视图不小心散播了它，测试就会红——而不是等它上线才变成凭证转储。
 */

function candidate(payload: Record<string, unknown>): ResourceCandidate {
  return {
    id: "cand-1",
    snapshotId: "snap-1",
    index: 0,
    title: "复仇者联盟4：终局之战",
    type: "share",
    source: "pansou-115",
    providerPayload: payload,
  };
}

/** 序列化后不允许出现任何 URL 形态。 */
const URL_SHAPE = /(?:https?|ftp|magnet):\/\/|magnet:\?|ed2k:\/\//i;

describe("toCandidateView — 用户要的三个事实", () => {
  it("PanSou：标题/类型/来源/发布时间，且不带 url 与 password", () => {
    const view = toCandidateView(
      candidate({ url: "https://115.com/s/swxy8ab", password: "a1b2", datetime: "2024-05-01T10:00:00Z", rawType: "分享" }),
    );
    expect(view).toEqual({
      candidateId: "cand-1",
      title: "复仇者联盟4：终局之战",
      type: "share",
      source: "pansou-115",
      publishedAt: "2024-05-01T10:00:00Z",
    });
    // 键集合是封闭的：url/password/rawType 一个都没进来
    expect(Object.keys(view).sort()).toEqual(["candidateId", "publishedAt", "source", "title", "type"]);
  });

  it("Prowlarr：体积与做种数，且不带 magnet/downloadUrl/infoHash", () => {
    const view = toCandidateView(
      candidate({
        url: "magnet:?xt=urn:btih:abcdef0123456789",
        infoHash: "abcdef0123456789",
        seeders: 42,
        sizeBytes: 18_446_744_073_709_551_615,
        indexer: "some-indexer",
        downloadUrl: "https://indexer.example/dl?token=secret",
      }),
    );
    expect(view.sizeBytes).toBe(18_446_744_073_709_551_615);
    expect(view.seeders).toBe(42);
    expect(view).not.toHaveProperty("url");
    expect(view).not.toHaveProperty("infoHash");
    expect(view).not.toHaveProperty("downloadUrl");
  });
});

describe("toCandidateView — 敌意 payload 深扫", () => {
  it("URL 形态的字符串塞进任何键名都不出现在序列化结果里", () => {
    const hostile = candidate({
      url: "https://115.com/s/abc",
      password: "a1b2",
      magnet: "magnet:?xt=urn:btih:deadbeef",
      downloadUrl: "https://x.example/dl?token=t",
      link: "https://y.example/s",
      share: "ed2k://|file|thing.avi|123|HASH|/",
      nested: { deep: { url: "https://z.example/s", token: "leak" } },
      list: ["https://w.example/s", "magnet:?xt=urn:btih:cafe"],
      note: "https://plain.example/but-not-a-known-key",
    });
    const serialized = JSON.stringify(toCandidateView(hostile));
    expect(serialized).not.toMatch(URL_SHAPE);
    // 提取码本身也不该出现
    expect(serialized).not.toContain("a1b2");
    expect(serialized).not.toContain("deadbeef");
  });

  it("键名大小写/驼峰变体也拦不住（视图只认白名单字段）", () => {
    const view = toCandidateView(candidate({ URL: "https://a.example", ShareUrl: "https://b.example" }));
    expect(JSON.stringify(view)).not.toMatch(URL_SHAPE);
  });
});

describe("toCandidateView — 畸形与缺失", () => {
  it("payload 缺字段时视图不带该键（不塞 undefined 也不塞 null）", () => {
    const view = toCandidateView(candidate({}));
    expect(Object.keys(view).sort()).toEqual(["candidateId", "source", "title", "type"]);
    expect(view.sizeBytes).toBeUndefined();
    expect(view.publishedAt).toBeUndefined();
  });

  it("非数字体积不当成数字（字符串 '123' 不转）", () => {
    const view = toCandidateView(candidate({ sizeBytes: "123", seeders: null, datetime: "" }));
    expect(view.sizeBytes).toBeUndefined();
    expect(view.seeders).toBeUndefined();
    expect(view.publishedAt).toBeUndefined();
  });

  it("批量投影保持顺序与条数", () => {
    const views = toCandidateViews([
      { ...candidate({ datetime: "t1" }), id: "c1" },
      { ...candidate({ datetime: "t2" }), id: "c2" },
    ]);
    expect(views.map((v) => v.candidateId)).toEqual(["c1", "c2"]);
    expect(views[0]!.publishedAt).toBe("t1");
  });
});
