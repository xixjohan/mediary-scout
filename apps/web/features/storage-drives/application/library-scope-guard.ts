import {
  assertWithinLibraryRoots,
  libraryRootCids,
  LIBRARY_SCOPE_UNKNOWN,
  OUTSIDE_LIBRARY_SCOPE,
  type BreadcrumbLike,
  type DriveDirectoryListing,
} from "@media-track/workflow";
import { getScopedStorageCredentials } from "../../../lib/media-scope";

/**
 * 网盘目录范围守卫（需求 2）。
 *
 * 两个入口共用同一份判定：
 *  - `assertListingInScope`：列表**已经**返回，面包屑就在响应里 → 零额外调用。
 *  - `assertDirectoryInScope`：写操作只知道目标 dirId，需要一次列表换取面包屑。
 *
 * 目标目录恰好是分类根时不发任何请求（最常见的转存/建目录场景）。
 */

export interface LibraryScopeCids {
  /** 三个分类目录：电影 / 剧集 / 动漫。**不含盘上的 `Mediary Scout/` 顶层容器**。 */
  roots: string[];
}

/** 取该网盘被视为「媒体库」的目录集合。为空表示尚未绑定影视库路径。 */
export async function resolveLibraryScopeCids(
  accountId: string,
  storageId: string | null | undefined,
): Promise<LibraryScopeCids> {
  // 范围以「拥有该盘的账号」为准：shared 模式下调用方传的是成员账号，
  // 但盘属于站长，直接用成员账号读凭据只会拿到空集 → 合法写入被误拒。
  const creds = await getScopedStorageCredentials(storageId);
  if (!creds) return { roots: [] };
  return { roots: libraryRootCids(creds) };
}

/** 列表响应的面包屑已在内存里：直接判定，不发额外请求。 */
export function assertListingInScope(
  listing: { breadcrumbs: readonly BreadcrumbLike[] },
  scope: LibraryScopeCids,
): void {
  assertWithinLibraryRoots(listing.breadcrumbs, scope.roots);
}

/**
 * 写操作的目标目录校验。目录恰好是分类根时直接放行（零调用）；否则取一次列表
 * 换取面包屑再断言。列表调用与用户随后要做的动作共用同一次 115 限流节拍。
 */
export async function assertDirectoryInScope(input: {
  accountId: string;
  storageId: string | null | undefined;
  directoryId: string;
  listDirectory: (directoryId: string) => Promise<{ breadcrumbs: readonly BreadcrumbLike[] }>;
  /** 注入根集合解析，便于纯测；生产默认读凭据。 */
  resolveScope?: (accountId: string, storageId: string | null | undefined) => Promise<LibraryScopeCids>;
}): Promise<void> {
  const scope = await (input.resolveScope ?? resolveLibraryScopeCids)(input.accountId, input.storageId);
  if (scope.roots.length === 0) {
    throw new Error(`${LIBRARY_SCOPE_UNKNOWN}: 该网盘尚未绑定影视库路径，无法确定可写目录范围`);
  }
  if (scope.roots.includes(input.directoryId)) return;
  assertWithinLibraryRoots(await input.listDirectory(input.directoryId).then((l) => l.breadcrumbs), scope.roots);
}

/** 把守卫抛出的错误转成 HTTP：越权 403，未配置 409（让用户知道该去设置里绑定）。 */
export function libraryScopeErrorStatus(message: string): number {
  if (message.startsWith(OUTSIDE_LIBRARY_SCOPE)) return 403;
  if (message.startsWith(LIBRARY_SCOPE_UNKNOWN)) return 409;
  return 500;
}

/**
 * 该账号是否**免于**目录范围限制。
 *
 * 判据是 `storage:browse_any` 这把钥匙，而不是「是不是站长」：站长天然带 `*` 会命中，
 * 但若某天站长被显式降权，判定也会跟着收紧，不存在第二套硬编码例外。
 */
export function bypassesLibraryScope(permissions: ReadonlySet<string>): boolean {
  return permissions.has("storage:browse_any") || permissions.has("*");
}

/**
 * 写操作的单点守卫：目标目录必须在媒体库范围内（持有 browse_any 的账号跳过）。
 *
 * 所有存储写接口（建目录 / 移动 / 复制 / 删除 / 采纳 / 离线转存）都走这一处，
 * 避免「每个路由自己判一遍」时漏掉某一个。列表调用由调用方注入，便于测试与复用
 * 已有的 fileManager 实例。
 */
export async function guardWriteTarget(input: {
  accountId: string;
  storageId: string | null | undefined;
  directoryId: string;
  permissions: ReadonlySet<string>;
  listDirectory: (directoryId: string) => Promise<{ breadcrumbs: readonly BreadcrumbLike[] }>;
  /** 注入根集合解析，便于纯测；生产默认读凭据。 */
  resolveScope?: (accountId: string, storageId: string | null | undefined) => Promise<LibraryScopeCids>;
}): Promise<void> {
  if (bypassesLibraryScope(input.permissions)) return;
  await assertDirectoryInScope({
    accountId: input.accountId,
    storageId: input.storageId,
    directoryId: input.directoryId,
    listDirectory: input.listDirectory,
    ...(input.resolveScope ? { resolveScope: input.resolveScope } : {}),
  });
}
