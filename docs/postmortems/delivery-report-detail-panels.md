# 交付记录 — 详情页三面板优化（资源 / 整理 / 订阅策略）

> 结论：**green**。门禁、测试、构建、浏览器实测、四方对抗审计全部通过；已提交 `0f9a9aa2`；
> 线上实例（3001）已确认在跑含本次改动的新构建。

## 1. 规格（与确认过的一致）

- 目标：三面板获得与设计系统一致的卡片式样式；订阅策略挂载即回填已存策略（修 reload 丢策略的
  真 bug）；资源候选行补类型标签 / 截断 / 计数。
- 范围：`title-resource-panel.tsx`、`subscription-policy-panel.tsx`、`subscription-policy-panel-model.ts`、
  `title-organize-panel.tsx`、`globals.css` 及两个单测。不动后端契约。
- 验收：gate 与 npm test 全绿；新增单测覆盖映射分支；浏览器实测卡片排版 / 保存后刷新不丢 /
  429 冷却 / 缓存命中禁用入库；缺字段候选不渲染对应片段。

## 2. 测试时间线（全绿，无失败轮次）

| 阶段 | 命令 | 结果 |
|---|---|---|
| 新增用例（red→green） | vitest 两个 panel 测试文件 | 48/48 通过 |
| 全量 | `npm test` | 432 文件 / 5874 测试通过（多轮复跑） |
| 门禁 | `npm run gate` | layout + deps(900 模块) + lint(--max-warnings 0) + typecheck 全过 |
| 构建 | `npm run build:web` | Compiled successfully（提交前后各一次） |
| 提交后复跑 | `npm test` + `npm run gate` | 5874 通过 / exit 0 |

## 3. 对抗审计（4 个维度；工具折叠看不到，此处补录）

| 维度 | 结论 | 发现与处置 |
|---|---|---|
| 样式 | 4/4 证实 | **真 bug**：共享按钮规则被文件后段等特异性旧规则覆盖，「整理此目录」渲染成透明底 → 已删除旧规则，computed style 复测三按钮完全一致（`#1f1f1f` / `6px 14px` / `8px`） |
| reload 修复 | 证实（附理论风险说明） | **真 bug**：读回在飞时用户输入会被迟到响应擦掉 → 已加 `touchedRef` 护栏（改字段/预览/保存置位），复测通过。遗留理论风险（GET 返回字段类型错的策略对象时降级为全默认草稿而非 null）由 PUT 路由强校验兜底，当前不可达，判定接受 |
| 契约 | 5/5 证实，无反驳 | 响应不含 URL、60s 冷却 429+retryAfterMs、30 分钟快照 TTL、candidateId/snapshotId 不透明句柄、仅手动查询无轮询、episodeFilter 400 拒绝态，全部未动 |
| 范围 | 无越界 | 本任务恰好 7 个文件 + settings/page.tsx 5 行 import；CSS 未给并行流的表单背书；已知残余：settings/page.tsx 两流混改，回滚须成对 |

## 4. 浏览器实测

- dev server + 数据库副本：三面板 computed style `margin:16px 32px 8px / padding:16px 18px / bg:#181818 / radius:8px`；
  表单两列栅格 `491px 491px`；保存「2160p, 简中 / CAM, 枪版」→ 整页刷新 → 表单回填 + 「● 已配规则」；
  连点查询 → 「请稍候 53s」禁用 + 提示；缓存命中 → 入库按钮禁用 + 说明 tooltip。
- **线上实例（127.0.0.1:3001）**：三块面板均以 `hub-panel` 卡片渲染，边距/背景/栅格与 dev 实测一致，
  截图存档。登录态安全：session cookie 用库里的 `session_secret` 签名，重启不失效（已核实解析顺序）。

## 5. 交付物

- 提交：`0f9a9aa2`（9 文件，+588/-73），工作树干净。
- 并行流说明：`packages/shared` 两个文件的懒建 `createNativeRequire` 修复按「全部改动」一并提交，
  commit message 中分开陈述；并行流 05:18 的重建产物尚未进 3001 进程（其自身线程处理，
  重跑 `/tmp/deploy3001/start.sh` 即生效）。
