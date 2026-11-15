"use server";

/**
 * 播放器投送模式记忆（P2-B）的账号级读写入口。
 *
 * 走 Server Action 而非新增 REST 端点：复用既有鉴权/账号上下文与
 * `account_settings` 白名单校验，不引入新的 API 契约面。
 * 该文件中的导出必须且只能是 async 函数（gate:server-actions 约束）。
 */

import { assertNotDemo } from "../../lib/demo-mode";
import {
  PLAYER_DELIVERY_MODE_SETTING_KEY,
  normalizePlayerDeliveryPreferenceInput,
  parsePlayerDeliveryPreference,
} from "@media-track/workflow";

/** 返回记忆值：proxy / redirect / auto；无记忆或读取失败返回 null。 */
export async function readPlayerDeliveryPreferenceAction(): Promise<string | null> {
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import(
      "../../lib/workflow-runtime"
    );
    const accountId = await getCurrentAccountId();
    const raw = await getWorkflowRepository().getAccountSetting(
      accountId,
      PLAYER_DELIVERY_MODE_SETTING_KEY,
    );
    return parsePlayerDeliveryPreference(raw);
  } catch {
    // 未认证 / DB 不可用：优雅降级为「无记忆」，绝不阻断播放。
    return null;
  }
}

/** 写入记忆；`auto` 表示清除覆盖、恢复责任链默认。 */
export async function savePlayerDeliveryPreferenceAction(
  input: string,
): Promise<{ success: boolean }> {
  const preference = normalizePlayerDeliveryPreferenceInput(input);
  if (!preference) return { success: false };
  try {
    assertNotDemo();
    const { getWorkflowRepository, getCurrentAccountId } = await import(
      "../../lib/workflow-runtime"
    );
    const accountId = await getCurrentAccountId();
    // 需求 2：被锁定播放方式的账号不得写入覆盖偏好——否则前端藏了按钮，
    // 服务端仍会收下这条"用户选择"，下次解析时又要专门过滤，等于把守卫拆成两处。
    const { resolvePageAccess } = await import("../../lib/page-permission-guard");
    const { shouldHonorDeliveryPreference } = await import("../../lib/playback-mode-policy");
    const access = await resolvePageAccess();
    const secLike = { isMaster: access.isOwner, permissions: access.permissions } as const;
    if (!shouldHonorDeliveryPreference(secLike)) {
      return { success: false };
    }
    await getWorkflowRepository().setAccountSetting(
      accountId,
      PLAYER_DELIVERY_MODE_SETTING_KEY,
      preference,
    );
    return { success: true };
  } catch {
    // 演示站 / 未认证 / DB 不可用：本次会话内仍生效，仅不持久化。
    return { success: false };
  }
}
