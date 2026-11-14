# 订阅集状态与筛选提示补丁：生产部署记录

日期：2026-11-14，Asia/Hong_Kong。范围：部署已完成的防回归补丁，保留当前订阅与网盘文件，验证《凡人修仙传》仍只缺 E197。

## 1. 部署结果与版本

生产容器 `mediary` 已切换到新镜像，健康接口返回 `{"status":"ok"}`，进程保持运行，验收期间重启次数为 0，Worker 模式保持 `inprocess`。

- 镜像标签：`mediary:subscription-fix-20261114`。
- 镜像 ID：`sha256:f14e194de3d686d2d1d997c618081a0d35536a7f1d953cc1699f480152e494f2`。
- `/app/BUILD_COMMIT`：`91132338-subscription-fix-20261114`。这是基于 HEAD 加未提交工作区补丁的部署标识，不是一个新的 Git 提交。
- 上传源码包 SHA-256：`88d505361ff307a7d111d191393b3416cfa96bba984a0b4c6c3888ad5f9c529e`。
- 使用生产多阶段 Dockerfile 构建，未复制 Windows 的 node_modules 或编译产物。新容器与旧容器的环境变量、数据挂载、端口、DNS、网络、重启策略及日志配置已逐项比对一致。

没有提交、推送或发布官方镜像。后续官方升级必须包含本次源码修复；直接切回尚未包含补丁的 `latest` 会失去这些保护。

## 2. 部署前备份与回退准备

切换前确认没有 queued/running 采集任务，并保留以下备份，均未进入版本库：

| 备份 | 位置 / 标识 | 验证 |
| --- | --- | --- |
| SQLite 在线一致性备份 | `/app/data/pre-subscription-deploy-20261114.db` | SQLite `integrity_check=ok` |
| 原容器完整配置 | `/opt/mediary-backups/subscription-20261114/container-before.json` | 后续配置比对通过 |
| 原镜像元数据 | 同目录 `image-before.json` | 原镜像 ID 已保留 |
| 原镜像离线归档 | 同目录 `rollback-image.tar` | 已导出，约 320 MiB |
| 数据目录辅助文件备份 | 同目录 `data-files-before.tar.gz` | 排除活动数据库及 WAL/SHM，数据库由 SQLite backup 单独保证一致性 |
| 停写后的完整数据目录 | 同目录 `data-stopped-before.tar.gz` | 原容器停止后、启动新容器前完成，包含数据库与其他持久文件 |
| 停止的原容器 | `mediary-rollback-20261114` | 保留原镜像、配置与挂载 |
| 回退镜像标签 | `mediary:rollback-subscription-20261114` | 指向原镜像 |

配置与归档文件创建为仅属主可读写。先用独立数据库副本启动 `mediary-subscription-smoke`，Worker 设为 external，不启动采集；健康检查和副本集状态断言通过后才切换生产。该验收容器现已停止。

切换程序包含健康探测失败时恢复原容器的分支，本次未触发回退。若后续需要回退，应先确认采集任务空闲，再停止新容器、另名保留并将原容器恢复为 `mediary` 后启动，随后验证健康与缺集。代码回退不应默认覆盖数据库。整库恢复会影响部署后的其他业务记录，须另行评估；本次没有用备份覆盖生产数据。

## 3. 构建中的既有依赖问题

第一次按原生产 Dockerfile 构建时，`npm ci` 未保留可用的可选依赖 better-sqlite3，Next 构建报告缺少模块。显式安装的尝试又遇到 npm `edgesOut` 错误。这两次均发生在独立构建中，未切换生产。

最终仅在远端部署专用 Dockerfile 中增加原生依赖复用：从已备份的生产镜像复制 better-sqlite3 **12.11.1**、bindings、file-uri-to-path 到 builder，保持现有版本与 Linux Node ABI 127，并执行内存数据库读写检查。之后完成 Web、TypeScript 与 Worker 构建；runner 仍使用生产 standalone 入口。没有修改仓库 Dockerfile 或依赖清单，也未引入新依赖版本。通用构建管线的可选依赖安装可靠性仍是独立问题。

## 4. 集状态与实际网盘验收

生产切换后，数据库与浏览器、网盘只读接口交叉核验：

- 第一季总集数 210、已播集数 199、已获得 198，唯一已播缺集为 `S01E197`。
- 浏览器显示“缺 1 集”，只列出 `S01E197`，进度为 `198/199/210`。
- 季目录返回 198 个非零视频，按文件名解析唯一集号后，E01–E199 中只缺 E197。
- 作品分类仍为 anime，季状态仍为 active，目录绑定仍指向已核验的 Anime 季目录。
- 目标作品全部 episode_states 原始记录（包括 verifiedFileIds）、tracked_seasons 记录、订阅策略记录与部署前数据库备份逐项完全一致。
- 原包含 1080p、排除词和 E190 起的逐季订阅范围均保留。客户端完成规则加载后正常显示“已配规则”及原范围。
- 浏览器未捕获异常数量为 0；存在资源 preload 警告。生产启动日志未发现 uncaughtException、未处理 Promise 拒绝、Hydration failed 或 FATAL ERROR；健康接口正常，活动采集任务为 0。

本次未转存 E197，未移动或删除网盘文件，未改写历史通知。

## 5. 自动订阅筛选诊断验收

### 生产实时规则预览

部署后的生产 API 使用原订阅规则搜索 4 个关键词，返回 499 个去重候选：250 个通过，249 个排除。其中 `missing_term=215`、`excluded=34`，计数之和正确，响应为 HTTP 200。实时结果会随来源变化，与早先快照数量不同不代表筛选回归。

### Linux 构建产物的只读回放

在禁用网络的独立容器中读取生产备份，使用同一份源码构建出的 RealResourceProviderV2、策略加载器和提示生成器回放真实保存候选，不运行 agent、不转存、不写生产数据库：

| 场景 | 输入 / 通过 / 策略排除 | 结果 |
| --- | --- | --- |
| 真实保存快照 + 原订阅规则 | 844 / 398 / 446 | missing_term 411、excluded 35；有可用候选时不生成“策略全拒绝”错误 |
| 从上述快照取实际被拒绝候选，并模拟来源降级的负向对照 | 446 / 0 / 446 | 提示实际策略排除数量及原因，明确“不代表资源不存在”；错误说明包含“部分搜索源不可用，结果尚不完整” |

第二行的来源降级为人为测试条件，不是声称当前线上来源正在故障。回放中的死链/用户拒绝计数为 0，未读取生产拒绝列表；这不是完整无人值守采集验收。新任务通知的提示生成逻辑已验证，但本次没有为了制造新通知而启动真实自动采集，历史通知保持原样。

## 6. 防回归验证

部署前在本机及远端 Linux builder 分别运行以下 5 个测试文件，均为 **37/37 通过**：

- `persistence/acquisition-failure-preservation.test.ts`：内存与 SQLite 的失败、重试、库存关联保留。
- `acquisition-v2/v2-run-tv.test.ts`：前置库存核验与读取异常边界。
- `acquisition-v2/v2-runner-persist.test.ts`：198 集检查点、模型失败及移动后的集状态保留。
- `acquisition-v2/verified-inventory.test.ts`：只按视频文件名识别，父目录集号不能伪造库存。
- `acquisition-v2/search-filter-diagnostics.test.ts`：实际拒绝阶段、规则说明与后续可用候选保护。

源码修复阶段扩大回归与剩余边界见[修复结果报告](2026-11-14-subscription-state-and-filter-fix-results.md)。本次未重新宣称全量 npm test 通过。
