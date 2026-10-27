import type { AgentDecisionSource, ResourceSnapshot } from "./domain.js";

/**
 * CandidateSelector: the port that picks which candidates to acquire (batch 3, item ④).
 *
 * Until now there was exactly one selector — the agent, which judges candidates from
 * their display fields and returns ids. Manual import adds a second: a human pressing
 * 手动入库 on one row. The plan requires both to emit STRUCTURALLY IDENTICAL
 * `AgentDecision`s, so both go through this port and both return the same
 * `CandidateSelection` shape. The ONLY permitted difference in the persisted decision
 * is `source`.
 *
 * Why a port and not an if/else at the call site: the two selectors disagree about
 * everything except the output shape. The agent needs the snapshot's display fields
 * and a model; the human needs one candidateId the user already chose. Forking that at
 * the call site is how the two paths' decisions drift apart — which is precisely what
 * the acceptance criterion forbids.
 */
export interface CandidateSelectionInput {
  snapshot: ResourceSnapshot;
  /** Title-level context for the agent's judgement; unused by the human selector. */
  title?: string;
  aliases?: readonly string[];
}

export interface CandidateSelection {
  /** Ids of the candidates to acquire. Never empty for a real selection. */
  selectedCandidateIds: string[];
  /** How sure the selector is. A human pick is "high" — they saw the row. */
  confidence: "low" | "medium" | "high";
  /** One line explaining the pick, for the decision's `reason`. */
  reason: string;
}

export interface CandidateSelector {
  readonly source: AgentDecisionSource;
  select(input: CandidateSelectionInput): Promise<CandidateSelection> | CandidateSelection;
}

/**
 * The human selector: the user already chose, so this is a projection, not a
 * judgement. It validates the id against the snapshot (the same membership check the
 * resolver does) rather than trusting the caller — a selector that echoes back
 * whatever it was handed would let a stale id reach the transfer.
 */
export class HumanCandidateSelector implements CandidateSelector {
  readonly source: AgentDecisionSource = "human";

  constructor(private readonly candidateId: string) {}

  select(input: CandidateSelectionInput): CandidateSelection {
    const candidate = input.snapshot.candidates.find(
      (entry) => entry.id === this.candidateId && entry.snapshotId === input.snapshot.id,
    );
    if (candidate === undefined) {
      // Not a selection: the caller must treat an empty list as "nothing to do".
      return { selectedCandidateIds: [], confidence: "low", reason: "候选不属于本次搜索" };
    }
    return {
      selectedCandidateIds: [candidate.id],
      confidence: "high",
      reason: `用户手动选择：${candidate.title}`.slice(0, 2000),
    };
  }
}

/**
 * Build the AgentDecision-shaped record both selectors converge on. Taking the
 * selection through ONE constructor is what makes 「两条路径结构一致」 checkable
 * rather than aspirational.
 */
export function decisionFromSelection(input: {
  selection: CandidateSelection;
  snapshot: ResourceSnapshot;
  source: AgentDecisionSource;
  node: string;
  rejectedCandidateIds?: readonly string[];
}): {
  node: string;
  snapshotId: string;
  source: AgentDecisionSource;
  selectedCandidateIds: string[];
  episodeMapping: Record<string, string[]>;
  providerAheadEpisodeMapping: Record<string, string[]>;
  rejectedCandidateIds: string[];
  confidence: "low" | "medium" | "high";
  reason: string;
} {
  return {
    node: input.node,
    snapshotId: input.snapshot.id,
    source: input.source,
    selectedCandidateIds: [...input.selection.selectedCandidateIds],
    episodeMapping: {},
    providerAheadEpisodeMapping: {},
    rejectedCandidateIds: [...(input.rejectedCandidateIds ?? [])],
    confidence: input.selection.confidence,
    reason: input.selection.reason.slice(0, 2000),
  };
}
