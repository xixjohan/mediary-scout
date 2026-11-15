/**
 * 网盘目录范围的边界判定（需求 2：只允许访问媒体库根目录内的文件）。
 *
 * 为什么是 ABAC 而不是权限点：RBAC 只能表达「这个角色能不能浏览网盘」，无法表达
 * 「能浏览哪几个目录」。把目录写进权限点会让每加一个库就要改角色配置。
 *
 * **零额外 API 调用**：115 的目录列表响应自带面包屑（`path`/`breadcrumbs`），
 * 已在 [drive-file-manager](../../../storage/drive-file-manager.ts) 解析。因此
 * 「这个目录是否在媒体库根内」可以在同一次列表响应里判定。若改用
 * `getDirectoryInfo` 额外探一次，每次浏览都会多一次 115 调用（1200ms 漏桶下明显拖慢）。
 *
 * **fail-closed**：媒体库根集合为空（新连接尚未解析出分类目录）时一律拒绝。
 * 放行会让「还没配好」的窗口变成越权窗口。
 */

/** 面包屑形状的最小契约：只要 id。 */
export interface BreadcrumbLike {
  id: string;
}

/**
 * 目录是否落在某个媒体库根之内（含根自身）。
 *
 * 合法性依据：面包屑是**从盘根到目标目录**的完整链路，因此「目标在根内」等价于
 * 「根的 cid 出现在面包屑里」。仅比较末项会把根下的子目录判成越权。
 */
export function isWithinLibraryRoots(
  breadcrumbs: readonly BreadcrumbLike[],
  libraryRootCids: readonly string[],
): boolean {
  const roots = libraryRootCids.filter((cid) => cid.trim().length > 0);
  if (roots.length === 0) return false; // fail-closed：未配置 = 拒绝
  if (breadcrumbs.length === 0) return false; // 驱动未返回面包屑 = 无法判定 = 拒绝
  const ids = new Set(breadcrumbs.map((b) => b.id));
  return roots.some((root) => ids.has(root));
}

/**
 * 从连通存储记录里取出「合法的媒体库根」。
 *
 * 刻意**不含 `rootCid`**：`rootCid` 是盘上的 `Mediary Scout/` 顶层容器，其中除
 * Movies/TV/Anime 之外还可能存在用户自己放的无关目录。把 rootCid 算作合法根等于
 * 允许成员浏览那个容器下的一切。只有三个分类目录才是媒体库的真正边界。
 */
export function libraryRootCids(input: {
  moviesCid?: string | null;
  tvCid?: string | null;
  animeCid?: string | null;
}): string[] {
  return [input.moviesCid, input.tvCid, input.animeCid].filter(
    (cid): cid is string => typeof cid === "string" && cid.trim().length > 0,
  );
}

/** 越权或无法判定时的错误标识，供上层转成可区分的用户文案。 */
export const OUTSIDE_LIBRARY_SCOPE = "OUTSIDE_LIBRARY_SCOPE";
export const LIBRARY_SCOPE_UNKNOWN = "LIBRARY_SCOPE_UNKNOWN";

/**
 * 断言：目录必须在媒体库根内。失败抛错，**消息前缀可区分两种原因**——
 * 用户看到 "未配置" 时应去设置里绑定目录，看到 "越权" 时应停止尝试。
 */
export function assertWithinLibraryRoots(
  breadcrumbs: readonly BreadcrumbLike[],
  libraryRootCids: readonly string[],
): void {
  if (libraryRootCids.filter((cid) => cid.trim().length > 0).length === 0) {
    throw new Error(`${LIBRARY_SCOPE_UNKNOWN}: 该网盘尚未解析出媒体库目录，请先在设置中绑定影视库路径`);
  }
  if (!isWithinLibraryRoots(breadcrumbs, libraryRootCids)) {
    throw new Error(`${OUTSIDE_LIBRARY_SCOPE}: 该目录不在影视库范围内`);
  }
}
