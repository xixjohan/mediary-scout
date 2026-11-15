import {
  createStorageScopeStrategy,
  getMultiUserMode,
} from "@media-track/workflow";
import { getCurrentAccountId } from "../composition/runtime-container";
import {
  getAccountDriveFileManager,
  getAccountStorageCredentials,
} from "../features/storage-drives/application/drive-service";
import type { AccountStorageCredentials } from "../features/storage-drives/contracts/storage-types";

/**
 * 媒体资源的**归属账号**（读侧与写侧共用）。
 *
 * 三种多用户模式的目标账号不同（语义由既有的 `createStorageScopeStrategy()` 定义）：
 *  - off（单用户）：默认账号
 *  - isolated：请求者自己（各人各盘各库）
 *  - shared：**站长账号**——盘与影视库是公共资源，成员只是使用者
 *
 * 这个策略族一直存在却从未被业务层消费，后果是 shared 模式下成员读写都作用在自己的
 * 空账号上：盘看不见、库为空、连"验证目录范围"都因取不到凭据而 fail-closed 误拒。
 *
 * 注意：**归属账号只决定"用哪块盘"，不决定"能不能做"**。能不能做仍由
 * `requirePermission`（功能权限）与 `guardWriteTarget`（目录范围）裁决。
 */
export async function resolveMediaScopeAccountId(): Promise<string> {
  const scope = await createStorageScopeStrategy(getMultiUserMode()).resolveMediaScope({
    requestAccountId: await getCurrentAccountId(),
  });
  return scope.targetAccountId;
}

/** 归属账号下的网盘文件管理器。写路径也必须用它，否则 shared 模式下找不到盘。 */
export function getScopedDriveFileManager(storageId?: string | null) {
  return resolveMediaScopeAccountId().then((accountId) => getAccountDriveFileManager(accountId, storageId));
}

/** 归属账号下的网盘凭据（品牌客户端、转存、范围解析共用）。 */
export async function getScopedStorageCredentials(
  storageId?: string | null,
): Promise<AccountStorageCredentials | null> {
  return getAccountStorageCredentials(await resolveMediaScopeAccountId(), storageId);
}
