# 巡检反复提示「AI 异常」的排查与回归方案

调查日期：2026-11-19（香港时间）。范围：订阅初次获取、手动巡检和通知。前次调查记录了同类运行被归为「暂无资源」的现象，本次核查新提示背后的实际运行、模型调用与恢复路径。参见[前次调查](2026-11-18-no-coverage-model-error-blame-free-reporting-research.md)和[本次提示上线说明](../release-notes/v2026.11.19.md)。

## 生产证据

只读关联生产 SQLite 的 `notifications`、`workflow_runs`、`resource_snapshots`、`agent_steps` 与 `transfer_attempts`。以下为 11 月 19 日 19:55–20:01 这一窗口的持久化通知，时间已转换为香港时间。

| 时间 | 运行 | 条件与结果 |
| --- | --- | --- |
| 19:59:42 | 咒术回战，手动巡检 | 搜索源健康，82 条原始命中，77 条准入并留有快照。模型在第 1 个 SDK step 结束，工具执行和转存均为 0 |
| 19:58:45 | 转生重骑士，初次获取 | 搜索源健康，预检索 0 条。第 1 个 SDK step 结束，工具执行和转存均为 0 |
| 19:58:07 | 葬送的芙莉莲，初次获取 | 运行成功，报告已齐；该轮没有模型停止事件、候选快照或工具执行记录，所以这条绿卡无法证明模型恢复 |
| 19:57:52 | 桃源暗鬼，初次获取 | 搜索源健康，预检索 0 条。第 1 个 SDK step 结束，工具执行和转存均为 0 |
| 19:57:03 | 转生重骑士，初次获取 | 搜索源健康，预检索 0 条。第 1 个 SDK step 结束，工具执行和转存均为 0 |

四次失败来自同一账号，均使用 `vercel-ai` 路径和进程内 Worker。查询时该账号三项 AI 设置齐全，生效配置由账号数据库设置提供，配置与出厂免费预设不同。四轮均持久化 `model_error / steps=1`，运行状态仍是 `no_coverage`，通知类型为 `agent_error`，报告状态为 `failed`。零候选三轮均有健康的搜索过滤事件和空快照。新版本让旧故障变得可见，也把零候选误写成了「没有真正检索」。

**确认的直接原因是模型循环在没有工具执行、没有业务终结动作时提前结束。** 现场 `loop_stopped` 只保存 `stopReason` 和 `steps`。容器的 `MEDIA_TRACK_AGENT_LOG` 未开启，对应时段日志没有模型结束行或可匹配的上游错误特征。记录无法区分纯文本停机、空输出、错误式 `finish_reason` 或其他提前结束形态，也无法追溯具体上游错误码。四轮耗时 33–183 秒包含搜索和其他工作，无法用于判定模型超时。上一轮复盘的 77 条案例属于另一条历史运行，本次 77 条来自当前查询。

## 程序为什么无法区分

1. **一个 SDK step 只代表一次模型生成。** 获取使用非流式 `generateText` 到 OpenAI 兼容 Chat Completions。模型返回纯文本、空文本或未带有效工具的正常 `stop` 时，SDK 仍可解析出一步，循环没有可继续执行的工具。业务停止推导把无成功终结、无其他结束证据的结果归为 `model_error`。这也解释了为什么单看 steps 无法证明上游报错。见[获取循环](../../packages/workflow/src/acquisition-v2/agent-loop.ts)、[停止原因](../../packages/workflow/src/acquisition-v2/agent-stop-reason.ts)。
2. **恢复只覆盖部分异常形态。** 模型工厂能识别无 `choices` 的顶层 JSON 错误信封，还原状态码，SDK 随即可在模型调用级重试。只要 `choices` 是数组，该信封分支就跳过。现有获取循环对抛出的网关故障及特定内容审查执行恢复，返回一个可解析结果但无业务进展时，会绕过异常重试和 Worker 的抛错重排链。编排层在落审计时只保留推导标签和步数。见[模型工厂](../../packages/workflow/src/domain/agent-model.ts)、[编排审计](../../packages/workflow/src/acquisition-v2/orchestrator.ts)、[队列失败处理](../../packages/workflow/src/execution/workflow-failure-handler.ts)。
3. **设备连通性与任务能力分离。** 设置页按账号解析模型，调用 `generateText({ model, prompt: "ping" })` 后直接报「连接正常」。该调用没有本地探针工具，也没有验证结束原因和输出。它无法证明模型支持工具，更无法证明第二轮能消费工具返回值。通知分类则只用 `steps <= 1` 加过滤事件的准入计数，无法区分未检索、健康零命中、全被规则排除或检索源异常。见[设置测试入口](../../apps/web/app/actions/settings-system-actions.ts)、[通知分类](../../packages/workflow/src/acquisition-v2/agent-fault.ts)、[状态与通知桥接](../../packages/workflow/src/acquisition-v2/workflow-v2-bridge.ts)。

