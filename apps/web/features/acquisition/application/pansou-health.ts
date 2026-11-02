import { getCurrentAccountId, getWorkflowRepository } from "../../../composition/runtime-container";
import { PANSOU_HEALTH_SETTING_KEY } from "../../../lib/runtime/settings-readers";

const lastRecordedPanSouHealth = new Map<string, string>();

/** 记录自建搜索源的最新健康结论,供设置页徽章读取(它每 8s 轮询,不能自己打网络)。
 *  幂等:值未变化就不写,避免每次搜索都产生一次 DB 写。 */
export async function recordPanSouHealth(healthy: boolean, accountId?: string): Promise<void> {
  const value = healthy ? "ok" : "unhealthy";
  try {
    const resolved = accountId ?? (await getCurrentAccountId());
    if (lastRecordedPanSouHealth.get(resolved) === value) return;
    await getWorkflowRepository().setAccountSetting(
      resolved,
      PANSOU_HEALTH_SETTING_KEY,
      value,
    );
    lastRecordedPanSouHealth.set(resolved, value);
  } catch (error) {
    console.warn(
      `[pansou-health] 记录健康态失败(不影响本次搜索): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
