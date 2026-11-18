import { getAccountStorageCredentials, resolveGlobalWorkspace } from "../../../../../lib/workflow-runtime";

/**
 * 预览取数时要选哪个网盘品牌的 provider。
 *
 * 资源路由按「已追踪的季 / 显式 storageId / 全局工作区」解析网盘品牌；预览此时
 * 可能还没有追踪关系（新订阅流程），所以只按全局工作区 → 默认品牌兜底。
 * 这只影响 provider 的 allowedTypes（115 / 夸克 / 磁力），不影响策略判定。
 */
export async function resolvePreviewDriveProvider(accountId: string): Promise<string> {
  try {
    const workspace = await resolveGlobalWorkspace(undefined);
    const creds = await getAccountStorageCredentials(accountId, workspace.connectedStorageId ?? undefined);
    if (creds?.provider) return creds.provider;
  } catch {
    // 工作区还没绑定网盘时按默认品牌取数：预览是只读，不该因此 500。
  }
  return "pan115";
}
