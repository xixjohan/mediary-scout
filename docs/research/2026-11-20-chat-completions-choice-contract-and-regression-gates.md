# 巡检工具调用的多选项兼容与回归门禁

调查日期为 2026-11-20（香港时间）。范围为巡影获取任务的非流式 OpenAI 兼容 Chat Completions。已有开发实测和转发追踪记录见[原调查](2026-11-19-acquisition-agent-error-diagnosis.md)。

## 问题与根因

一次 HTTP 响应可以合法承载多个 `choices`。在 Chat Completions 契约中，`n` 控制生成的备选数，单个备选中的 `message.tool_calls` 则可以包含多个工具调用。工具循环需要先确定采用哪个备选，再按该备选的工具调用继续会话。部分较新的 OpenAI 模型甚至拒绝显式传入 `n`，包括 `n: 1`，因此不能把强制添加该参数作为通用修复。见 [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

本次重新读取用户保留的《桃源暗鬼》第 2 季请求与响应文件，校验两者 SHA-256 与捕获元数据一致。请求正文为 24,960 字节，摘要为 `48ef8be7a6f40736f244707302cf462fe6d37294145687ee7423ba6573a52328`，包含 14 个工具定义、`tool_choice: "auto"`，省略 `n`。网关返回 HTTP 200，下游请求 ID 的脱敏指纹为 `9127600c8551`。

| 网关原始响应 | `content` | `reasoning_content` / `reasoning` | `finish_reason` | `tool_calls` |
| --- | --- | --- | --- | --- |
| `choices[0]`，`index=0` | 非空文本 | 均缺失 | 缺失 | 缺失 |
| `choices[1]`，`index=1` | 缺失 | 均缺失 | `tool_calls` | 两个 `readSkill` 调用 |

**巡检提前结束的直接原因是选项在进入工具循环前被丢失。** 仓库锁定的 `@ai-sdk/openai-compatible@2.0.48` 在非流式解析中取 `responseBody.choices[0]`。首项的停止原因被归一为 `other`，第二项的两个调用没有进入 SDK 的工具执行器。此前同一请求显式加 `n: 1` 后，网关仍返回两项。同一版 SDK 的合成对照只交换数组位置，工具执行数即从 0 变为 2。

首项的普通文本和缺失的结束原因不能证明它是思考过程。网关下游报文已证实两项存在，产生这两项的位置仍需通过同一事务的上游原始响应确认。若上游为 SSE，应按 `choice.index` 汇总增量，再比较逻辑选项数量。多次上游尝试也需分别关联。见[按请求 ID 对照网关转发边界](2026-11-19-acquisition-agent-error-diagnosis.md#2026-11-20-按请求-id-对照网关转发边界)。

## 现有库与业界方案

| 方案 | 可以复用或借鉴的能力 | 对本项目的取舍 |
| --- | --- | --- |
| Vercel AI SDK + OpenAI Compatible | `generateText`、工具 schema、步骤治理、模型测试替身。兼容 provider 支持注入 `fetch`，可在 SDK 取首项之前处理报文 | 首选。两个依赖均已安装，窄范围复用现成执行器。见 [OpenAI Compatible Provider](https://ai-sdk.dev/providers/openai-compatible-providers)、[生成接口](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)、[测试工具](https://ai-sdk.dev/docs/ai-sdk-core/testing) |
| OpenAI Node SDK | 低层 `chat.completions.create()` 适合保留完整选择数组进行诊断。官方工具循环便利方法拒绝请求 `n > 1`，其工具循环读取首项 | 可参考接口设计。直接换客户端无法解决在单次有副作用的工具循环里该选哪一项，且会重做仓库已有的工具执行集成。见 [OpenAI Node SDK 工具循环源码](https://github.com/openai/openai-node/blob/main/src/lib/AbstractChatCompletionRunner.ts) |
| LiteLLM / OpenRouter | LiteLLM 提供按模型和供应商查询兼容参数的能力。OpenRouter 可通过 `require_parameters` 选择支持请求参数的上游，也区分 HTTP 成功和响应体错误 | 可借鉴能力声明、路由和诊断。当前网关是否保留选项、是否正确处理 `n`，仍需对目标路由做协议验证。见 [LiteLLM 参数支持](https://docs.litellm.ai/docs/completion/input)、[OpenRouter 参数路由](https://openrouter.ai/docs/guides/routing/provider-selection)、[OpenRouter 错误契约](https://openrouter.ai/docs/api_reference/errors-and-debugging) |
| OpenAI Responses API | 单次生成通过类型化的输出项承载消息和工具调用，省去 Chat Completions 的 `n` 选择语义 | 若目标服务原生支持，并且工具往返及错误行为都经过验证，可用作后续独立接入方案。当前兼容端点保留 Chat Completions。见 [Responses API 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses) |
| Vitest 与 Pact | Vitest 可以用注入的 `fetch` 验证真实 SDK 解析和实际工具执行次数。Pact 适合可协调供应方运行验证的 HTTP 契约 | 现阶段用仓库已有 Vitest 即可。若网关也纳入自有 CI，再考虑把同一份协议夹具做成双方校验。见 [Pact 契约测试](https://docs.pact.io/) |

## 仓库已有设施

- **协议适配与校验**。模型工厂已有注入式 `fetch`，会处理非流式 HTTP 200 错误信封和本案的双选项。当前后备选择仅适用于自动工具选择，首项是普通文本，后续恰好一个选项包含工具，且工具名全部在当次请求中声明。现有 SDK 与 Zod 校验参数，沙盒校验实际操作权限和业务证据。见 [模型工厂](../../packages/workflow/src/domain/agent-model.ts)。
- **真正执行的证据**。两轮模型探针验证工具往返。获取循环已有 15 秒、最多一次的只读快照恢复，以及持久化的诊断与工具轨迹。获取租约和操作记录可验证单次副作用的幂等性。见 [模型探针](../../packages/workflow/src/domain/agent-model-probe.ts)、[循环](../../packages/workflow/src/acquisition-v2/agent-loop.ts)、[诊断](../../packages/workflow/src/domain/agent-model-diagnostics.ts)、[工具轨迹](../../packages/workflow/src/acquisition-v2/agent-trace-sink.ts)、[获取操作记录](../../packages/workflow/src/persistence/acquisition-operations.ts)。
- **现有验证入口**。协议用例调用真实 SDK 和注入的 `fetch`，完整链路可通过模拟存储与工作流仓库验证。CI 已运行 Vitest 和 `gate:blame-free`。后者主要检查报告分类接线、审计字段和展示分流，本案的执行次数应由行为测试断言。见 [协议用例](../../packages/workflow/tests/domain/agent-model.test.ts)、[完整链路用例](../../packages/workflow/tests/acquisition-v2/v2-full-chain.test.ts)、[CI](../../.github/workflows/ci.yml)。

## 解决方案与实施顺序

1. **保留已经验证的单选项策略。** 继续只在适配层处理本案形态。首项已有工具、后续多个工具备选、候选含未声明工具、显式禁用工具、强制工具、内容过滤、长度限制和 SSE 按各自协议处理。选中项整体进入 SDK，保留其参数、调用 ID 和结束原因。其他项不进入会话历史或工具执行。
2. **补足选择审计。** 在改写响应前记录收到的选项数、各项的工具调用数、选中的数组位置和索引、判定原因以及受限的请求关联信息。区分「后续选项被采用」「存在多个备选」「候选不合格」与「网关没有返回工具」。复用现有审计通道，默认只保留枚举、数值和脱敏关联值。
3. **分开验收协议与业务结算。** 协议验收以工具调用准确进入 SDK 并到达模拟执行器为准。业务结算以成功的终结动作和搜索证据为准。之前一轮 PanSou 连续返回 401、没有可用快照，`reportNoCoverage` 被拒，却仍显示「暂无资源」。当前多步 `model_error` 会被早期模型故障分类跳过，且零搜索证据的沙盒分支先抛错。应补结构化搜索失败事实并传到结算层，覆盖这个误报。见 [故障分类](../../packages/workflow/src/acquisition-v2/agent-fault.ts)、[沙盒证据检查](../../packages/workflow/src/acquisition-v2/sandbox.ts)、[通知桥接](../../packages/workflow/src/acquisition-v2/workflow-v2-bridge.ts)。
4. **按目标路由做开发验收。** 使用真实开发模型、隔离 SQLite 和模拟网盘，保存请求摘要、原始响应选项形态、实际工具轨迹、转存计数及最终业务状态。CI 跑确定性夹具即可。供应商切换、版本升级或网关配置变更时，再按目标路由重复现场探针。

## 同类门禁与回归用例

门禁以可观察行为为准。**每个模型响应最多选中一个备选，执行轨迹只能来自该项。模型传输成功和工具执行成功，都要经过业务终结证据校验才能发布成功或暂无资源结论。**

| 层级 | 必测用例 | 断言 |
| --- | --- | --- |
| 协议选择 | 首项文本、后项两个工具。首项已有工具。多个后项各带工具。所有项均无工具 | 唯一可选情况执行两个对应调用。首项已有工具时沿用首项。多个备选保持原处理。所有情况均无跨项合并 |
| 工具边界 | 未声明工具、参数不符、禁用工具、强制指定工具。两个 `choice` 复用同一个测试调用 ID | 未声明或无效参数对应的工具执行计数为 0。强制选择和禁用策略保持原有约束。相同测试 ID 不会跨选项重复触发执行 |
| 传输隔离 | HTTP 200 嵌入错误、内容过滤、长度限制、SSE 多条增量 | 仍按各自错误或流式路径处理。不会把 HTTP 200 内的错误或流式片段当成可执行的非流式备选 |
| 完整工作流 | 适配后成功调用工具并完成真实无覆盖。所有搜索 401 且无快照。模型中途停止。合法替换任务按自己的终结动作收尾 | 真实耗尽可产生「暂无资源」。只有搜索故障证据时报告搜索故障或评估未完成。模型中途停止保留诊断。正常替换保持业务语义 |
| 副作用和脱敏 | 模拟转存响应丢失、恢复请求超时、报文含假密钥与链接 | 同一操作最多一次生效。只读恢复不执行转存。诊断中无原始文本、参数、凭据或下载链接 |

建议把协议和业务用例纳入现有 Vitest CI。用当前的报告门禁检查结构化故障字段是否接到通知。若新增门禁有独立名称，也应直接运行对应行为用例，避免只检查源码中是否出现某个字段名。

## 调研阶段验证

重新校验了保存的请求、响应及元数据哈希，确认表中的字段形态。运行模型适配、探针、获取循环、通知接线、完整链路和报告门禁测试，共 6 个文件、89 项通过。`npm run gate:blame-free` 通过。

## 2026-11-20 实施记录

- **选项选择审计。** 非流式多选项响应在进入 SDK 前记录 `agent_choice_selection`，包含 `choiceCount`、各项工具数量（最多记录前 32 项）、`selectedPosition`、合法的 `selectedIndex`、判定原因和符合格式的请求 ID。原因包含 `primary`、`selected_later`、`ambiguous`、`no_tool_alternative`、`ineligible_alternative`。正常巡检和一次只读恢复均可把这些字段随工作流落库，审计数据只含计数、位置、枚举和请求关联信息。见 [适配器](../../packages/workflow/src/domain/agent-model.ts) 和 [巡检循环](../../packages/workflow/src/acquisition-v2/agent-loop.ts)。
- **工具执行边界。** 首项已有工具时沿用首项。仅当首项是文本、唯一后续带工具项符合现有资格校验且项内调用 ID 唯一时，才整体采用该项。跨项相同 ID 时只执行选中项，歧义时拒绝提升。SDK 继续验证入参，沙盒继续约束执行。本次新增的项内 ID 校验作用于后备选项。
- **PanSou 故障结算。** 搜索适配层在源抛错且未形成快照时记录 `search_source_failed`，PanSou 认证错误只保留源名和 `auth_error` 分类。全轮缺少可用快照时，既有分类器把此证据传给用户通知，报告为「PanSou 搜索认证失败」。已有健康或降级的可用快照时，沿用该快照的证据规则。内部工作流的 `no_coverage` 仍表示集数未覆盖，认证故障的通知类型为 `transfer_failed`，报告状态为 `failed`。见 [搜索适配器](../../packages/workflow/src/acquisition-v2/real-provider-adapter.ts) 和 [搜索源分类](../../packages/workflow/src/acquisition-v2/search-source-fault.ts)。
- **CI 行为门禁。** 用真实 SDK 和工具函数断言跨项同 ID 只执行一次、多后备歧义及候选项内重 ID 的工具不会执行。完整链路使用 PanSou 适配器注入 401，核对无快照、无成功的无覆盖声明、落库认证故障与失败通知。另用健康空快照及故障后恢复的快照验证真实零候选仍可正常结算。复用 [CI 已有的 Vitest 与报告门禁](../../.github/workflows/ci.yml)。见 [模型适配测试](../../packages/workflow/tests/domain/agent-model.test.ts)、[工具循环测试](../../packages/workflow/tests/acquisition-v2/v2-agent-loop-run.test.ts)、[完整链路测试](../../packages/workflow/tests/acquisition-v2/v2-full-chain.test.ts) 和 [搜索源分类测试](../../packages/workflow/tests/acquisition-v2/search-source-fault.test.ts)。

本地相关测试共 138 个文件、1,669 项通过。类型检查、改动源码的 ESLint 检查、`gate:blame-free` 和 `gate:deps` 均通过。

## 《桃源暗鬼》第 2 季开发复测

2026-11-20 09:57:24 至 09:59:24（香港时间），开发版本 `dev-20261120095504-dirty-095504`。读取开发实例保存的真实 AI 和 PanSou 配置，以该订阅的元数据在独立 SQLite 中运行一次巡检，使用模拟网盘。运行号前缀为 `0a021492`。

直接读取本轮 SQLite 中的 `agent_choice_selection`，三次多选项响应均选择数组位置 1、`index=1`，原因为 `selected_later`。请求关联值仅保留 SHA-256 前 12 位。

| 观察顺序 | 选项数量 | 每项的工具调用数 | 选中的位置 / index | 请求指纹 |
| --- | --- | --- | --- | --- |
| 1 | 2 | `[0, 2]` | `1 / 1` | `a3cb9f1d0721` |
| 2 | 2 | `[0, 1]` | `1 / 1` | `15e0cdf9e9d1` |
| 3 | 2 | `[0, 1]` | `1 / 1` | `b588bc5e08f7` |

工具轨迹前两条均为成功的 `readSkill`。全轮 12 个模型步骤，10 次 `searchResources` 均成功，其中 1 次命中搜索去重，落库 9 个健康快照，每个都是零候选。沙盒接受 `reportNoCoverage`，循环以 `candidate_exhausted` 退出，通知及报告均为 `no_coverage`。本轮有 1 次 `readMemory` 工具失败，之后继续完成巡检。转存尝试为 0。

这次真实开发巡检验证了多选项选择、审计落库和健康零候选的结算。PanSou 全部返回认证失败的路径由本地完整链路的 401 夹具验证，结果为「PanSou 搜索认证失败」。多选项发生在上游响应还是网关转发阶段，仍需同一请求的上游原始报文确认。

### `readMemory` 失败复核

只读查询同一次开发复测（运行号前缀 `0a021492`）的隔离 SQLite。第 12 条工具轨迹（`ordinal=11`）记录 `readMemory` 状态为 `failed`，错误码为 `MEMORY_NOT_FOUND`，请求范围为 `title`。复测脚本用订阅元数据初始化独立数据库，未复制记忆条目，事后查询的 `agent_memories` 行数为 0。模型请求读取一个该作品下不存在的记忆名称。沙盒按账号、范围和绑定作品查询后精确匹配名称，未命中时返回该错误。可由错误码确认读到了查找分支，网关、PanSou 鉴权和记忆绑定均与该错误无关。记录仅保留范围和错误码。见 [沙盒读记忆实现](../../packages/workflow/src/acquisition-v2/sandbox.ts#L2056)。

这次未命中只影响一次可选的历史记忆读取。其后仍有 4 次成功的 `searchResources`，最终 `reportNoCoverage` 成功，停止原因为 `candidate_exhausted`，通知仍为 `no_coverage`，转存数为 0。结合 9 个健康的零候选快照，本轮结论来自实时搜索证据。

**处理决定。** 本案无需修复。当前沙盒对未知名称的拒绝符合预期。只有在常规巡检里反复出现空记忆读取并消耗步骤预算，才值得评估在空索引时省略主循环的 `readMemory`，或者约束模型仅读取上下文中已列出的条目。届时应覆盖空记忆下继续搜索、有记忆时仍可读取、以及查找未命中后仍可完成结算。
