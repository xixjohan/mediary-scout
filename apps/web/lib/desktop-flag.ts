/**
 * 桌面端判定——刻意做成零依赖叶子模块（任务单 S4.3 构建回归修复）。
 *
 * 它原先住在 workflow-runtime.ts（3,700 行 + 整个 @media-track/workflow
 * barrel）。设置页的客户端组件经「use server」动作链 reaches 到它，Turbopack
 * 会把整棵服务端子树编进客户端 chunk：HEAD 时拖进去的是 pg（JS，能打包，
 * 只是肿胀）；S1.4/S1.5 之后子树里出现 node:fs（内置，不能打包）→ 构建直接
 * 失败。把这一行 env 读取独立出来，链在此切断。
 */
export function resolveIsDesktop(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEDIA_TRACK_DESKTOP === "1";
}
