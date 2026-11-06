# 115 订阅获取失败：写入范围门禁与 OAuth 执行链路调查

> 日期：2026-11-07
> 范围：解释通知中的 `MEDIA_TRACK_115_WRITE_SCOPE_REQUIRED`，盘点可复用设施，并提出修复和回归门禁。按本文方案已完成范围传递修复与通知优化，未部署。

## 结论

订阅规则本身不依赖 `MEDIA_TRACK_115_TEST_ROOT_CID`。保存订阅策略后，系统创建获取任务；任务执行到 115 网盘的写入阶段时，必须确定允许写入的目录范围。该错误是 115 写入保护在没有收到任何范围时主动拒绝执行。

本次现场检查发现：开发容器的全局测试根目录和全局写入白名单环境变量都为空；当前活动的 115 连接在数据库中已有根目录、电影、剧集、动漫分类目录配置（检查只确认字段存在，没有读取或输出 CID 值）。代码链路同时显示，worker 已把连接级目录集合传给品牌适配器，但 OAuth 双引擎执行器工厂虽然声明接收 `scopeCids`，构造底层执行器时没有将它传下去。若失败任务走 `dual_engine` / `open_only` 分支，这个接线缺口与通知中的错误完全吻合。

因此，首要根因是 OAuth 执行器适配器漏传连接级写入范围；不是订阅策略缺少测试目录，也不应通过把某个用户 CID 写进全局环境变量来掩盖。应保留“没有明确范围即拒绝写入”的安全门，并修复范围传递、增加队列前置校验和可操作的错误提示。

## 现场现象与证据

通知页面显示“无职转生……第 1 季获取失败”，错误正文为：

```text
MEDIA_TRACK_115_WRITE_SCOPE_REQUIRED: set MEDIA_TRACK_115_TEST_ROOT_CID for development or MEDIA_TRACK_115_WRITE_SCOPE_CIDS for explicit live writes
```

调查时进行的只读运行态检查得到：

- `mediary-dev` 中 `MEDIA_TRACK_115_TEST_ROOT_CID` 与 `MEDIA_TRACK_115_WRITE_SCOPE_CIDS` 均为空。
- 数据库当前活动的 115 连接已设置四类目录字段。未输出目录 ID、令牌、Cookie 或连接标识。
- 这些是检查时的运行态，不足以证明任务失败时数据库字段从未变化；但与下面的代码缺陷共同构成了强证据。

保护执行器仅接受显式测试根目录或显式写入白名单；两者都不存在时抛出 `MEDIA_TRACK_115_WRITE_SCOPE_REQUIRED`。该失败发生在实际网盘写入之前，拒绝行为本身正确。

## 调用链与根因

1. `apps/web/features/acquisition/application/worker-runner-service.ts` 读取本次任务绑定的网盘凭据与分类目录，并组装 `scopeCids`。
2. `packages/workflow/src/storage/storage-brands.ts` 按存储品牌和 OAuth 引擎模式创建执行器。Cookie-only 分支会把 `scopeCids` 注入执行器环境；OAuth 双引擎分支则把它作为参数传入统一执行器工厂。
3. `packages/workflow/src/storage/pan115-storage-factory.ts` 的选项类型包含 `scopeCids`，但创建底层 115 执行器时只传了 API 与环境，没有把这些目录范围配置成执行器可识别的 `MEDIA_TRACK_115_WRITE_SCOPE_CIDS`。
4. `packages/workflow/src/storage/storage-115-executor.ts` 读取环境中的测试根目录/写入白名单。为空时按 fail-closed 规则拒绝写入，错误随后由任务失败处理逻辑转成通用“获取失败”通知。

测试中，`packages/workflow/tests/storage/storage-executor-factory.test.ts` 已覆盖 Cookie-only 115 的范围传递和通用品牌适配；尚未覆盖 unified OAuth 工厂对连接级范围的传递。`packages/workflow/tests/storage/storage-115-executor.test.ts` 已覆盖缺少范围时拒绝写入，应保留这道门禁。

### 为什么看起来像“订阅存在依赖”

订阅计划负责周期性地产生任务，不负责授予网盘写入权限。通知把执行阶段的 115 目录范围错误呈现为订阅获取失败，使两者看起来有关联。正确关系应是：

```text
订阅计划 → 生成获取任务 → 选择已绑定网盘及其目录范围 → 安全校验 → 执行写入
```

目录范围属于已连接网盘的配置，不应要求用户为了启用订阅额外填写仅供开发/单网盘旧模式使用的测试环境变量。

## 现有设施与依赖复用

仓库已有足够设施，无需新增依赖：

