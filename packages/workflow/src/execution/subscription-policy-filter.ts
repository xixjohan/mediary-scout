import type { PolicyRejectReason, PolicyResource, SubscriptionPolicy } from "./subscription-policy.js";
import type { WorkflowPolicySnapshotLookup } from "../domain/domain.js";
import { matchPolicy } from "./subscription-policy.js";
import { titleIdentityFrom, type TitleIdentity } from "./title-identity.js";
import type { WorkflowRepository } from "../persistence/repository.js";

type PolicyFilter = { accept: (candidate: PolicyResource) => boolean; rejectReason: (candidate: PolicyResource) => PolicyRejectReason | null; rank: (candidate: PolicyResource) => number };
type PolicyFileValidator = (file: PolicyResource) => PolicyRejectReason | null;

/** 身份闸门所需的、来自被追踪作品的最小身份集。 */
export interface PolicyIdentityInput {
  tmdbId?: number | null | undefined;
  year?: number | null | undefined;
  title?: string | null | undefined;
  originalTitle?: string | null | undefined;
  aliases?: readonly string[] | null | undefined;
}

/**
 * Load one title-scoped policy once per task and expose the shared deterministic matcher.
 *
 * `identity` 是作品身份（片名/原名/别名/年份/tmdb id）。提供时它作为匹配的**第一步**
 * ——先确认「这是不是这部作品」，再套版本词。这修的是 2026-11-17 的假阳性事故：
 * 只写 `1080p` 的规则曾把《给你宇宙》《汪汪队立大功》之类的资源也算成命中。
 *
 * `identity` 缺省时行为与引入闸门之前完全一致（既有单测不受影响），但**生产路径三个
 * 入口都必须传**：巡检（runner-v2）、手动搜索/获取、规则预览。
 */
export async function loadSubscriptionPolicyFilter(input: {
  repository: Pick<WorkflowRepository, "getSubscriptionPolicy"> & Partial<Pick<WorkflowRepository, "getWorkflowRunPolicySnapshot">>;
  accountId: string;
  titleKey: string;
  workflowRunId?: string;
  identity?: PolicyIdentityInput | undefined;
}): Promise<{
  policyFilter?: PolicyFilter;
  policyFileValidator?: PolicyFileValidator;
  subscriptionSearchKeywords?: string[];
}> {
  let snapshot: WorkflowPolicySnapshotLookup | null = null;
  if (input.workflowRunId) {
    if (!input.repository.getWorkflowRunPolicySnapshot) {
      throw new Error("无法读取此任务的订阅策略快照；请重新创建获取任务");
    }
    snapshot = await input.repository.getWorkflowRunPolicySnapshot(input.workflowRunId, input.accountId);
    if (!snapshot) throw new Error("无法读取此任务的订阅策略快照；请重新创建获取任务");
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
  // 身份对象只在真的给了身份时构造：空身份会让闸门既无法否决也无法放行，
  // 与其假装判过，不如明确「这次不启用」。
  const identity: TitleIdentity | undefined = input.identity ? titleIdentityFrom(input.identity) : undefined;
  const options = identity === undefined ? {} : { identity };

  return {
    policyFilter: {
      accept: (candidate) => matchPolicy(matcher, candidate, options).matched,
      rejectReason: (candidate) => {
        const verdict = matchPolicy(matcher, candidate, options);
        return verdict.matched ? null : verdict.reason;
      },
      rank: (candidate) => {
        const verdict = matchPolicy(matcher, candidate, options);
        if (!verdict.matched) return 0;
        const groupIndex = verdict.priorityGroupId
          ? Math.max(0, (matcher.priorityGroups ?? []).findIndex((group) => group.id === verdict.priorityGroupId))
          : 0;
        // 只有配置了字幕偏好时才把「有无字幕」当第二排序键：没配字幕的用户
        // 不该看到一个凭空多出来的次序。
        const subtitleTerms = (matcher.subtitlePreference?.terms ?? []).filter((term) => term.trim().length > 0);
        if (subtitleTerms.length === 0) return groupIndex;
        return groupIndex * 2 + (verdict.hasSubtitle ? 0 : 1);
      },
    },
    policyFileValidator: (file: PolicyResource): PolicyRejectReason | null => {
      // 文件校验看的是**已经落盘的东西**：它不再需要身份闸门（东西都下载下来了），
      // 但仍要复核硬条件与集数范围。
      const verdict = matchPolicy(fileMatcher, file, { requireSeasonEpisodeForRange: (matcher.seasonEpisodeRanges?.length ?? 0) > 0 });
      return verdict.matched ? null : verdict.reason;
    },
    subscriptionSearchKeywords: [...(policy.customKeywords ?? [])],
  };
}
