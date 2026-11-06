import type { PolicyRejectReason, PolicyResource, SubscriptionPolicy } from "./subscription-policy.js";
import { matchPolicy } from "./subscription-policy.js";
import type { WorkflowRepository } from "../persistence/repository.js";

type PolicyFilter = { accept: (candidate: PolicyResource) => boolean };
type PolicyFileValidator = (file: PolicyResource) => PolicyRejectReason | null;

/** Load one title-scoped policy once per task and expose the shared deterministic matcher. */
export async function loadSubscriptionPolicyFilter(input: {
  repository: Pick<WorkflowRepository, "getSubscriptionPolicy">;
  accountId: string;
  titleKey: string;
}): Promise<{
  policyFilter?: PolicyFilter;
  policyFileValidator?: PolicyFileValidator;
  subscriptionSearchKeywords?: string[];
}> {
  const policy = await input.repository.getSubscriptionPolicy({
    accountId: input.accountId,
    titleKey: input.titleKey,
  });
  if (policy === null) return {};
  const matcher: SubscriptionPolicy = policy;
  return {
    policyFilter: { accept: (candidate) => matchPolicy(matcher, candidate).matched },
    policyFileValidator: (file: PolicyResource): PolicyRejectReason | null => {
      const verdict = matchPolicy(matcher, file);
      return verdict.matched ? null : verdict.reason;
    },
    subscriptionSearchKeywords: [...(policy.customKeywords ?? [])],
  };
}
