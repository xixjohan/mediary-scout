/**
 * STRM 播放签名密钥的启动期预热（单独成文件，避免 Turbopack 的动态解构导入缺陷）。
 *
 * 为什么不能把这段直接写在 `instrumentation-node.ts` 里：
 * 那里已经有 `const { validateRuntimeConfig } = await import("@media-track/workflow")`。
 * 再写一条同模块的动态**解构**导入，Turbopack 会把两者的模块句柄重命名冲突，
 * 运行时抛 `__TURBOPACK__imported__module__566619__ is not defined`（真机实测，
 * 表现为「预热静默失败、签名密钥永远不可用」）。把预热收进一个模块、内部用
 * **静态** import，一个动态 import 就够，冲突消失。
 *
 * 设计要点（与 `packages/workflow/src/strm/signing-secret.ts` 配套）：
 *  - 旧实现有硬编码回退常量，任何人读源码即可离线伪造播放令牌；
 *  - 现在与实例 JWT secret 同源（随机生成、落库加密、跨重启稳定），
 *    显式 `STRM_SECRET` / `APP_SECRET` 仍然优先；
 *  - 读库是异步、`resolveStrmSigningSecret()` 是同步，故在启动期预热进缓存。
 */
import { hasStrmSigningSecret, primeStrmSigningSecret } from "@media-track/workflow";
import { getJwtSecret } from "../features/auth/application/account-service";

export interface PrimeResult {
  primed: boolean;
  source: "env" | "instance-jwt" | "unavailable";
}

export async function primeStrmSigningFromInstance(): Promise<PrimeResult> {
  if (hasStrmSigningSecret()) {
    return { primed: true, source: "env" };
  }
  try {
    primeStrmSigningSecret(await getJwtSecret());
    return { primed: true, source: "instance-jwt" };
  } catch (error) {
    console.error(
      `[strm-signing] prime failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { primed: false, source: "unavailable" };
  }
}
