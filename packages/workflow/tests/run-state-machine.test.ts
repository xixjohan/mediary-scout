import { describe, expect, it } from "vitest";
import {
  RunStateMachine,
  type PersistedRunState,
  type RunEvent,
} from "../src/acquisition-v2/run-state-machine.js";

/**
 * 任务单 S3.2（P7/P9）：XState 状态机取代散落的状态标记；Saga 补偿显式化。
 * 契约（对齐治理文档 §5.4 状态图）：
 *   - happy path 全状态逐跳；
 *   - 任一非终态 FAIL → sagaCompensating（带累积补偿清单）→ COMPENSATED → failed；
 *   - 无源（NO_COVERAGE）是独立终态，不进补偿；
 *   - 终态后再发事件被忽略（幂等）；
 *   - 快照可序列化/恢复（崩溃续跑的前提）。
 */
const CLAIM = { type: "CLAIM" } as const;

function machine(): RunStateMachine {
  return RunStateMachine.create();
}

describe("RunStateMachine", () => {
  it("初始为 scheduled；CLAIM 后进入 directoryProvisioning", () => {
    const m = machine();
    expect(m.state).toBe("scheduled");
    m.send(CLAIM);
    expect(m.state).toBe("directoryProvisioning");
  });

  it("happy path：逐跳走完到 completed", () => {
    const m = machine();
    const path = [
      "directoryProvisioning",
      "resourceSearching",
      "candidatesEvaluating",
      "transferring",
      "pollingLanding",
      "inspecting",
      "organizing",
      "deduplicating",
      "stagingPurging",
      "completed",
    ] as const;
    const events: RunEvent[] = [
      CLAIM,
      { type: "DIRS_READY" },
      { type: "SEARCHED" },
      { type: "CANDIDATES_READY" },
      { type: "TRANSFER_STARTED" },
      { type: "LANDED" },
      { type: "INSPECTED" },
      { type: "ORGANIZED" },
      { type: "DEDUPED" },
      { type: "PURGED" },
    ];
    events.forEach((event, i) => {
      m.send(event);
      expect(m.state).toBe(path[i]);
    });
  });

  it("transferring 中 FAIL → sagaCompensating，补偿清单含 staging_cleanup", () => {
    const m = machine();
    m.send(CLAIM); // directoryProvisioning：staging 目录已建 → 登记补偿
    m.send({ type: "DIRS_READY" });
    m.send({ type: "SEARCHED" });
    m.send({ type: "CANDIDATES_READY" });
    m.send({ type: "TRANSFER_STARTED" });
    m.send({ type: "FAIL", reason: "115 分享已取消" });
    expect(m.state).toBe("sagaCompensating");
    expect(m.failedReason).toBe("115 分享已取消");
    expect(m.pendingCompensations.map((c) => c.kind)).toContain("staging_cleanup");
    m.send({ type: "COMPENSATED" });
    expect(m.state).toBe("failed");
  });

  it("补偿按创建的逆序累计（后进先出）", () => {
    const m = machine();
    m.send(CLAIM); // → staging_cleanup 登记
    m.send({ type: "DIRS_READY" });
    m.send({ type: "SEARCHED" });
    m.send({ type: "CANDIDATES_READY" });
    m.send({ type: "TRANSFER_STARTED" }); // → 又一个补偿（转存中的暂存文件）
    m.send({ type: "LANDED" });
    m.send({ type: "INSPECTED" });
    m.send({ type: "ORGANIZED" }); // → 搬运后的残留暂存
    m.send({ type: "FAIL", reason: "boom" });
    const kinds = m.pendingCompensations.map((c) => c.kind);
    // 逆序：最后登记的 organizing 残留最先补偿
    expect(kinds.at(-1)).toBe("staging_cleanup");
    expect(kinds.length).toBeGreaterThanOrEqual(2);
  });

  it("NO_COVERAGE 是独立终态；已建的暂存目录补偿仍在（调用方照清，不漏桶）", () => {
    const m = machine();
    m.send(CLAIM);
    m.send({ type: "DIRS_READY" });
    m.send({ type: "SEARCHED" });
    m.send({ type: "NO_COVERAGE" });
    expect(m.state).toBe("noCoverage");
    // 无源也要销毁暂存目录：补偿清单不为空，且不进 sagaCompensating。
    expect(m.pendingCompensations.map((c) => c.kind)).toEqual(["staging_cleanup"]);
  });

  it("终态（completed/failed/noCoverage）后的事件被忽略", () => {
    const done = machine();
    const walk: RunEvent[] = [
      CLAIM,
      { type: "DIRS_READY" },
      { type: "SEARCHED" },
      { type: "CANDIDATES_READY" },
      { type: "TRANSFER_STARTED" },
      { type: "LANDED" },
      { type: "INSPECTED" },
      { type: "ORGANIZED" },
      { type: "DEDUPED" },
      { type: "PURGED" },
    ];
    for (const e of walk) {
      done.send(e);
    }
    done.send({ type: "FAIL", reason: "too late" });
    expect(done.state).toBe("completed");
  });

  it("NOTHING_TO_DO：已是最新（≠无源）的独立终态", () => {
    const m = machine();
    m.send(CLAIM);
    m.send({ type: "DIRS_READY" });
    m.send({ type: "SEARCHED" });
    m.send({ type: "NOTHING_TO_DO" });
    expect(m.state).toBe("nothingToDo");
    expect(m.failedReason).toBeNull();
  });

  it("快照序列化 → 恢复后状态与补偿清单不丢", () => {
    const m = machine();
    m.send(CLAIM); // → directoryProvisioning
    m.send({ type: "DIRS_READY" }); // → resourceSearching
    m.send({ type: "SEARCHED" }); // → candidatesEvaluating
    const snapshot: PersistedRunState = m.toJSON();
    expect(JSON.parse(JSON.stringify(snapshot)).state).toBe("candidatesEvaluating");

    const restored = RunStateMachine.from(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.state).toBe("candidatesEvaluating");
    expect(restored.pendingCompensations).toEqual(m.pendingCompensations);
    // 恢复后能继续跑
    restored.send({ type: "CANDIDATES_READY" });
    expect(restored.state).toBe("transferring");
  });

  it("从快照恢复的失败路径同样进补偿", () => {
    const m = machine();
    m.send(CLAIM);
    const restored = RunStateMachine.from(JSON.parse(JSON.stringify(m.toJSON())));
    restored.send({ type: "FAIL", reason: "crash-resume" });
    expect(restored.state).toBe("sagaCompensating");
    expect(restored.pendingCompensations.map((c) => c.kind)).toContain("staging_cleanup");
  });

  it("can() 预告合法迁移；非法事件不动状态", () => {
    const m = machine();
    expect(m.can(CLAIM)).toBe(true);
    expect(m.can({ type: "PURGED" })).toBe(false);
    m.send({ type: "PURGED" } as never); // 非法
    expect(m.state).toBe("scheduled");
  });
});
