# 巡检多选项兼容修复交接

交接日期为 2026-11-19（香港时间）。当前进度为：开发实机隔离复测已圆满完成（运行 ID `4fa1037d-5383-4439-bf56-dfe4049246b1`，确认网关多 choice 下备选工具调用成功进入 SDK 并闭环执行 27 步沙盒工具），全部质量门禁与 1,661 项单元测试通过，处于就绪交付待发版状态。生产发布以整体发布计划为准。

## 已完成的验证

- 同一份首轮巡检请求发往网关，明确增加 `n: 1` 后仍返回两个 `choices`。首项仅含文本，第二项含两个工具调用，SDK 原先固定解析首项。
- 适配层在非流式自动工具选择请求中识别该响应。当首项仅含文本，后续仅有一个携带本次已声明工具的选项时，把完整选项交给 SDK。SDK 和沙盒继续校验参数、权限及操作状态。首项有工具、后续有多个工具选项、未声明工具、无工具请求和内容过滤均保持原处理路径。
- 138 个相关测试文件共 1,661 项通过。工作流构建、全仓类型检查、变更源文件 lint、凭据安全门禁和 `gate:blame-free` 通过。
- 开发实例 `mediary-dev` 的实际构建为 `f3ee57fc-dirty-212644`，直接健康探测返回 `{"status":"ok"}`。
- **实机隔离复测验收通过**：使用开发生效的真实模型配置与代理，在独立 SQLite (`/tmp/diagnostics.sqlite`) 恢复《桃源暗鬼》第 2 季并以 `runQueuedType3Monitoring` 消费。运行 ID 为 `4fa1037d-5383-4439-bf56-dfe4049246b1`。首轮请求命中网关双 choice 形态（脱敏指纹 `d2e0aea925c0`，后项工具 `readSkill`），并在后续第 9、16、17 轮多次复现，均由适配层正确提取送入 SDK 执行。全程执行 27 步沙盒工具，转存 0 次，安全结算为 `no_coverage`，开发业务库保持 0 污染。详细证据见[调查文档](../research/2026-11-19-acquisition-agent-error-diagnosis.md)。

相关材料见[调查证据](../research/2026-11-19-acquisition-agent-error-diagnosis.md)、[适配层](../../packages/workflow/src/domain/agent-model.ts)和[协议回归](../../packages/workflow/tests/domain/agent-model.test.ts)。

## 1. 核对开发实例

在仓库根目录运行以下命令，确认接下来的复测命中新构建。

```powershell
& ./scripts/deploy-remote.ps1 -Mode Dev -RemoteExec 'docker exec mediary-dev cat /app/BUILD_COMMIT; curl -fsS --noproxy "*" --max-time 8 http://127.0.0.1:3020/api/health'
```

预期构建包含 `selectToolChoice` 实现，健康探测可用。部署脚本轮询超时可用直接探测复核。若开发环境已换成其他构建，确认它包含本次适配层变更后再复测。

## 2. 用真实配置运行隔离巡检

开发业务库中这条订阅已经完结。直接点击「搜索缺集」会由已完结状态短路。用独立 SQLite 复现历史缺集，可让真实模型及搜索链跑起来，同时将转存和整理操作交给模拟网盘。

1. 在开发容器内，用现有账号设置读取器解析生效模型。沿用 `resolveAgentModelConfig`、`createAgentModel` 和 `configureHttpProxyFromEnv`。模型地址、密钥和完整请求体留在容器进程内。
2. 只读获取《桃源暗鬼》第 2 季的作品与订阅元数据。用独立的 `diagnostics.sqlite` 创建 `SqliteWorkflowRepository`。在该库恢复 `active`、已播 7 集、E01–E07 全缺的状态。使用 `createEpisodeStates` 和 `saveWorkflowRunSnapshot` 准备夹具。
3. 使用 `queueTrackedSubscriptionSearch` 将任务入队，并以 `runQueuedType3Monitoring` 消费。搜索侧复用开发 PanSou 配置及 `buildPanSouProviderChain`，存储执行器传 `FakeStorageExecutor`。保存隔离库路径、运行 ID、构建指纹和测试时间。
4. 在模型工厂的自定义 `fetch` 入口采集第一轮。对实际请求正文计算 SHA-256，记录工具数和选择策略。对响应记录 HTTP 状态、各 `choice` 的位置、停止原因、工具调用数及该请求已声明的工具名。输出限于这些脱敏字段。历史复现的请求正文为 24,960 字节，摘要为 `48ef8be7a6f40736f244707302cf462fe6d37294145687ee7423ba6573a52328`。摘要变化时注明输入条件差异，仍可对照网关返回的形态与实际执行。
5. 等待该轮结算，重新以只读方式打开独立 SQLite。按运行 ID 核对 `workflow_runs`、`agent_steps`、`resource_snapshots`、`transfer_attempts` 和 `notifications`。同时只读核对开发业务库，确认该运行 ID 仅存在于隔离库。