### 本地协议对照

使用锁定版本 `ai@6.0.201`、`@ai-sdk/openai-compatible@2.0.48`，通过注入 `fetch` 返回合成响应。部分用例经过生产使用的 `createAgentModel`，全程无真实模型请求。

| 合成响应 | 实际表现（关闭重试以观察首个结果） |
| --- | --- |
| 普通文字或空文本，原始 `stop` | 都解析为 1 步，工具调用为 0 |
| HTTP 200，顶层 `error.code=503`，同时有 choice，原始 `finish_reason=error` | 经过项目工厂仍解析为 1 步、空文本，SDK 统一原因是 `other`，原始原因是 `error` |
| HTTP 200，只有顶层 `error.code=503` | 原始适配器报 HTTP 200、不可重试。经项目工厂后报 HTTP 503、可重试 |
| HTTP 503 | 经项目工厂报 HTTP 503、可重试 |
| HTTP 200，`choices: []` | 项目工厂路径抛出 `TypeError` |
| 合法的探针调用 / `content_filter` | 分别解析为一次工具调用 / 明确的 `content-filter` |

这些用例证明多种响应能产生当前分类的前置条件。生产历史响应已不可从现有审计恢复，合成用例不能用于指认其中某一种。

## 可复用的设施与业界方案

| 方案 | 可用能力与适用范围 | 本项目决定 |
| --- | --- | --- |
| Vercel AI SDK + OpenAI Compatible（已安装） | 提供模型调用、SDK 步结果、原始停止原因、模型级重试和 `ai/test`。可注入 `fetch` 验证协议，可用 `MockLanguageModelV3` 驱动真实获取循环 | 首选复用。保留现有 SDK，补齐应用侧判断和审计。以仓库锁定版本的 API 为准。[生成 API](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) · [测试工具](https://ai-sdk.dev/docs/ai-sdk-core/testing) |
| OpenAI 与 OpenRouter 的错误契约 | 对认证、限流和服务端错误提供分类。OpenRouter 也说明响应头已发出时，HTTP 200 内仍可能携带错误，非流式和 SSE 有各自信封 | 借鉴错误归一化与请求关联。当前获取走非流式，使用兼容端点的合成夹具覆盖实际响应形态。[OpenAI 错误码](https://developers.openai.com/api/docs/guides/error-codes) · [工具调用](https://developers.openai.com/api/docs/guides/function-calling) · [OpenRouter 错误处理](https://openrouter.ai/docs/api_reference/errors-and-debugging) |
| LiteLLM Proxy 与 Vercel AI Gateway | 都可做供应商或模型路由和故障切换。自托管 LiteLLM 增加代理运维，托管 AI Gateway 增加账号和服务依赖 | 多上游成为明确需求后再选。网关能减少部分供应商故障，业务终结和防止重复转存仍由应用负责。[LiteLLM 故障切换](https://docs.litellm.ai/docs/proxy/reliability) · [Vercel AI Gateway 路由](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) |
| OpenTelemetry GenAI 约定 | 可参考模型、停止原因、`error.type` 等观测字段。依赖树已有间接引入的 `@opentelemetry/api`，本次在应用与包源码未找到已接线的 GenAI 遥测 | 先复用运行审计与结构化日志。有集中观测需求时再接导出端，默认关闭提示词、回应内容和凭据采集。[GenAI 约定](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) |

此外已具备 Zod、Vitest、工具轨迹和脱敏、候选快照、确定性选择器、暂存恢复、SQLite 获取租约和操作记录，以及重排退避（最多 3 次，1/5/15 分钟）。现有静态报告门禁可继续执行。第一阶段无需新增运行时依赖。[工具轨迹](../../packages/workflow/src/acquisition-v2/agent-trace-sink.ts) · [规则选择器](../../packages/workflow/src/acquisition-v2/deterministic-selector.ts) · [获取租约与操作记录](../../packages/workflow/src/persistence/acquisition-operations.ts) · [重排策略](../../packages/workflow/src/persistence/repository.ts) · [现有报告门禁](../../tools/gates/check-blame-free-reporting.mjs)。

## 修复方案

1. **先让下一次故障可诊断。** 在模型适配层统一处理两类返回：抛出的 SDK/传输错误，以及解析完成却无有效终结动作的结果。复用 SDK 类型守卫和仓库状态码提取，保留原始与归一化停止原因。允许列表化存储类别 `auth`、`model_not_found`、`rate_limit`、`upstream_unavailable`、`timeout`、`content_filtered`、`protocol_error`、`tool_call_invalid`、`no_terminal_action` 或 `unknown`，并记录步骤与有效工具数、HTTP 状态、耗时、重试决策、配置来源及安全的上游请求 ID（若有）。同时把抛错与返回失败写入同一个运行审计渠道，按运行 ID 查阅。用字段白名单和长度约束，禁止记录原始头、请求体、响应体、账户密钥、候选链接和带敏感查询参数的 URL。对未知类型保留未知，避免凭文案推断状态。
2. **把设置页升级为工具能力检测。** 通过现有账号配置读取和模型工厂发合成请求，先验证模型能按 Zod schema 调用一个只返回固定标记的本地工具，再验证第二轮能消费工具结果并给出协议约定的完成标记。使用设置页操作自己的明确总时限，例如 20 秒，禁用额外重试。区分连接失败、普通对话可用但工具调用失败、工具往返成功。实际获取的首轮可评估将只读 `readSkill` 设置为必选工具。只有兼容性验证通过的模型采用强制工具选项，后续继续按沙盒规则动态开放工具。
3. **按证据接入有界恢复。** 请求级暂时性故障复用 SDK 重试与 `Retry-After`，加整轮时限。未执行写工具的空返回或无效工具结果，最多用一次限定为只读首工具的恢复；明确无效凭据、模型不存在、额度耗尽或工具不支持时提示改配置。任何转存、移动或删除一旦发起，都依据已持久化操作、暂存和目标目录对账后恢复；结果不明的写操作保留现场并进入检查，不直接启动新一轮完整工具集。已有完整覆盖或确认的替换终结以业务证据收尾。若要扩大规则降级使用范围，先要求候选身份、季集、订阅策略与目标确认通过，再启用已有选择器。当前选择器在整理完成后返回 `success: true`，调用方仍需用 `coverageMet` 和实际获取证据验证承诺结果。
4. **让通知反映已知事实。** 将搜索证据和模型原因作为独立字段。健康零命中可显示「预检索未命中，AI 未完成补充检索」，有快照则显示候选数和手动入口，只有确实没有搜索事件才描述「未执行检索」。搜索故障、规则过滤、转存失败、真实候选耗尽继续从各自证据判定。用终结工具成功和实际效果替代单纯步数阈值，覆盖多步骤异常及正常替换。第一轮兼容读取旧的 `loop_stopped` 事件。待核对活动、报表、调度对 `workflow_runs.status` 的消费后，再决定是否同步改为 `failed`，避免提前改变调度语义。

现场处置以同一账号、同一 Worker 的模型配置为准。先在开发环境或经授权的账号上验证无网盘工具的两轮诊断，再用已知有候选的作品跑一轮隔离验证。若确认兼容端点拒绝工具或一直返回空结果，可在设置中换用已通过工具往返的模型。截图中的 77 条快照可作为手动查看入口。重新跑历史任务前检查是否已有暂存或部分完成。

## 验收门禁与回归测试

沿用 Vitest 和 SQLite 测试设施。将协议和行为测试接到现有 CI 的 `npx vitest run`。现有 `gate:blame-free` 在本地 `npm run gate` 中登记，CI 当前显式运行的静态门禁不含该命令。建议单独接入该命令，用行为测试覆盖静态检查无法证明的分支。见 [CI](../../.github/workflows/ci.yml)。

| 测试层 | 必须通过的用例和断言 |
| --- | --- |
| 协议契约，扩展 `agent-model.test.ts` | 合成 HTTP 200 错误信封（无 choices、空 choices、带 error choice）、普通空 `stop`、非法工具参数、429 限流与额度耗尽、503、网络超时。断言原始停止原因或结构化错误得到保留，区分请求是否可重试，达到总时限后停止。合法文本和工具响应保持可用 |
| 获取循环，扩展 `v2-agent-resilience.test.ts` | 返回空或文本且没有工具时，只读恢复最多 1 次。首轮工具成功、次轮失败也保留实际故障。正常 `finish`、明确的 `reportNoCoverage`、`reportReplacement`、用户取消和机械预算用例各保持原有语义 |
| 写操作幂等，贯通 Worker / SQLite / 模拟网盘 | 分别在转存前、已发出但响应丢失、暂存已落盘、移动后注入模型故障。覆盖重试、重启和并行 claim，断言同一操作最多一次生效、既有文件保留、未确认写入先对账、现有进展不丢失。真实覆盖仍需目标证据 |
| 失败证据到展示，扩展 `agent-error-notification-wiring.test.ts` | 77 条快照仍可见，健康零候选显示已预检索，未检索才显示未执行；真实耗尽仍为暂无资源。AI 异常不进入「暂无资源」计数。用假密钥、带查询参数的 URL 和伪造错误体断言日志和用户响应均完成脱敏 |
| 设置与运维探针 | 纯 `ping` 返回文本但工具无法调用、工具第一轮成功但第二轮失败、完整成功三组对照。探针不执行网盘操作，具备超时。真实服务探针可在隔离环境按需运行，CI 只使用合成响应 |

合并验收的核心断言是：**没有足够证据的失败不得进入资源耗尽分支，失败原因必须可追溯，模型故障后的恢复不得重复产生写入。** 第一批用现有入口构造「200 + error + choice」和「健康空快照 + 模型提前停止」两条回归，在补丁前验证缺陷可触发，补丁后核对状态、审计、通知及副作用。

## 本次实际验证

- 生产只读查询核对了上述五条通知、搜索快照、工具执行和转存计数，并检查了同一时段的容器日志。未执行生产模型探针或触发新获取运行。
- 本地复现了表中的协议返回形态。六个现有测试文件共 108 项通过，覆盖模型适配、循环韧性、停止原因、通知分类与队列失败处理。`npm run gate:blame-free` 通过。
- 文档中新增门禁、探针及业务修复均为实施方案。现场最早一层缺失的信息是该轮模型的实际结束原因和上游请求关联信息。

## 2026-11-19 开发环境真实模型复测

开发构建 `f3ee57fc-dirty-204615`，以下时间为香港时间。探针和订阅复测均使用开发实例账号当前从数据库生效的 AI 配置、应用的 OpenAI 兼容模型工厂和开发实例的出站代理。

| 验证 | 实测证据 |
| --- | --- |
| 20:54:52，两轮工具检测 | 9.1 秒通过。第一轮 HTTP 200、`finish_reason=tool_calls`，返回一个有效诊断工具调用。第二轮 HTTP 200、`finish_reason=stop`，正确读回工具结果 |
| 20:56:55–20:57:10，《桃源暗鬼》第 2 季 | 手动巡检重现 `agent_error`，复测运行 ID `d5e6453c-a59d-44d3-94d8-ceb0796dc9cd`。PanSou 预检索健康，原始命中及准入均为 0，空快照已保存。报告为 `failed`，缺集 E01–E07，通知显示「预检索未命中，AI 未完成补充检索与评估。」 |
| 巡检首轮模型响应 | HTTP 200，响应包含文本，工具调用为 0，未见顶层错误信封。落库的 `agent_model_diagnostic` 为 `phase=returned`、`category=no_terminal_action`、`finishReason=other`、`textProduced=true`、`steps=1`、`toolCalls=0`、`toolResults=0`、`elapsedMs=7434`、`configSource=db`。该条无原始停止原因和请求 ID |

**本次复测的提示由获取任务首轮只有文本、没有有效工具调用或业务终结动作触发。** SDK 将这次缺少可用原始停止原因的回复归为 `other`。获取循环没有可执行的后续步骤，业务层记录 `loop_stopped / model_error`。同一配置能通过短探针，说明它具备基础工具往返能力。预检索零命中之后，该次获取任务仍需要模型调用工具完成补充检索或给出有证据的终结。具体是模型还是网关令这一轮省略了工具调用和原始停止原因，现有证据无法继续定位。见 [SDK 适配器调用入口](../../packages/workflow/src/domain/agent-model.ts)和[业务停止推导](../../packages/workflow/src/acquisition-v2/agent-stop-reason.ts)。

开发库中的这条订阅已完结。复测在独立 SQLite 恢复历史缺集 E01–E07，通过现有手动订阅搜索队列和 Worker 执行，接入真实模型、开发 PanSou 和模拟网盘。复查独立库中的运行、通知和空快照，确认转存尝试为 0，开发业务库中没有该复测运行，原订阅仍为已完结。历史截图中的《桃源暗鬼》运行是初次获取，本次为手动巡检，两者共用获取模型循环。历史记录未保存上游原始响应，因此本次结果证明同类提示可由无工具的文本回复触发，历史运行的具体模型响应仍无法回溯。

后续回归应增加本次响应形态的固定夹具，使用 HTTP 200、非空文本、缺失或空 `finish_reason`、无 `tool_calls`，断言生成可追溯的 `no_terminal_action` 诊断，健康空快照仍可读取，且转存次数为 0。后续实现恢复策略时，可复用已有沙盒，先验证一次有时限的只读首工具调用，避免把本次测得的任务行为误归为模型连接失败。

## 只读恢复上线后的开发复测

获取循环首轮返回且没有工具调用或终结动作时，新增一次独立恢复请求。该请求只开放 `viewResourceSnapshot`，强制选择该工具，共用 15 秒截止时间，模型重试次数为 0。它读取已经缓存的搜索快照，之后按原获取循环的业务证据结算。恢复结果单独写入 `agent_read_only_recovery`。见[获取循环实现](../../packages/workflow/src/acquisition-v2/agent-loop.ts)。

2026-11-19 21:05:07–21:05:31（香港时间），使用开发构建 `dev-20261119210150-dirty-210150` 和账号当前生效的真实 AI 配置，再次通过现有手动巡检队列复测《桃源暗鬼》第 2 季。运行 ID 为 `0276ca3a-0cb4-4f4f-9737-942668124840`。

| 阶段 | 实测及落库证据 |
| --- | --- |
| 预检索 | 开发 PanSou 健康，原始命中和准入均为 0 |
| 首轮模型 | HTTP 200，输出文本，零工具调用，未见顶层错误信封。诊断为 `no_terminal_action`，SDK 停止原因为 `other`，耗时 7.3 秒 |
| 只读恢复 | 仅一次恢复请求，HTTP 200，返回一个 `viewResourceSnapshot` 工具调用。该工具执行成功，审计为 `snapshot_observed`，耗时 4.96 秒。重新打开 SQLite 核对，恢复事件和成功的工具轨迹各一条 |
| 任务结算 | 转存尝试 0 次，E01–E07 仍缺失。通知保留 `agent_error`，文案为「预检索未命中，AI 未完成补充检索与评估。」 |

本次复测同时确认了异常的可重复性和恢复边界。模型首轮仍只回文本，受限请求成功读取了已有快照。快照为空且本轮未完成获取，所以报告仍保留未完成状态。复测使用独立 SQLite 和模拟网盘，开发业务库中的原订阅保持已完结。

自动回归覆盖 HTTP 200 仅文本、恢复成功、恢复请求返回转存指令、恢复超时，以及已有工具执行后的提前终止。相关 1,656 项测试与 `gate:blame-free` 通过。见[获取循环回归测试](../../packages/workflow/tests/acquisition-v2/v2-agent-loop-run.test.ts)。

## 网关原始响应与 SDK 解析对照

2026-11-19 21:09–21:11（香港时间），在同一开发构建中复测《桃源暗鬼》第 2 季，继续使用独立 SQLite、真实开发模型配置和模拟网盘。首轮实际发出的两份请求正文均为 24,960 字节，SHA-256 均为 `48ef8be7a6f40736f244707302cf462fe6d37294145687ee7423ba6573a52328`。请求保留系统和用户消息，明确发送 14 个工具定义，包括 `viewResourceSnapshot` 与 `searchResources`，使用 `tool_choice: "auto"`，未设置 `n`，走非流式 Chat Completions。记录保留摘要和字段形态，请求正文、文本、工具参数、配置地址和凭据未写入文档。

两次首轮调用均返回 HTTP 200 和两个 `choices`。第二次复测运行 `14b9516a-3dc2-4f31-ab31-de4950a5fe8e` 在 SDK 解析前核对了完整数组。网关请求关联头存在，脱敏指纹为 `bda15e1022c3`。

| 原始响应中的位置 | 文本内容 | `finish_reason` | `message.tool_calls` |
| --- | --- | --- | --- |
| `choices[0]`，`index=0` | 有 | 字段缺失 | 字段缺失 |
| `choices[1]`，`index=1` | 空 | `tool_calls` | 2 个调用 |

**实际阻断点位于巡影使用的 OpenAI 兼容 SDK 适配层。** 这次网关已把工具调用送到应用端，但当前 `@ai-sdk/openai-compatible@2.0.48` 的非流式实现固定读取 `responseBody.choices[0]`，只解析这一项的文本、工具和停止原因。它把首项的缺失停止原因归为 `other`，后项的两个工具调用未进入获取循环。对应运行落库为 `no_terminal_action`，工具调用数为 0，并触发既有只读恢复。隔离运行转存次数为 0。本地依赖的证据位于 `@ai-sdk/openai-compatible/src/chat/openai-compatible-chat-language-model.ts` 的第 302、322 和 364 行。见[仓库模型工厂](../../packages/workflow/src/domain/agent-model.ts)。

本地使用同一版 SDK 和合成响应，只交换两个数组元素的位置，复现了相同结果。文本在数组首位时，SDK 返回 `other`，工具调用及执行均为 0。工具项放到数组首位时，SDK 返回 `tool-calls`，两个模拟只读工具均执行。该对照确认决定结果的是数组位置。

提供用于直连对照的地址和模型 ID 经运行时核对，与当前网关的生效地址和模型别名相同。此处只取得网关下游响应。上游直连或网关转发前的响应仍可用于追溯两个 `choices` 的来源。对于本次为什么没有执行工具，网关下游报文和 SDK 对照已足够定位。历史通知缺少原始响应，仍无法确认过去每一条是否同因。

下一轮修复可先用同一请求验证网关是否遵守显式 `n: 1`。如仍需兼容多项响应，应在协议适配边界明确处理，保留现有工具名称、参数和操作校验，避免把不同 `choice` 的调用合并执行。新增回归需保留现场的数组顺序，并覆盖首项已有有效工具、后续项存在多个可选工具结果以及完全无工具三类对照。

## `n: 1` 对照与适配层修复进度

2026-11-19 21:16（香港时间），用同一份《桃源暗鬼》第 2 季巡检请求完成对照。加字段前的正文 SHA-256 与上一节一致。仅增加顶层 `n: 1` 后，实际发出的请求正文 SHA-256 为 `e715cd486087908f0ab5bc82717a8019d00316c71a128c5e3c83bb40abf1763b`。网关仍返回 HTTP 200 和两个选项。首项有文本，缺少停止原因和工具调用字段。第二项仍有两个工具调用，停止原因为 `tool_calls`。脱敏的网关关联头指纹为 `2717a5f1661a`。这次明确请求单选项仍无法避免该响应形态。

适配层已实现单选项处理。对非流式、`tool_choice: "auto"` 的请求，首项仅有文本且后续恰好有一项提供本次请求声明的工具时，将该项完整交给 SDK。工具参数和执行仍由 SDK 与沙盒校验。首项已有工具、多项工具备选以及内容过滤等情况按原路径处理。请求侧保持原有参数。

相关 1,662 项测试、工作流构建、全仓类型检查、变更源文件 lint 和 `gate:blame-free` 已通过。开发构建 `f3ee57fc-dirty-212644` 已启动，直接查询 `/api/health` 返回 `{"status":"ok"}`。

## 适配层上线后的开发实机隔离复测

2026-11-19 21:44:31–21:47:00（香港时间），在开发环境使用实际构建 `f3ee57fc-dirty-212644`、账号当前生效的真实 AI 配置与出站代理，通过手动订阅巡检队列在独立 SQLite 中复测《桃源暗鬼》第 2 季（`tmdb_tv_253811_s2`）。存储执行器注入 `FakeStorageExecutor` 避免写网盘，搜索侧接入真实开发 PanSou 源（5280 端口）。运行 ID 为 `4fa1037d-5383-4439-bf56-dfe4049246b1`。

### 1. 网关响应形态与适配层表现

在模型工厂接入自定义 `fetch` 采集首轮及后续各轮调用报文。

- **首轮请求**：正文为 25,709 字节，SHA-256 为 `9c4b99c0b4ced836c7d0849b7221d8158c6e8f0c04c5302ce4c093e0cf28905f`。明确声明 14 个工具定义，采用 `tool_choice: "auto"`。
- **首轮响应**：网关返回 HTTP 200，耗时 8.67 秒，脱敏关联头指纹为 `d2e0aea925c0`。**网关再次返回两个 `choices` 异常结构**：
  - `choices[0]`：含文本，`finish_reason` 缺失（null），无工具调用；
  - `choices[1]`：无文本，`finish_reason="tool_calls"`，包含 2 个工具调用（均为 `readSkill`）。
- **适配层执行**：`selectToolChoice` 成功识别非流式 `tool_choice: "auto"` 下首项纯文本、后项带声明工具的特征，将 `choices[1]` 提取为单一选项交回 SDK。SDK 成功解析并将两个 `readSkill` 工具调用送入获取循环，沙盒按安全策略顺利执行（`agent_steps` 记录前两步为 `readSkill` 且状态为 `succeeded`）。
- **多轮巡检中的复现与拦截**：
  在本次完整的 20 轮模型交互中，网关在第 9 轮（指纹 `a3e484746e14`，后项工具 `inspectStaging`, `searchResources`）、第 16 轮（指纹 `0754e61e586e`，后项工具 `reportNoCoverage`）和第 17 轮（指纹 `b291685ff426`，后项工具 `searchResources`）**共计 4 次触发相同的多 choices 形态**。适配层均准确提取合法工具项，未发生工具丢失或循环阻断。

### 2. 任务生命周期与落地证据

重新以只读方式打开隔离库 `/tmp/diagnostics.sqlite` 提取完整证据：

| 证据项 | 实测结果 | 结论说明 |
| --- | --- | --- |
| 运行状态 (`workflow_runs.status`) | `no_coverage` | 模型完成多轮检索与候选排查后，根据真实搜索无结果做出业务终结 |
| 诊断与停止事件 (`auditEvents`) | `agent_model_diagnostic`、`loop_stopped` | 无异常终止；模型正常推进至终结逻辑 |
| 工具轨迹 (`agent_steps`) | 27 次调用全部入库 | 覆盖 `readSkill` (5 次)、`viewResourceSnapshot` (4 次)、`searchResources` (9 次)、`inspectTargetDir` (4 次)、`inspectStaging` (2 次)、`reportNoCoverage` (1 次)、`finish` (1 次) 及随后的记忆沉淀 |
| 候选快照与转存 (`transfer_attempts`) | 快照为空，转存 0 次 | 模拟存储执行器无任何未授权写入 |
| 最终通知 (`notifications`) | `kind: "no_coverage"`, `report_status: "no_coverage"` | 正常落库「暂无资源」通知，未发生虚假「AI 异常」误报 |
| 业务库隔离验证 | `/app/data/mediary.db` 计数为 0 | 运行 ID 仅存在于 `/tmp/diagnostics.sqlite`，真实影视数据零污染 |

### 3. 验收结论

根据[交接文档](../operations/acquisition-agent-choice-replay-handoff.md)的验收矩阵，本次实机复测：
1. **重现了线上网关原始响应首项文本、第二项带工具的真实形态**；
2. **确认适配层成功提取选中项进入 SDK，且所有工具执行均严格受限于沙盒与权限边界**；
3. **获取循环恢复了自主搜索、读取快照与终结决策的闭环能力**，彻底消除了由此引发的虚假 `agent_error`。

实机隔离验收通过。参见[交接文档](../operations/acquisition-agent-choice-replay-handoff.md)。

## 2026-11-20 首项文本的思考标记复核

09:24:21–09:24:27（香港时间），在开发构建 `f3ee57fc-dirty-212644` 中使用真实 AI 配置重放《桃源暗鬼》第 2 季的首轮巡检。发包前核对正文为 24,960 字节，SHA-256 为 `48ef8be7a6f40736f244707302cf462fe6d37294145687ee7423ba6573a52328`，与此前的双选项对照逐字节一致。网关返回 HTTP 200，关联头的脱敏指纹为 `087e89b5bf5f`。本次在适配层改写之前检查首个响应，只记录字段状态、调用数量及标记命中布尔值。收到首轮原始响应即结束探针。

| 原始选项 | `message.content` | `message.reasoning_content` | `message.reasoning` | `finish_reason` | `message.tool_calls` |
| --- | --- | --- | --- | --- | --- |
| `choices[0]` | 非空字符串，检查的标记均未命中 | 字段缺失 | 字段缺失 | 字段缺失 | 字段缺失，0 个 |
| `choices[1]` | 字段缺失 | 字段缺失 | 字段缺失 | `tool_calls` | 非空数组，2 个 |

首项未命中 `<think>`、`<thinking>`、`<reasoning>`、`<analysis>` 的起止标签、转义形式、方括号形式或显式 analysis 通道哨兵。常见的中英文思考、推理或分析标题也未命中。此次样本只能判定为 **普通 `content` 中没有检测到明确思考标记的文本**。它是否承载了被网关挪入 `content` 的思考内容，无法从这些字段判定。

| 判断信号 | 可以确认的范围 |
| --- | --- |
| `reasoning_content` 或 `reasoning` 为非空字符串 | 该响应通过结构化字段明示了推理文本。分别记录两字段的缺失、`null`、空串和非空状态。本地 SDK 用 `reasoning_content ?? reasoning` 取值，只有前者为空值 `null` 或缺失才回落 |
| `content` 含已知思考标签或通道哨兵 | 可记录为文本中出现了显式思考标记。标签来源和含义仍取决于网关约定。自然语言或普通标题至多作为线索 |
| `finish_reason` 缺失或为 `null` | 网关未提供有效的结束原因。SDK 可能归一为 `other`，该状态无法用来识别思考文本 |
| `finish_reason=tool_calls` 且 `tool_calls` 非空 | 该选项携带工具调用。仍按请求中的工具声明、SDK 参数校验和沙盒权限决定能否执行。工具调用字段与文本是否包含思考分别判断 |

现有兼容逻辑继续按同一 `choice` 的工具字段选取可执行项。文本标记检测仅用于脱敏排查。SDK 字段映射可在锁定版本的 `@ai-sdk/openai-compatible/src/chat/openai-compatible-chat-language-model.ts` 第 311–317 行核对。

## 2026-11-20 按请求 ID 对照网关转发边界

09:28:04–09:28:11（香港时间），脚本通过开发实例当前配置的网关发送《桃源暗鬼》第 2 季首轮巡检请求。发包前验证 24,960 字节及 SHA-256 `48ef8be7a6f40736f244707302cf462fe6d37294145687ee7423ba6573a52328`，与前次请求一致。开发构建为 `f3ee57fc-dirty-212644`。网关返回 HTTP 200，`x-request-id` 为 `7368f410-…-83c2`，其 SHA-256 前 12 位为 `da48109294d5`。此次只采集第一条推理响应的字段摘要，隔离工作流未调用工具。

| 观测位置 | 本次取得的证据 |
| --- | --- |
| 巡影发给网关 | 单次非流式调用，14 个工具定义，`tool_choice: "auto"` |
| 网关发给巡影、适配层尚未解析 | 两项。首项只有 `content`，缺少 `reasoning_content`、`reasoning`、`finish_reason` 及 `tool_calls`。第二项为 `finish_reason: "tool_calls"`，带两个工具调用 |
| 网关收到的上游原始响应 | 尚未取得。开发环境现有配置没有日志或追踪入口。网关返回的头中，未发现检查范围内的上游请求 ID 或追踪头 |

**脚本证实两项已经存在于网关发给巡影的响应。** 相同请求的历史对照加 `n: 1` 后仍返回两项。现有证据无法确定两项在上游就已存在，还是网关在转发时生成。工作区和开发容器可以发推理请求，网关侧的转发记录仍需通过其日志入口获取。

有日志权限后，按完整 `x-request-id` 查询该次网关事务。对照网关实际发出的上游请求、对应的各次原始上游响应和最终下游响应，分别记录是否流式、选项索引、`content` 字段状态、`reasoning_content`、`reasoning`、`finish_reason` 和工具调用数量。若上游使用流式协议，按 `choice.index` 汇总同一选项的增量，避免把事件数量当作选项数量。

- 同一上游响应已包含两项，且分别对应下游的文本项与工具项，可确认两项来自上游。
- 同一上游响应只有一个逻辑选项，同时含文本及工具调用，而最终下游拆为两个索引，可确认拆分发生在网关。
- 若事务实际调用多次上游，需要逐个对照关联的响应，才能区分单响应拆分与多响应组装。
