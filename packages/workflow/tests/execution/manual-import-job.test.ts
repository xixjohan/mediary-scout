import { describe, expect, it } from "vitest";
import type { ResourceCandidate } from "../../src/domain.js";
import {
  buildManualImportJobPayload,
  candidateBelongsToSnapshot,
  parseManualImportJobPayload,
  roundTripManualImportJob,
  type ManualImportJobPayload,
} from "../../src/manual-import-job.js";

/**
 * 批次 3 第三项：手动入库任务载体。
 *
 * 重点是**读回校验**那一半。payload 要进 sys_queue_jobs.payload_json，由 worker 事后
 * 取出——没有校验，坏 payload 到 worker 手里就是 any：要么把它搞崩（死信里带着读不懂
 * 的原因），要么更糟——用一个缺了 drive scope 字段的 payload 去转存，传到别的盘上。
 */

function candidate(overrides: Partial<ResourceCandidate> = {}): ResourceCandidate {
  return {
    id: "c1",
    snapshotId: "snap-1",
    index: 0,
    title: "孤独摇滚 S01E01",
    type: "115",
    source: "pansou-115",
    providerPayload: { url: "https://115.com/s/swxy8ab", password: "a1b2" },
    ...overrides,
  };
}

function payload(overrides: Partial<ManualImportJobPayload> = {}): ManualImportJobPayload {
  return {
    kind: "manual_import",
    candidateId: "c1",
    snapshotId: "snap-1",
    tmdbId: 283428,
    mediaType: "tv",
    title: "孤独摇滚",
    providerPayload: { url: "https://115.com/s/swxy8ab", password: "a1b2" },
    accountId: "acct_default",
    connectedStorageId: null,
    ...overrides,
  };
}

describe("buildManualImportJobPayload", () => {
  it("带上原始 payload（服务端持有，不下前端）与 drive scope", () => {
    const built = buildManualImportJobPayload({
      candidate: candidate(),
      snapshotId: "snap-1",
      tmdbId: 283428,
      mediaType: "tv",
      title: "孤独摇滚",
      accountId: "acct_default",
      connectedStorageId: "drive_1",
    });
    expect(built).toEqual(payload({ connectedStorageId: "drive_1" }));
    expect(built.providerPayload).toEqual({ url: "https://115.com/s/swxy8ab", password: "a1b2" });
  });

  it("connectedStorageId 省略时落成 null（单盘/遗留）", () => {
    const built = buildManualImportJobPayload({
      candidate: candidate(),
      snapshotId: "snap-1",
      tmdbId: 1,
      mediaType: "movie",
      title: "T",
      accountId: "a",
    });
    expect(built.connectedStorageId).toBeNull();
  });

  it("目标盘跟随 workspace，没有 drive 选择器字段", () => {
    // plan：「目标盘跟随当前 workspace scope，不做 drive 选择器」——载荷里不应有
    // 任何让调用方挑盘的字段。
    const built = buildManualImportJobPayload({
      candidate: candidate(),
      snapshotId: "snap-1",
      tmdbId: 1,
      mediaType: "movie",
      title: "T",
      accountId: "a",
      connectedStorageId: "drive_1",
    });
    expect(Object.keys(built).sort()).toEqual([
      "accountId",
      "candidateId",
      "connectedStorageId",
      "kind",
      "mediaType",
      "providerPayload",
      "snapshotId",
      "title",
      "tmdbId",
    ]);
  });
});

describe("candidateBelongsToSnapshot", () => {
  it("归属相符/不符", () => {
    expect(candidateBelongsToSnapshot(candidate(), "snap-1")).toBe(true);
    expect(candidateBelongsToSnapshot(candidate({ snapshotId: "snap-2" }), "snap-1")).toBe(false);
  });
});

describe("parseManualImportJobPayload — 读回校验", () => {
  it("合法 payload ⇒ ok", () => {
    const result = parseManualImportJobPayload(payload());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload).toEqual(payload());
  });

  it("null/数组/标量 ⇒ invalid", () => {
    expect(parseManualImportJobPayload(null).kind).toBe("invalid");
    expect(parseManualImportJobPayload([]).kind).toBe("invalid");
    expect(parseManualImportJobPayload("x").kind).toBe("invalid");
  });

  it("kind 不符 ⇒ invalid（不是给这个 worker 的活）", () => {
    expect(parseManualImportJobPayload(payload({ kind: "type2_init" as never })).kind).toBe("invalid");
  });

  it("必填字符串缺失/为空 ⇒ invalid", () => {
    for (const key of ["candidateId", "snapshotId", "title", "accountId"] as const) {
      const broken = payload({ [key]: "" } as Partial<ManualImportJobPayload>);
      expect(parseManualImportJobPayload(broken).kind).toBe("invalid");
      const missing = { ...payload() } as Record<string, unknown>;
      delete missing[key];
      expect(parseManualImportJobPayload(missing).kind).toBe("invalid");
    }
  });

  it("tmdbId 非正整数 ⇒ invalid", () => {
    for (const bad of [0, -1, 1.5, "1", null]) {
      expect(parseManualImportJobPayload(payload({ tmdbId: bad as never })).kind).toBe("invalid");
    }
  });

  it("mediaType 不是 tv/movie ⇒ invalid", () => {
    expect(parseManualImportJobPayload(payload({ mediaType: "anime" as never })).kind).toBe("invalid");
  });

  it("providerPayload 不是对象 ⇒ invalid（没有它就没有可转存的东西）", () => {
    for (const bad of [null, "url", [], 42]) {
      expect(parseManualImportJobPayload(payload({ providerPayload: bad as never })).kind).toBe("invalid");
    }
  });

  it("connectedStorageId 必须是 string 或 null", () => {
    expect(parseManualImportJobPayload(payload({ connectedStorageId: 42 as never })).kind).toBe("invalid");
    expect(parseManualImportJobPayload(payload({ connectedStorageId: "d" })).kind).toBe("ok");
    expect(parseManualImportJobPayload(payload({ connectedStorageId: null })).kind).toBe("ok");
  });
});

describe("roundTripManualImportJob", () => {
  it("payload 熬过自己的 JSON 往返（进队列再出来仍合法）", () => {
    const result = roundTripManualImportJob(payload({ connectedStorageId: "drive_1" }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.payload).toEqual(payload({ connectedStorageId: "drive_1" }));
  });

  it("含 undefined 的字段在往返后不会被误判为合法", () => {
    const withHole = { ...payload(), title: undefined } as unknown as ManualImportJobPayload;
    expect(roundTripManualImportJob(withHole).kind).toBe("invalid");
  });
});
