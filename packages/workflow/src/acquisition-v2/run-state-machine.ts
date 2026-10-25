/**
 * 获取流水线的显式状态机 + Saga 补偿（任务单 S3.2，P7/P9）。
 *
 * 取代散落各处的状态标记：运行的生命周期只有这一份权威定义（对齐治理文档
 * §5.4 状态图）。分工：
 *   - xstate 机器：只管**状态迁移**（哪些事件在哪些状态合法、去哪）；
 *   - 本 façade：管理**补偿清单与失败原因**（纯 TS，无框架泛型摩擦），
 *     并提供序列化（崩溃续跑的前提）。
 * 状态机不执行副作用——它回答"现在在哪、失败了要补偿什么"，调用方
 * （runner / directory-lifecycle）按 compensations 逆序执行补偿。
 *
 *   scheduled → directoryProvisioning → resourceSearching → candidatesEvaluating
 *     → transferring → pollingLanding → inspecting → organizing → deduplicating
 *     → stagingPurging → completed
 *   任一非终态 FAIL → sagaCompensating → (COMPENSATED) → failed
 *   resourceSearching / candidatesEvaluating NO_COVERAGE → noCoverage（独立终态）
 */
import { createActor, setup } from "xstate";

export type RunState =
  | "scheduled"
  | "directoryProvisioning"
  | "resourceSearching"
  | "candidatesEvaluating"
  | "transferring"
  | "pollingLanding"
  | "inspecting"
  | "organizing"
  | "deduplicating"
  | "stagingPurging"
  | "completed"
  | "sagaCompensating"
  | "failed"
  | "noCoverage"
  | "nothingToDo";

export type CompensationKind = "staging_cleanup" | "discard_staging_files";

export interface Compensation {
  kind: CompensationKind;
  /** 哪一阶段登记的（排障与审计用） */
  detail: string;
}

export type RunEvent =
  | { type: "CLAIM" }
  | { type: "DIRS_READY" }
  | { type: "SEARCHED" }
  | { type: "CANDIDATES_READY" }
  | { type: "TRANSFER_STARTED" }
  | { type: "LANDED" }
  | { type: "INSPECTED" }
  | { type: "ORGANIZED" }
  | { type: "DEDUPED" }
  | { type: "PURGED" }
  | { type: "NO_COVERAGE" }
  | { type: "NOTHING_TO_DO" }
  | { type: "FAIL"; reason: string }
  | { type: "COMPENSATED" };

export interface RunMachineContext {
  /** 已登记的补偿，按创建顺序（执行时逆序 = 后进先出） */
  compensations: Compensation[];
  failureReason: string | null;
}

export interface PersistedRunState {
  state: RunState;
  context: RunMachineContext;
}

/** 进入某状态即意味着产生了必须补偿的副作用。 */
const COMPENSATION_ON_ENTER: Partial<Record<RunState, Compensation>> = {
  directoryProvisioning: { kind: "staging_cleanup", detail: "provisioned-staging-dir" },
  transferring: { kind: "discard_staging_files", detail: "partial-transfer" },
  organizing: { kind: "staging_cleanup", detail: "post-move-residue" },
};

/** 每个状态接受的事件类型（can() 与测试用；与下方 machine 定义保持一致）。 */
const ALLOWED: Record<RunState, ReadonlySet<RunEvent["type"]>> = {
  scheduled: new Set(["CLAIM", "FAIL"]),
  directoryProvisioning: new Set(["DIRS_READY", "FAIL"]),
  resourceSearching: new Set(["SEARCHED", "NO_COVERAGE", "FAIL"]),
  candidatesEvaluating: new Set(["CANDIDATES_READY", "NO_COVERAGE", "NOTHING_TO_DO", "FAIL"]),
  transferring: new Set(["TRANSFER_STARTED", "FAIL"]),
  pollingLanding: new Set(["LANDED", "FAIL"]),
  inspecting: new Set(["INSPECTED", "FAIL"]),
  organizing: new Set(["ORGANIZED", "FAIL"]),
  deduplicating: new Set(["DEDUPED", "FAIL"]),
  stagingPurging: new Set(["PURGED", "FAIL"]),
  completed: new Set(),
  noCoverage: new Set(),
  nothingToDo: new Set(),
  sagaCompensating: new Set(["COMPENSATED"]),
  failed: new Set(),
};

