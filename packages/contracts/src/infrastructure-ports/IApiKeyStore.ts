/**
 * API Key 存储端口（S5.2）。
 *
 * 形状的唯一定义在 `@media-track/shared` 的 api-key-source.ts——那里同时住着
 * resolveApiKey（数据库 > 环境变量）的优先级语义，端口与判定必须同源，复制一份
 * 必然漂移（此前这里就有一份同形重复定义，零消费者，逐维核查标记为死导出）。
 * 本文件只做 re-export：契约层继续对外暴露这个端口，定义仍只有一处。
 *
 * 方向说明：shared 是基础层、严禁依赖 contracts（L2），所以定义只能落在 shared，
 * 由 contracts 反向 re-export；真实实现在 packages/workflow/src/sqlite.ts
 * （值落 app_settings，由 SECRET_SETTING_KEYS 透明 AES-256-GCM 加密）。
 */
export type { IApiKeyStore } from "@media-track/shared";
