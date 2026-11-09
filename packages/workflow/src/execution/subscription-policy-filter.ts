import type { PolicyRejectReason, PolicyResource, SubscriptionPolicy } from "./subscription-policy.js";
import type { WorkflowPolicySnapshotLookup } from "../domain/domain.js";
import { matchPolicy } from "./subscription-policy.js";
import type { WorkflowRepository } from "../persistence/repository.js";

type PolicyFilter = { accept: (candidate: PolicyResource) => boolean; rank: (candidate: PolicyResource) => number };
type PolicyFileValidator = (file: PolicyResource) => PolicyRejectReason | null;

/** Load one title-scoped policy once per task and expose the shared deterministic matcher. */
export async function loadSubscriptionPolicyFilter(input: {
  repository: Pick<WorkflowRepository, "getSubscriptionPolicy"> & Partial<Pick<WorkflowRepository, "getWorkflowRunPolicySnapshot">>;
  accountId: string;
  titleKey: string;
  workflowRunId?: string;
}): Promise<{
  policyFilter?: PolicyFilter;
  policyFileValidator?: PolicyFileValidator;
  subscriptionSearchKeywords?: string[];
}> {
  let snapshot: WorkflowPolicySnapshotLookup | null = null;
  if (input.workflowRunId && input.repository.getWorkflowRunPolicySnapshot) {
    try {
      snapshot = await input.repository.getWorkflowRunPolicySnapshot(input.workflowRunId, input.accountId);
    } catch {
      snapshot = null;
    }
  }
  if (snapshot && "legacyUnknown" in snapshot) {
    throw new Error("此任务没有入队时的订阅策略快照，请重新创建获取任务");
  }
  if (snapshot && (snapshot.schemaVersion !== 1 || snapshot.evaluatorVersion !== 1)) {
    throw new Error(`不支持的订阅策略快照版本（schema ${snapshot.schemaVersion} / evaluator ${snapshot.evaluatorVersion}）`);
  }
  const policy = snapshot
    ? snapshot.policy
    : await input.repository.getSubscriptionPolicy({ accountId: input.accountId, titleKey: input.titleKey });
  if (policy === null) return {};
  const matcher: SubscriptionPolicy = policy;
  const fileMatcher = { ...matcher, priorityGroups: [] };
  return {
    policyFilter: {
      accept: (candidate) => matchPolicy(matcher, candidate).matched,
      rank: (candidate) => {
        const verdict = matchPolicy(matcher, candidate);
        if (!verdict.matched || !verdict.priorityGroupId) return 0;
        return Math.max(0, (matcher.priorityGroups ?? []).findIndex((group) => group.id === verdict.priorityGroupId));
      },
    },
    policyFileValidator: (file: PolicyResource): PolicyRejectReason | null => {
      const verdict = matchPolicy(fileMatcher, file, { requireSeasonEpisodeForRange: (matcher.seasonEpisodeRanges?.length ?? 0) > 0 });
      return verdict.matched ? null : verdict.reason;
    },
    subscriptionSearchKeywords: [...(policy.customKeywords ?? [])],
  };
}
