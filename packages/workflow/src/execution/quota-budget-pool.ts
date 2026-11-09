/**
 * 双轨配额预算池与低水位熔断器 (Dual-Track Quota Budget Pool & Circuit Breaker)
 *
 * 核心痛点治理：
 * 1. 解决「凌晨定期巡检把当天全部 115 离线配额打光，导致白天用户手动操作被饿死」的问题；
 * 2. 实现前台交互池 (Interactive Pool 40%) 与后台巡检池 (Patrol Pool 60%) 的物理隔离；
 * 3. 低水位熔断：当网盘今日剩余配额低于安全水位 (如 <= 10 次) 时，自动暂停后台巡检下载，
 *    保留宝贵额度供前台手动操作使用，并在日志中清晰声明，绝不静默崩溃。
 */

export interface QuotaBudgetPoolConfig {
  /** 每日总离线/转存配额基数 (默认 50 次) */
  defaultDailyQuota?: number;
  /** 保留给前台手动交互的比例 (默认 0.4 即 40%) */
  interactiveReserveRatio?: number;
  /** 前台交互池最低保底次数 (默认 10 次) */
  minimumInteractiveReserve?: number;
  /** 低水位熔断阈值：低于此次数时巡检自动熔断休眠 (默认 10 次) */
  lowWatermark?: number;
}

export interface QuotaEvaluationInput {
  taskKind: "interactive" | "patrol";
  /** 当前网盘报告的今日剩余离线任务数 (若未知则传入 undefined) */
  currentDailyRemaining?: number;
  /** 今日后台巡检累计已消耗的离线任务数 */
  patrolConsumedToday?: number;
  /** 配置项覆盖 */
  config?: QuotaBudgetPoolConfig;
}

export interface QuotaEvaluationVerdict {
  allowed: boolean;
  circuitState: "closed" | "open";
  reason?: "allowed" | "low_watermark_tripped" | "patrol_budget_exhausted" | "daily_exhausted";
  interactiveReserved: number;
  patrolLimit: number;
  message: string;
}

export const DEFAULT_QUOTA_CONFIG: Required<QuotaBudgetPoolConfig> = {
  defaultDailyQuota: 50,
  interactiveReserveRatio: 0.4,
  minimumInteractiveReserve: 10,
  lowWatermark: 10,
};

/**
 * 计算双轨预算池切分
 */
export function calculateBudgetPools(
  totalDailyQuota: number,
  config?: QuotaBudgetPoolConfig,
): { interactiveReserved: number; patrolLimit: number } {
  const cfg = { ...DEFAULT_QUOTA_CONFIG, ...config };
  const total = Math.max(1, totalDailyQuota);

  const ratioReserve = Math.floor(total * cfg.interactiveReserveRatio);
  const interactiveReserved = Math.min(total, Math.max(ratioReserve, cfg.minimumInteractiveReserve));
  const patrolLimit = Math.max(0, total - interactiveReserved);

  return { interactiveReserved, patrolLimit };
}

/**
 * 评估任务是否准入消耗配额
 */
export function evaluateQuotaBudget(input: QuotaEvaluationInput): QuotaEvaluationVerdict {
  const cfg = { ...DEFAULT_QUOTA_CONFIG, ...input.config };
  const totalQuota = cfg.defaultDailyQuota;
  const { interactiveReserved, patrolLimit } = calculateBudgetPools(totalQuota, cfg);

  const dailyRemaining = input.currentDailyRemaining;
  const patrolConsumed = input.patrolConsumedToday ?? 0;

  // 1. 绝对枯竭检查 (网盘直接报 0)
  if (dailyRemaining !== undefined && dailyRemaining <= 0) {
    return {
      allowed: false,
      circuitState: "open",
      reason: "daily_exhausted",
      interactiveReserved,
      patrolLimit,
      message: "网盘今日离线配额已完全耗尽 (剩余 0 次)，所有下载任务暂停",
    };
  }

  // 2. 前台交互任务判定 (享有最高优先级)
  if (input.taskKind === "interactive") {
    // 只要网盘还有剩余（或者未报告剩余），前台交互一律放行
    return {
      allowed: true,
      circuitState: "closed",
      reason: "allowed",
      interactiveReserved,
      patrolLimit,
      message: "前台用户手动交互任务，享有最高优先级配额通行权",
    };
  }

  // 3. 后台巡检任务判定 (受低水位与巡检预算池双重门禁约束)
  // 门禁 A: 低水位熔断器 (Low Watermark Trip)
  if (dailyRemaining !== undefined && dailyRemaining <= cfg.lowWatermark) {
    return {
      allowed: false,
      circuitState: "open",
      reason: "low_watermark_tripped",
      interactiveReserved,
      patrolLimit,
      message:
        `115 每日离线配额触及安全低水位 (剩余 ${dailyRemaining} <= 安全线 ${cfg.lowWatermark})。` +
        "后台自动补集已主动休眠，保留剩余额度供前台手动使用，绝不拖垮交互。",
    };
  }

  // 门禁 B: 今日巡检预算限额 (Patrol Budget Cap)
  if (patrolConsumed >= patrolLimit) {
    return {
      allowed: false,
      circuitState: "open",
      reason: "patrol_budget_exhausted",
      interactiveReserved,
      patrolLimit,
      message:
        `今日后台巡检已达到预算上限 (${patrolConsumed}/${patrolLimit} 次)。` +
        "已熔断本日后续自动扫描下载，保留交互池供用户使用。",
    };
  }

  // 门禁全部通过
  return {
    allowed: true,
    circuitState: "closed",
    reason: "allowed",
    interactiveReserved,
    patrolLimit,
    message: `配额池充足 (巡检已用 ${patrolConsumed}/${patrolLimit} 次)，允许自动离线下载`,
  };
}
