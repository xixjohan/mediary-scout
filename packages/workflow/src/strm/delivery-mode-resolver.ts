import type { BindingDeliveryMode, LibraryDeliveryMode } from "@media-track/contracts";
import { determineEffectiveDeliveryMode } from "./strm-delivery.js";

/**
 * 投送模式解析责任链。
 *
 * 优先级（前者覆盖后者）：
 *   session（用户本次手动切换）
 *     > binding（路径绑定，非 inherit）
 *       > library（影视库默认）
 *         > global（账号/系统默认）
 *           > 兜底 redirect
 *
 * 选定配置后必须再交给 `determineEffectiveDeliveryMode` 做最终裁决：
 * 夸克/UC 必须代理、115 对高危 UA 回退代理等「驱动物理约束」拥有一票否决权，
 * 用户配置不能绕过，否则会制造必然失败的播放请求。
 *
 * 纯函数、无 IO：所有上下文由调用方一次性查出后传入。
 */
export type ResolvedDeliveryMode = "proxy" | "redirect";

export type DeliveryModeSource =
  | "session"
  | "binding"
  | "library"
  | "global"
  | "driver-rule"
  | "default";

export interface DeliveryModeResolutionInput {
  /** 用户在播放器内本次会话的显式选择。 */
  sessionOverride?: ResolvedDeliveryMode | null | undefined;
  /** 路径绑定配置；`inherit` 表示向上继承，不参与决策。 */
  bindingMode?: BindingDeliveryMode | null | undefined;
  /** 影视库默认投送策略。 */
  libraryMode?: LibraryDeliveryMode | null | undefined;
  /** 账号/系统级默认，缺省不参与。 */
  globalMode?: ResolvedDeliveryMode | null | undefined;
  /** 存储提供商（quark / uc / pan115 ...），用于驱动物理约束。 */
  provider?: string | null | undefined;
  /** 客户端 UA，用于高危播放器安全回退。 */
  userAgent?: string | null | undefined;
}

export interface DeliveryModeDecision {
  mode: ResolvedDeliveryMode;
  source: DeliveryModeSource;
  reason: string;
}

interface Candidate {
  mode: ResolvedDeliveryMode;
  source: Exclude<DeliveryModeSource, "driver-rule" | "default">;
}

function pickCandidate(input: DeliveryModeResolutionInput): Candidate | null {
  if (input.sessionOverride) {
    return { mode: input.sessionOverride, source: "session" };
  }
  // inherit 是显式的「向上继承」语义，不能当作 redirect 兜底。
  if (input.bindingMode && input.bindingMode !== "inherit") {
    return { mode: input.bindingMode, source: "binding" };
  }
  if (input.libraryMode) {
    return { mode: input.libraryMode, source: "library" };
  }
  if (input.globalMode) {
    return { mode: input.globalMode, source: "global" };
  }
  return null;
}

export function resolveDeliveryMode(
  input: DeliveryModeResolutionInput,
): DeliveryModeDecision {
  const candidate = pickCandidate(input);
  // 无任何层级配置时传 "auto"，而不是硬兜底 redirect：
  // 让驱动默认策略生效（115 缺省代理、夸克强制代理、通用驱动按 UA 判定）。
  const configuredMode = candidate?.mode ?? "auto";

  const effective = determineEffectiveDeliveryMode({
    configuredMode,
    provider: input.provider ?? undefined,
    userAgent: input.userAgent ?? undefined,
  });

  if (candidate && effective !== candidate.mode) {
    return {
      mode: effective,
      source: "driver-rule",
      reason: `${input.provider ?? "存储驱动"} 的物理约束/安全策略否决了 ${candidate.mode}（原来源：${candidate.source}）`,
    };
  }

  return {
    mode: effective,
    source: candidate?.source ?? "default",
    reason: candidate
      ? `来源：${candidate.source}，配置为 ${candidate.mode}`
      : "未配置任何层级，兜底 redirect",
  };
}