const machine = setup({
  types: {} as { events: RunEvent },
}).createMachine({
  id: "run",
  initial: "scheduled",
  states: {
    scheduled: { on: { CLAIM: "directoryProvisioning", FAIL: "sagaCompensating" } },
    directoryProvisioning: { on: { DIRS_READY: "resourceSearching", FAIL: "sagaCompensating" } },
    resourceSearching: {
      on: { SEARCHED: "candidatesEvaluating", NO_COVERAGE: "noCoverage", FAIL: "sagaCompensating" },
    },
    candidatesEvaluating: {
      on: {
        CANDIDATES_READY: "transferring",
        NO_COVERAGE: "noCoverage",
        NOTHING_TO_DO: "nothingToDo",
        FAIL: "sagaCompensating",
      },
    },
    transferring: { on: { TRANSFER_STARTED: "pollingLanding", FAIL: "sagaCompensating" } },
    pollingLanding: { on: { LANDED: "inspecting", FAIL: "sagaCompensating" } },
    inspecting: { on: { INSPECTED: "organizing", FAIL: "sagaCompensating" } },
    organizing: { on: { ORGANIZED: "deduplicating", FAIL: "sagaCompensating" } },
    deduplicating: { on: { DEDUPED: "stagingPurging", FAIL: "sagaCompensating" } },
    stagingPurging: { on: { PURGED: "completed", FAIL: "sagaCompensating" } },
    completed: { type: "final" },
    noCoverage: { type: "final" },
    nothingToDo: { type: "final" },
    sagaCompensating: { on: { COMPENSATED: "failed" } },
    failed: { type: "final" },
  },
});

/** 包装 xstate actor 的小 façade：send / 查询 / 序列化 / 恢复。 */
export class RunStateMachine {
  private readonly actor: ReturnType<typeof createActor<typeof machine>>;
  private compensations: Compensation[];
  private failureReason: string | null;

  private constructor(
    actor: ReturnType<typeof createActor<typeof machine>>,
    context: RunMachineContext,
  ) {
    this.actor = actor;
    this.compensations = context.compensations;
    this.failureReason = context.failureReason;
  }

  static create(): RunStateMachine {
    const actor = createActor(machine);
    actor.start();
    return new RunStateMachine(actor, { compensations: [], failureReason: null });
  }

  static from(snapshot: PersistedRunState): RunStateMachine {
    const state = machine.resolveState({ value: snapshot.state, context: {} });
    const actor = createActor(machine, { snapshot: state });
    actor.start();
    return new RunStateMachine(actor, snapshot.context);
  }

  send(event: RunEvent): void {
    // 终态/非法事件直接吞掉（xstate 本身也是 no-op，但会打警告；守卫让日志干净，
    // 也保证补偿不会被重复登记）。
    if (!this.can(event)) {
      return;
    }
    const before = this.actor.getSnapshot().value as RunState;
    this.actor.send(event);
    const after = this.actor.getSnapshot().value as RunState;
    if (event.type === "FAIL") {
      this.failureReason = event.reason;
    }
    // 真正进入了新状态才登记补偿（自我迁移/非法事件不重复登记）。
    if (before !== after) {
      const registered = COMPENSATION_ON_ENTER[after];
      if (registered) {
        this.compensations.push(registered);
      }
    }
  }

  can(event: RunEvent): boolean {
    return ALLOWED[this.state].has(event.type);
  }

  get state(): RunState {
    return this.actor.getSnapshot().value as RunState;
  }

  /** 按创建顺序；调用方逆序执行（后进先出）。 */
  get pendingCompensations(): readonly Compensation[] {
    return this.compensations;
  }

  get failedReason(): string | null {
    return this.failureReason;
  }

  toJSON(): PersistedRunState {
    return { state: this.state, context: { compensations: [...this.compensations], failureReason: this.failureReason } };
  }
}
