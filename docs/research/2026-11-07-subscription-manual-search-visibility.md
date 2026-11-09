# 订阅详情手动补搜入口调查

## 现象与结论

开发实例中，《无职转生》第一季的缺集看板显示缺 23 集；展开已追踪季度后，浏览器中没有出现“立即搜索缺失资源”，仅看到逐集定向检索和取消追踪。这个现象说明入口在该实例不可见；尚未读取该季度的持久化逐集记录，不能断言具体数据状态或历史成因。

源码已接入手动补搜：`season-row.tsx` 在 `season.missingAiredCount > 0` 时显示按钮，按钮调用 `manualSubscriptionSearchAction`，经 `triggerManualSubscriptionSearch` 调用 `queueTrackedSubscriptionSearch`，以 `type3_monitor` 任务入队。电影详情则在已追踪且状态为 `missing` 时显示入口。入队前会检查账号、网盘、授权和配置；预约时复用任务去重及策略快照。

“搜此集”调用 `targetAndScroll`，选择目标并跳转到资源检索区域；它不是上述订阅补搜入队操作。未追踪季度的“获取本季”和“按策略获取”用于发起新的追踪或获取。

## 数据口径与可能原因

1. `getTrackedSeasonStatusView` 从持久化逐集状态统计 `missingAiredCount`；详情按钮仅依赖该计数。
2. `extractMissingEpisodes` 在逐集列表为空时，使用季度总集数、最新已播集和已获取数量推算缺集。它也把 `airStatus === "aired" && !obtained` 视为缺集，而按钮计数使用 `displayState === "missing_aired"`。因此看板与按钮可能得出不同结论。
3. 后台 `manualSearchReadiness` 对剧集只检查持久化逐集记录中是否有已播未获取的集；逐集记录为空会返回 `no_missing`。仅更改按钮显示条件，不能解决实际入队问题。
4. 按已获取数量推算具体集号依赖“已获取集连续”的假设；乱序入库时可能把已存在的集显示为缺失。`subscription-missing.ts` 已明确以逐集状态为准，未知或超前状态不应被当作已播缺集。

当前实例需只读核对该账号、网盘和季度范围内的 `tracked season`、逐集记录数量、播出状态、获取状态及详情接口计算结果，再确定是否属于逐集数据未初始化，或属于其他状态口径差异。不要将 UI 回退推算当作已证实的数据库事实。

## 建议方案

1. 建立共享的缺集判断与状态结果：逐集记录完整时，以已播且未获取的权威逐集状态为准；逐集记录缺失或不完整时明确返回“集数状态待同步”，不要把推算结果标成确定缺集，也不要据此直接转存。保留 `unknown`、`provider_ahead` 的独立语义，核对 `displayState` 与后台 `airStatus` 的差异。
2. 作品详情始终为有管理权限的已追踪季度提供可发现的“立即搜索缺失资源”入口：数据明确无缺集时说明原因并禁用；状态待同步时提供可理解的同步状态和操作。运行中显示忙碌状态，并链接活动页。电影和共享媒体库权限沿用服务端校验。
3. 在服务端为逐集状态未初始化的季度提供受控的元数据同步或初始化，再重新读取权威记录并判断是否入队；同步失败或状态仍不完整时返回明确错误，不得报告“没有缺集”或伪造入队成功。同步必须限定账号、网盘、作品和季度，不覆盖已有获取状态及文件关联。
4. 同步和入队的并发边界应覆盖重复点击、自动巡检和取消追踪：同步后再次校验追踪状态，使用现有原子任务预约与策略快照；重复请求返回已有任务。任务执行器也须确认初始化后的逐集状态可被消费，避免仅通过前置检查后仍被跳过。
5. 现有历史通知保持历史结果；如要从历史失败记录重试，应单独提供可识别目标、可反馈状态的入口，复用同一个服务端补搜命令。

## 验收与回归门禁

- 逐集记录完整且有已播缺集：展开对应季度可见入口，点击后仅创建一次任务，活动页可查看，保存入队时策略快照。
- 逐集记录为空、汇总值显示已播：页面显示待同步；同步成功后重读并按真实逐集状态处理；同步失败不入队，也不显示“没有缺集”。
- 逐集记录部分缺失、乱序已获取、未知和超前集：看板、按钮、服务端校验使用一致的权威结果，不把推算集号当成已确认缺集。
- 已齐、未播、正在执行、授权失效、非管理用户、错误网盘及取消追踪：分别给出正确状态，不重复入队、不跨账号或跨网盘操作。
- 在真实组件或浏览器中覆盖展开季度、按钮显示、忙碌和错误反馈；服务层覆盖同步、幂等、并发、策略快照及执行器消费。使用隔离数据和模拟外部服务，另行在开发环境验证真实链路。

## 代码索引

- `apps/web/features/acquisition/components/season-row.tsx`、`apps/web/features/catalog/components/title-action-buttons.tsx`：季度入口与前端动作。
- `apps/web/features/acquisition/contracts/missing-episodes-model.ts`、`apps/web/features/acquisition/core/subscription-missing.ts`：看板回退逻辑与权威缺集定义。
- `apps/web/lib/title-hub.ts`、`packages/workflow/src/execution/queries.ts`：详情数据与逐集计数。
- `apps/web/app/actions/acquisition-actions.ts`、`apps/web/features/acquisition/application/manual-subscription-search-service.ts`、`packages/workflow/src/execution/commands.ts`、`packages/workflow/src/execution/worker.ts`：权限、入队和执行链。