可在独立库用以下查询获取必要证据。将 `:run_id` 绑定为本轮运行 ID。

```sql
SELECT json_extract(w.payload, '$.status') AS status,
       json_extract(e.value, '$.type') AS event,
       json_extract(e.value, '$.data.category') AS category,
       json_extract(e.value, '$.data.stopReason') AS stop_reason
FROM workflow_runs w, json_each(w.payload, '$.auditEvents') e
WHERE w.id = :run_id
  AND json_extract(e.value, '$.type') IN ('agent_model_diagnostic', 'loop_stopped', 'agent_read_only_recovery');

SELECT json_extract(payload, '$.toolName') AS tool_name,
       json_extract(payload, '$.status') AS status
FROM agent_steps WHERE workflow_run_id = :run_id ORDER BY ordinal;

SELECT json_array_length(payload, '$.candidates') AS candidate_count
FROM resource_snapshots WHERE workflow_run_id = :run_id ORDER BY ordinal;

SELECT COUNT(*) AS transfer_attempts
FROM transfer_attempts WHERE workflow_run_id = :run_id;

SELECT json_extract(payload, '$.kind') AS kind,
       json_extract(payload, '$.report.status') AS report_status
FROM notifications WHERE workflow_run_id = :run_id ORDER BY ordinal;
```

## 3. 判断是否通过

| 观察 | 验收结论 |
| --- | --- |
| 网关原始响应仍是首项文本、第二项带工具，工具轨迹证明选中项进入 SDK | 本次线上形态已重现，适配层兼容通过。核对执行项属于同一个 `choice`，且每次真实工具执行都遵守现有沙盒边界 |
| 响应只返回一项，或首项本身带工具 | 普通路径验证通过。多选项兼容分支的现场验收仍待命中，可用已通过的协议夹具记录确定性结果 |
| 原始响应多项且有多个工具选项，或选中项含非法参数 | 保留安全结算。多个备选保持原路径，非法参数由 SDK 拒绝。查看停止原因和工具轨迹，避免为获得成功状态放宽约束 |
| 工具有真实调用记录，搜索仍为健康零命中 | 可以判定修复已恢复工具调用。只有出现现有业务终结证据才能结算为真实无覆盖或完成，空快照本身只说明当前检索结果 |

真实复测的关键判据是同一个含工具的备选进入 SDK 且通过原有校验。最终能否获取资源取决于后续搜索结果与现有业务证据。记录原始选项、工具轨迹、转存计数和最终通知，将脱敏结果追加到[调查文档](../research/2026-11-19-acquisition-agent-error-diagnosis.md)。

## 4. 复核后交付

复测通过后，用仓库现有流程复核本次代码。可从下列相关测试和门禁开始。

```powershell
npm run build:workflow
npm run typecheck
npm test -- packages/workflow/tests/domain/agent-model.test.ts packages/workflow/tests/domain/agent-model-probe.test.ts packages/workflow/tests/acquisition-v2 packages/workflow/tests/execution
npm run gate:blame-free
```

如果仍有首项纯文本且后续工具未进入 SDK，先核对响应内容类型、首个选项的停止原因、后续有效选项数量、请求工具选择方式及工具名称是否在声明列表。把失败形态加到协议回归，再决定是否扩展兼容范围。

如确认正式发布，按[项目指南](../../AGENTS.md)执行完整质量门禁、发布说明、Tag、CI 构建及生产健康复核。
