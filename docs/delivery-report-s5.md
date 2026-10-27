# S5 交付报告：API Key 认证与在线更新源改造

> **判词：proven（就本次会话证据而言）** —— 依据是五轮逐维对抗性核查的全部发现都已修复、每处修复都做过「回退实现会红」的变异验证、以及最终全量门禁九项全绿。
> **诚实的边界**：`doublecheck_report(verify: true)` 的按维校验器**没有真正运行**（工具返回 `Verification: Not run`、`Adversary review: No adversary review ran`）。本报告的对抗性证据来自我另外用 `workflow` 工具跑的**五轮逐维核查**（每轮一个检查器 agent），不是来自 doublecheck 的内建校验器。

- 仓库：`/root/mediary-scout`（fork：`origin = xixjohan/mediary-scout`，`upstream = fancydirty/mediary-scout`）
- HEAD：`4c7298e`（另有 `537b69b` 第四轮修复、`6dc2bab` 第五轮修复、`ebd7eb7`/`4c7298e` 两份复核记录）
- 方案文档：`docs/api-key-auth-and-self-update.md`（§7 验收总标准 + §8 执行状态 + §附一~§附四 四轮复核记录）

## 1. 规格（已固化）

| 维 | 内容 |
|---|---|
| 目标 | 完成 S5.1–S5.6 六个任务单，全程 TDD 红→绿，每轮结束全量门禁绿 |
| 范围 | apps/web（责任链、27 个非白名单 route.ts 加闸机、auth/token、settings API Key 端点与设置页）、packages/shared（api-key-source、jwt HS256）、eslint L2 新规则 + 单测、更新链四处同源、.env.example、文档 |
| 不动 | LAN 单用户开放语义、agent/* 独立 token、worker secret、updater token 机制 |
| 优先级 | 正确性 > 门禁全绿 > 覆盖面 |
| 非目标 | 多副本共享限流、per-account key、XState FSM、middleware 硬拦、Auth.js、付费远程访问功能本身 |

六个任务单全部落地：S5.1 移除付费横幅、S5.2 API Key 策略（env+DB，DB 优先，端口+加密落盘）、S5.3 API key 换 JWT（jose/HS256 + 限流）、S5.4 全部 /api 路由登录认证（40 路由：12 白名单 + 5 agent 自守卫 + 23 登录链；ESLint 门禁兜底）、S5.5 设置页 API Key 管理、S5.6 在线更新源改当前仓库。

## 2. 测试证据（最终门禁，HEAD `4c7298e`）

| 门禁 | 结果 |
|---|---|
| `npx vitest run` | **385 文件 / 5231 用例全绿** |
| `npx vitest run --sequence.shuffle --sequence.seed=20` | 全绿（该 seed 在第五轮修复前**稳定红**） |
| `npm run gate`（layout + deps + eslint --max-warnings 0） | exit **0** |
| tsc × 9（根 / web / desktop / host-worker / tmdb-proxy / scout-connect / shared / workflow / contracts） | 全 **0** |
| `npm run build:shared` / `build:workflow` / `build:web` | 全 **0** |
| `npm run e2e` | **4 passed** |

红→绿轨迹：会话内 120 条通过记录、4 条失败记录（失败全部是修完即绿的红，不是遗留）。

## 3. 对抗性核查：五轮，每轮一个检查器

| 轮 | 问法 | 判词 | 抓到的问题（均已修） |
|---|---|---|---|
| 1 | 初版自审 | — | 2 个缺口 |
| 2 | 逐维复核 | partial | 5 个 medium + low |
| 3 | 逐维复核 | partial | 4 个，含 1 high |
| 4 | **「用例是否真的在测它假装在测的」** | partial | 多个，其中 **H4 三个用例是假绿** |
| 5 | **「同一请求头在 proxy / 路由规则 / 闸机 / 数据层四层上是否同判」** | partial | 1 个真代码缺陷 + 第三处 mock 泄漏 + 1 个门禁缺口 |

### 3.1 两处最值得记的缺陷

**H4 假绿（第四轮 high）**：`single-user-gate-wiring.test.ts` 的 `boot()` 造完 cookie 后又调了一次 `vi.resetModules()`，模块级 repository 单例连同 `:memory:` 库一起重建、session 行丢失——三个用例与「无 session」场景完全重合。**探针实证：把 H4 修复整段删掉，三个用例照样全绿。** 重写为单模块实例内造 cookie + 自证断言 + 变异验证（回退 → 红）。第五轮的检查器又用 `git checkout 16cf9d0 -- <旧测试文件>` 做了前后对比实证：旧文件 + 回退修复 → 23/23 绿（假绿复现）；新文件 + 回退修复 → 用例 1 红。

**闸机与数据层分裂（第五轮，真代码缺陷）**：`resolveSessionAccountId` 抛错（DB 抖动）时，单用户分支的 `catch { return 哨兵 }` 直接返回——而 Bearer 判定在它**之后**，永不执行；多用户分支被外层 catch 吞。auth-chain 的契约明写「读不到 ≠ 认证失败，继续问别的通道」，数据层没遵守。症状：JWT 认证成功的请求拿到 **200 空数据**而不是干净 401。两处改为落 Bearer 兜底，复核探针转正为 `auth-gate-data-parity.test.ts`（13 例，四层并排），变异验证（回退单用户 catch → 红）。

### 3.2 「假绿比红更危险」的纪律落地

每一处修复都做了变异验证（临时改坏实现 → 确认有测试变红 → 还原）：

| 修复 | 变异 | 结果 |
|---|---|---|
| H4 单用户 Bearer 无条件判定 | 包回 `if (sessionAccountId === null)` | 1 红 |
| H4b 多用户 session 优先/Bearer 兜底 | 恢复「无 cookie 才看 Bearer」 | 1 红 |
| 多用户次序 | 对调成 Bearer 优先 | 1 红 |
| bearer-scheme 共享规则 | 去掉 `token.trim()` | 2 红 |
| deploy.sh 镜像推导 | 默认值改回 fancydirty | 2 红 |
| shell trim | 改回 `tr -d`（删内部空白） | 1 红 |
| THROW+Bearer 修复 | 回退单用户 catch | 1 红 |

## 4. 更新链四处同源（S5.6）

默认值全部指向当前仓库 `xixjohan/mediary-scout`，且**每一处都有行为级测试**（此前 compose 透传与 deploy.sh 推导零覆盖——删掉不红）：

| 位置 | 默认值 | 测试 |
|---|---|---|
| `docker-compose.yml` web/worker 镜像 | `${MEDIARY_IMAGE:-ghcr.io/${MEDIA_TRACK_UPDATE_REPO:-xixjohan/mediary-scout}:latest}` | `runtime-config.test.ts`（精确串 + `not.toContain("fancydirty")`） |
| `updater/run-update.sh` | `xixjohan/mediary-scout` | `run-update.test.mjs` 57 例 |
| `scripts/deploy.sh` | 同左 | `tools/update-source-parity.test.mjs` 8 例 |
| `apps/web/lib/release-feed-server.ts` | 同左 | `release-feed-server.test.ts` 22 例 |
| `apps/desktop/src/update-check.ts` | **`fancydirty/mediary-scout`（有意）** | `update-check.test.ts` 钉死默认值 |

桌面侧默认上游是记录在案的产品立场：fork 不发 `.dmg`/`.exe`（GitHub API 实证：fancydirty 最新 release 带安装包，xixjohan 0 tag / 0 release），改默认会让存量桌面安装收不到更新。

## 5. 已知限制（不在本次范围，未修）

1. `/api/settings/api-key` 的 UI 死代码：`api-key-panel.tsx` 有 `freshKey`/复制/粘贴输入，但只 POST `{}`。
2. `.tsx` 组件零 vitest 覆盖（`include` 只含 `*.test.ts`）——`update-section.tsx` 的同源断言只能读源码。
3. worker 路由在默认配置下可被远程匿名触发（既有行为，文档声明保留）。
4. fork 当前 0 tag / 0 release：默认部署的 `compose pull` 会失败，部署方需显式设 `MEDIA_TRACK_UPDATE_REPO` 或 `MEDIARY_IMAGE`（deploy.md 新增一节说明三现象与解法）。
5. `Authorization` 头值前导空白形态（`" Bearer <jwt>"`）在真实服务上被 Node Headers 规范化后与标准形态不可区分，实测同为 200；垃圾 token 同为前导形态则 401，不构成 fail-open。
6. `doublecheck_report` 的内建按维校验器两次都未真正触发，本报告的对抗性证据全部来自我自建的 workflow 逐维核查。