| 能力 | 当前设施 | 调查结论 |
| --- | --- | --- |
| 每个连接的分类目录 | `connected_storages` 持久化根目录、电影、剧集、动漫 CID | 多网盘模式的范围事实来源；优先使用任务绑定连接的数据 |
| 115 写入限制 | `Storage115Executor` 的目录白名单校验 | 保留 fail-closed；修复上游配置传递，不绕开校验 |
| OAuth/Cookie 分支 | `storage-brands.ts` 与统一 Pan115 工厂 | 适配器已有边界，适合统一构造执行器配置 |
| 输入/配置校验 | 项目已有 Zod 4 | 可用于范围配置结构校验；这次接线修复不需要新库 |
| 生命周期与失败通知 | worker runner、workflow failure handler | 可做入队前预检与区分永久配置错误；配置错误不应盲目自动重试 |
| 运行配置检查 | Node instrumentation 的 `validateRuntimeConfig` | 适合校验部署级配置；每用户/每连接 CID 不应强制成为进程级必填项 |

`MEDIA_TRACK_115_TEST_ROOT_CID` / `MEDIA_TRACK_115_WRITE_SCOPE_CIDS` 在环境变量文档中保留为开发或早期单网盘 fallback。现代多连接模式应从数据库按连接取范围。部署脚本没有注入这两个值是合理的：为所有账户设置同一个全局写入 CID 会破坏隔离边界。

## 主流方案对比与可借鉴点

| 方案 | 配置归属和校验方式 | 可借鉴之处 | 本系统的适配 |
| --- | --- | --- | --- |
| Docker Compose 环境配置 | 部署参数由环境变量/Compose 配置注入，可使用必需变量语法在启动时失败 | 用于进程级、部署级配置；缺失应在启动时暴露 | 不适用于用户绑定的不同网盘目录 CID |
| 12-Factor Config | 部署环境配置与代码分离 | 密钥和部署参数不硬编码 | 不能替代应用数据库内的租户/连接级配置 |
| Sonarr / Radarr Root Folders | 在应用内管理媒体根目录，并要求运行用户具备访问能力 | 目录由应用配置管理；执行前验证目标目录可用 | 本系统应以绑定网盘连接的 CID 作为“根目录”，而非共享进程环境变量 |
| Zod `safeParse` | 对输入进行结构化校验并返回可处理的错误结果 | 可生成可读的配置校验结果 | 可选用于边界校验，不是解决漏传范围的替代品 |

参考资料：

