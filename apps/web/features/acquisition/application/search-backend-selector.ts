import type { SearchBackend } from "@media-track/workflow";

/**
 * 后端选择器：未传或空数组 = 沿用账号已配置的全部后端（不限制）。
 *
 * 单独成文件而不是内联在 `getWorkerResourceProvider` 里：那个装配函数的复杂度
 * 与行数都已接近门禁，而「有没有选择」只是策略解析，不该和「注册哪些源」混在
 * 同一个函数体内。
 */
export function makeBackendSelector(
  backends: readonly SearchBackend[] | undefined,
): (backend: SearchBackend) => boolean {
  if (backends === undefined || backends.length === 0) return () => true;
  return (backend) => backends.includes(backend);
}
