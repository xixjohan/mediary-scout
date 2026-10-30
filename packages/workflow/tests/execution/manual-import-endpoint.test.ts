import { describe, expect, it } from "vitest";
import type { ResourceCandidate, ResourceSnapshot } from "../../src/domain.js";
import { MANUAL_IMPORT_TTL_MS, decideManualImport, manualImportRejectionCopy } from "../../src/execution/manual-import-endpoint.js";

/**
 * 批次 3 第一项的端点决策核心。
 *
 * 它是有意的纯函数：不碰 HTTP/DB/时钟，所以整个决策可测；「快照从哪来」这个持久化
 * 问题因此与「什么可以入库」解耦——后者才是 plan 验收钉的那两条。
 */

const CREATED_AT = "2024-05-01T10:00:00Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

function candidate(id: string, snapshotId = "snap-1"): ResourceCandidate {
  return {
    id,
    snapshotId,
    index: 0,
    title: "孤独摇滚 S01E01",
    type: "115",
    source: "pansou-115",
    providerPayload: { url: "https://115.com/s/swxy8ab", password: "a1b2" },
  };
}

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    id: "snap-1",
    provider: "pansou",
    keyword: "孤独摇滚",
    createdAt: CREATED_AT,
    candidates: [candidate("c1"), candidate("c2")],
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof decideManualImport>[0]> = {}) {
  return {
    snapshot: snapshot(),
    candidateId: "c1",
    tmdbId: 283428,
    mediaType: "tv" as const,
    title: "孤独摇滚",
    accountId: "acct_default",
    connectedStorageId: "drive_1",
    now: CREATED_AT_MS + 5 * 60 * 1000,
    ...overrides,
  };
}

describe("decideManualImport — 放行", () => {
  it("合法候选 ⇒ enqueue，payload 带上原始 payload 与 drive scope", () => {
    const decision = decideManualImport(request());
    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.payload.candidateId).toBe("c1");
    expect(decision.payload.snapshotId).toBe("snap-1");
    expect(decision.payload.tmdbId).toBe(283428);
    expect(decision.payload.mediaType).toBe("tv");
    expect(decision.payload.accountId).toBe("acct_default");
    expect(decision.payload.connectedStorageId).toBe("drive_1");
    // payload 是服务端持有的原始分享信息
    expect(decision.payload.providerPayload).toEqual({ url: "https://115.com/s/swxy8ab", password: "a1b2" });
  });

  it("connectedStorageId 省略 ⇒ null（单盘/遗留）", () => {
    // request() 的默认值带 drive_1，所以「省略」必须真的把键删掉——
    // 传 { connectedStorageId: undefined } 在 exactOptionalPropertyTypes 下过不了类型关，
    // 而只写 request() 又会退化成正戴着 drive_1（那样这条用例就是假的省略）。
    const withoutDrive = request();
    delete (withoutDrive as { connectedStorageId?: string }).connectedStorageId;
    const decision = decideManualImport(withoutDrive);
    if (decision.kind !== "enqueue") throw new Error("unexpected");
    expect(decision.payload.connectedStorageId).toBeNull();
  });

  it("payload 熬过 JSON 往返才放行（进队列再出来仍合法）", () => {
    const decision = decideManualImport(request());
    if (decision.kind !== "enqueue") throw new Error("unexpected");
    // 端点内部已 round-trip；这里从外部再确认一次它确实是可序列化的形状
    expect(JSON.parse(JSON.stringify(decision.payload))).toEqual(decision.payload);
  });
});

describe("decideManualImport — 拒绝（plan 批次 3 验收前两条）", () => {
  it("candidateId 不属于该 snapshot ⇒ not_found", () => {
    const decision = decideManualImport(request({ candidateId: "nope" }));
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    expect(decision.reason).toBe("not_found");
  });

  it("candidateId 属于**别的** snapshot ⇒ not_found", () => {
    const snap = snapshot({ candidates: [candidate("c1", "snap-OTHER")] });
    expect(decideManualImport(request({ snapshot: snap })).kind).toBe("reject");
  });

  it("超过 30 分钟 ⇒ expired", () => {
    const decision = decideManualImport(request({ now: CREATED_AT_MS + MANUAL_IMPORT_TTL_MS + 1 }));
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    expect(decision.reason).toBe("expired");
  });

  it("快照损坏 ⇒ invalid_snapshot，且不归咎于用户", () => {
    const decision = decideManualImport(request({ snapshot: snapshot({ createdAt: "not-a-date" }) }));
    if (decision.kind !== "reject") throw new Error("unexpected");
    expect(decision.reason).toBe("invalid_snapshot");
    expect(decision.detail).toBeTruthy();
    // 文案不能是「你操作错了」
    expect(manualImportRejectionCopy(decision.reason)).not.toMatch(/你/);
  });
});

describe("manualImportRejectionCopy — 每种拒绝都有可行动的说明", () => {
  it("not_found / expired 指向「重新查询」", () => {
    expect(manualImportRejectionCopy("not_found")).toContain("重新查询");
    expect(manualImportRejectionCopy("expired")).toContain("重新查询");
  });

  it("四种原因都有非空文案", () => {
    for (const reason of ["not_found", "expired", "invalid_snapshot", "payload_invalid"] as const) {
      expect(manualImportRejectionCopy(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("decideManualImport — 畸形 providerPayload（往返校验的真实用途）", () => {
  // 这一条是变异测试逼出来的：跳过 roundTrip 校验时原有测试全绿。原因不是那条校验
  // 是死代码，而是夹具永远给合法的 providerPayload 对象——而它真正防的是 provider
  // （或遗留数据）给出 null / 字符串的情况。没有它，worker 会拿着畸形 payload 崩，
  // 或者更糟：用一个没有可转存内容的 payload 去建任务。
  it("providerPayload 不是对象 ⇒ payload_invalid，不入队", () => {
    for (const bad of [null, "url", 42]) {
      const snap = snapshot({ candidates: [candidate("c1")] });
      snap.candidates[0]!.providerPayload = bad as never;
      const decision = decideManualImport(request({ snapshot: snap }));
      expect(decision.kind).toBe("reject");
      if (decision.kind !== "reject") continue;
      expect(decision.reason).toBe("payload_invalid");
      expect(decision.detail).toBeTruthy();
    }
  });

  it("providerPayload 是数组 ⇒ payload_invalid", () => {
    const snap = snapshot({ candidates: [candidate("c1")] });
    snap.candidates[0]!.providerPayload = [] as never;
    const decision = decideManualImport(request({ snapshot: snap }));
    if (decision.kind !== "reject") throw new Error("unexpected");
    expect(decision.reason).toBe("payload_invalid");
  });
});

describe("decideManualImport — 边界", () => {
  it("恰好 30 分钟仍放行", () => {
    expect(decideManualImport(request({ now: CREATED_AT_MS + MANUAL_IMPORT_TTL_MS })).kind).toBe("enqueue");
  });

  it("ttlMs 可覆盖", () => {
    expect(decideManualImport(request({ now: CREATED_AT_MS + 1001, ttlMs: 1000 })).kind).toBe("reject");
  });
});