- [Docker Compose 变量插值](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- [Docker Compose `environment`](https://docs.docker.com/reference/compose-file/services/#environment)
- [The Twelve-Factor App：Config](https://12factor.net/config)
- [Sonarr Quick Start：Root Folders](https://wiki.servarr.com/sonarr/quick-start-guide)
- [Radarr Quick Start：Root Folders](https://wiki.servarr.com/en/radarr/quick-start-guide)
- [Zod：Parsing data / `safeParse`](https://zod.dev/basics)

## 建议解决方案

### 1. 统一解析写入范围

抽取一个轻量的 `Pan115WriteScopeResolver`（或纯函数），接受“绑定连接目录 + 环境 fallback + 执行模式”，返回明确的解析结果。Cookie-only 和 OAuth unified 执行器共同使用该结果构造 `Storage115Executor`，避免两条分支各自拼装环境变量。

建议优先级：

1. 任务明确绑定的连接目录范围；按任务类别只使用相关目录，并按既有规则去重/过滤空值。
2. 仅对没有连接级配置的旧式单网盘运行模式，允许显式的环境 fallback。
3. 已绑定连接但其范围为空或无效时返回配置错误；不能静默回退到其他账户或全局写入范围。
4. 没有任何显式范围时继续 fail-closed，禁止发起写入请求。

### 2. 在两个时点反馈错误

- **入队前预检**：订阅运行生成任务时验证账户、目标连接、目标类别目录均已配置。缺失时阻止创建不可执行任务，或将其记录为明确的 `blocked_scope_missing` 状态。
- **执行时复检**：worker 仍需复检并将解析后的范围传到执行器，防止排队期间配置变化或绕过入口校验。

错误消息使用可操作描述，例如“此 115 连接未配置动漫目录，请到网盘设置补充目录后重试”；不要把开发环境变量名直接展示给普通用户。若执行器构造失败，标记为永久配置错误，不进入网络瞬态自动重试。

### 3. 使用小型状态模型，不引入重型状态机库

配置解析可采用判别联合类型：`ready(scope)`、`missing(reason)`、`invalid(reason)`。任务状态只在确实需要区分“等待配置”和“执行失败”时增加 `blocked_scope_missing`，并定义从阻塞恢复到待执行的显式迁移。项目现有队列和失败处理器已承载运行状态；当前问题不需要引入独立状态机框架。

### 4. 保持策略/适配器边界清晰

策略只决定搜索、筛选、集数规则等获取行为；存储适配器负责将统一的目录范围转换为具体网盘执行器配置。可保留现有按品牌分派的 Adapter/Factory 模式，在 Pan115 的 Cookie/OAuth 引擎间复用同一个范围解析器。不要让订阅策略携带 115 专属 CID，也不要让 Agent 提示词或订阅字段承载权限边界。

### 性能与可行性

范围解析是对已读取连接记录做本地数组处理，成本为 O(k)，其中 k 最多是根目录及少量分类目录，几乎没有可测性能影响。入队预检可复用本次任务已加载的连接对象，避免额外数据库查询；若调用点没有连接数据，再按批量读取/缓存设计，避免每条队列任务多一次查询。执行时保留复检，不能为减少一次查询而取消安全校验。

## 回归门禁

修复实施后至少覆盖以下行为（使用 fake API，不访问真实网盘）：

1. OAuth `dual_engine` 收到绑定连接的 `scopeCids`、而全局环境为空时，成功构造执行器并传入范围。
2. OAuth `open_only` 的范围处理与 `dual_engine` 一致。
3. Cookie-only 行为保持一致，验证两条执行路径调用同一范围解析规则。
4. 已绑定连接缺少目标类别 CID 时，入队前得到明确配置错误/阻塞状态，不创建可重试的网络任务。
5. 对连接已绑定但范围缺失的情况，不回退到不相关的全局 CID。
6. 有效白名单允许范围内写入，并拒绝范围外写入。
7. 全局测试根目录只在明确的开发/测试模式下生效；生产写入仍须显式授权范围。
8. 无任何有效范围时继续抛出/返回稳定的 `WRITE_SCOPE_REQUIRED`，验证 fail-closed 不回归。
9. CID 去空、去重和格式校验有边界测试；错误内容不包含 Cookie、Token 或完整敏感目录值。
10. 该配置错误不被分类为瞬态网络错误，不自动重试；用户修复目录配置后可以显式重新运行或安全重入队。

建议增加的专项用例放在现有 `storage-executor-factory`、`storage-115-executor` 和订阅任务入队/worker 测试附近，不需要新增测试依赖。测试应断言可观察的执行器参数和队列状态，而不是只匹配源代码字符串。

## 已实施优化

- worker 创建连接网盘执行器时显式标记 `connected-storage` 范围来源。
- 新增 Pan115 范围环境解析器，Cookie 与 OAuth 执行器共用：绑定连接的目录 CID 优先；连接范围为空时清除进程级写入范围和测试根目录，再由原有 fail-closed 门禁拒绝构造；未绑定的旧式执行路径仍可使用环境变量 fallback。
- 115 缺少写入范围时，失败信息现在提示用户检查「网盘」页面的连接分类目录；错误仍是不可重试的配置失败，不会触发网络重试。
- 回归测试覆盖 OAuth `dual_engine` / `open_only` 的连接范围、连接范围覆盖全局范围，以及 Cookie/OAuth 三条执行路径在连接范围缺失时都拒绝使用全局 CID。

本次没有增加队列数据库状态或在订阅创建接口重复查询网盘目录。执行器创建发生在 115 外部写入前，缺失范围会立即 fail-closed；若后续产品要求在任务入队前就阻止任务创建，可在入队服务复用同一范围解析结果增加轻量预检，而不必引入新的状态机依赖。

## 文件索引与相关文档

- `apps/web/features/acquisition/application/worker-runner-service.ts`：按任务绑定连接加载凭据和目录范围。
- `packages/workflow/src/storage/storage-brands.ts`：品牌及引擎模式分派，含 Cookie-only 范围注入。
- `packages/workflow/src/storage/pan115-storage-factory.ts`：统一 OAuth 执行器工厂与 `resolvePan115ExecutorEnv` 范围解析器。
- `packages/workflow/src/storage/storage-115-executor.ts`：115 写入范围解析与 fail-closed 门禁。
- `packages/workflow/src/execution/workflow-failure-handler.ts`：瞬态重试分类及失败通知。
- `packages/workflow/tests/storage/storage-executor-factory.test.ts`、`packages/workflow/tests/storage/storage-115-executor.test.ts`：现有范围相关测试。
- `docs/environment-variables.md`：全局变量的开发/旧模式 fallback 说明。
