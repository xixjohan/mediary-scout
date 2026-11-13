# 续作方案与执行流程 Runbook（播放器视口 / 投送策略）

- **日期**：2026-11-13（续）
- **关联主文档**：`docs/research/2026-11-13-player-viewport-fit-and-delivery-mode-resolution-research.md`
- **目标读者**：接手后续执行的开发者 / AI Agent
- **凭据规范**：主机地址、端口与 SSH 凭据统一用 `<DEV_HOST>` / `<ADMIN_PASSWORD>` 等占位符表示；真实连接信息仅从 `env/.envdev` 或系统环境变量动态读取，严禁写入文档、脚本或代码。

---

## 0. 当前进展快照（截至 2026-11-13 10:52）

| 维度 | 状态 | 证据 |
| :-- | :-- | :-- |
| **P0 布局（控制条贴底 / 容器填充）** | ✅ 已完成并部署 | `mediary-player-core.tsx` `autoSize:false` + `aspectRatio:false`，控制条实测 `controls.bottom == wrapper.bottom == 864` |
| **P0 投送（库策略生效）** | ✅ 已完成并部署 | `deliveryMode=proxy`、`deliverySource=library`、`reason=来源：library，配置为 proxy` |
| **P0 解析器（责任链 + source/reason）** | ✅ 已超前完成（原计划属 P1） | `packages/workflow/src/strm/delivery-mode-resolver.ts` + 12 例单测全过 |
| **P0 三入口一致性** | ✅ 已完成 | `library-folder-explorer` 删硬编码、`video-preview-modal` / `library-item-modal` 透传 |
| **提交 / 推送 / Tag** | ✅ 已完成 | `280f1e4a`（特性）+ `3a169a82`（CI 修复）已推 `mediary`；tag `v2026.11.13` 已推 |
| **镜像构建（Release Docker）** | ✅ 成功 | run `43353391449`，`ghcr.io/xixjohan/mediary-scout:latest` + `:v2026.11.13` 双标签 |
| **正式部署（生产 3000）** | ✅ 已完成 | 镜像 commit 指纹 `280f1e4a`，`/api/health` 返回 `{"status":"ok"}`，核心页面全部 200 |
| **CI 门禁** | ✅ 已转绿 | run `43354521014`（在 `3a169a82` 上）`success`；`fs-browse` 平台依赖已修 |
| **Release Desktop（桌面端发布）** | ❌ **仍失败（待修复）** | run `43353391476` 失败：tag `v2026.11.13` 指向 `280f1e4a`，其树中无 `docs/release-notes/v2026.11.13.md`（文件在 `3a169a82` 才补） |
| **生产实例内置浏览器完整验收** | ⛔ 未做（仅冒烟） | 开发 3020 已全量验收；生产 3000 仅 health + 5 页面 200 + 投送接口验证 |
| **115 凭据恢复后的四类片源视觉回归** | ⛔ 未做（凭据失效） | 当前 `videoWidth/Height=0`，非 16:9 验证靠几何测量而非像素 |

> **关键澄清**：原 P0 实施时实际把原方案 P1 的「video 层去黑边策略」与「`resolveDeliveryMode` 责任链 + source/reason」一并落地了。因此下方「剩余」章节不再重复这两项，只保留**真正未做**的部分。

---

## 1. 待办清单（Backlog）

| 编号 | 事项 | 优先级 | 预估 | 阻塞 |
| :-- | :-- | :-- | :-- | :-- |
| **R1** | 修复 Release Desktop：将轻量 tag `v2026.11.13` 重指向 `3a169a82` 并推送，触发镜像重建 + Desktop 通过 | 高（发布闭环） | 10 min | 无 |
| **R2** | 生产实例（3000）内置浏览器完整验收：5 核心页面 + 播放器 + 扫描闭环 | 中（质量保障） | 30 min | 复用 dev 脚本改 BASE |
| **R3** | P1 收尾：布局 fallback 显式化（`pending → fitted → fallback` 状态机，固化 `videoWidth=0` 的确定性兜底） | 中 | 0.5 天 | 无 |
| **R4** | P2-A：竖屏（9:16）/ 超宽（>2.4:1）专用适配策略（容器居中 + 最大高度限制，避免 `cover` 硬裁） | 低 | 0.5 天 | 115 凭据 |
| **R5** | P2-B：投送模式会话记忆（用户手动切换后写入 `account_settings`，刷新/重开保持） | 低 | 0.5 天 | 无 |
| **R6** | P2-C：播放器内「为什么是这个模式」常驻提示（基于已有 `deliveryReason`，比 hover 更显眼） | 低 | 0.25 天 | 无 |
| **R7** | 115 `refresh_token` 恢复后，按 16:9 / 2.39:1 / 4:3 / 9:16 四类片源补一次视觉回归 | 高（验收闭环） | 0.5 天 | 需用户重新扫码授权 |

---

## 2. 真实剩余的方案细节

### 2.1 R3 — 布局 fallback 显式化（P1 收尾）

**现状**：P0 已 `autoSize:false`，`videoWidth=0` 时 `$player` 撑满容器（隐式行为）。但「布局依赖视频元数据」的隐式性未消除，仍需显式化以避免回归。

**方案**（对齐主文档 §2.4 的状态机，避免过度设计——用 `useState` 而非 xstate）：

```ts
type LayoutPhase = "pending" | "fitted" | "fallback";
// pending: 等待 video metadata
// fitted: 已拿到 videoWidth/Height，video object-fit 按用户策略生效
// fallback: videoWidth=0（加载失败/凭据失效），强制 object-fit:contain 确定性兜底
```

- 监听 ArtPlayer 的 `video:loadedmetadata` / `error` 事件切换 phase。
- `fallback` 阶段强制 `video.style.objectFit = "contain"`，保证控制条位置不变量始终成立。
- 单测覆盖：`videoWidth=0 → fallback-contained`；`videoWidth>0 → fitted`。

**涉及文件**：`apps/web/features/player/components/mediary-player-core.tsx`。

### 2.2 R4 — 竖屏 / 超宽专用策略（P2-A）

**现状**：`contain` 在 9:16 片源放进 16:9 窗口时，左右产生巨量黑边（主文档 §6.2）。

**方案**：在 video 层 `object-fit` 之外，增加对「源比例 × 容器比例」的判断：
- 竖屏源（ratio < 0.8）：容器内部居中 + `max-height` 限制，`object-fit: contain` 不裁切。
- 超宽源（ratio > 2.4）：同 `contain`，上下黑边由 video 承担。
- **禁用 `cover` 硬裁竖屏**，避免切头切尾。

**注意**：不要为此引入 `react-resize-detector` 等库，ArtPlayer 已有 `resize` 事件 + `ResizeObserver`（主文档 §2.5）。

### 2.3 R5 — 投送模式会话记忆（P2-B）

**现状**：用户手动切换 `redirect ⇄ proxy` 仅会话内有效，刷新 / 重开播放器回到解析器默认值。

**方案**：切换后写入 `account_settings`（复用既有白名单机制，主文档 §1.4 会话级），下次打开以该值为 `session override` 注入 `resolveDeliveryMode`（已是责任链最高优先级）。需新增设置键并走白名单，避免 `gate:contracts` 失败。

### 2.4 R6 — 播放器内模式原因提示（P2-C）

**现状**：`deliveryReason` 已随接口返回，UI 仅在左上角标签 hover 显示。

**方案**：在控制层加一行小型常驻说明（如「当前为代理模式：直链被驱动规则否决」），来源即 `deliveryReason`。成本极低，纯展示层改动。

---

## 3. 执行流程 Runbook（双轨制 + 内置浏览器验收）

> 完整规范见根目录 `AGENTS.md` §2–§5。以下为本次任务验证过、可直接复用的命令序列。

### 3.1 前置：清理 Windows 代理变量（PowerShell 5.1 字典冲突）

每次跑 `deploy-remote.ps1` 前先清重复代理变量，否则 `Start-Process` 报 `ArgumentException`：

```powershell
Remove-Item Env:https_proxy -ErrorAction SilentlyContinue
Remove-Item Env:http_proxy -ErrorAction SilentlyContinue
Remove-Item Env:all_proxy -ErrorAction SilentlyContinue
Remove-Item Env:no_proxy -ErrorAction SilentlyContinue
```

### 3.2 方案 A — 开发实例极速验证（默认，3000 生产零影响）

```powershell
# 自动策略：工作区干净→GitArchive；有未提交改动→Direct 直推
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev

# 仅改了 public/ 静态资源时，2 秒热更，免重建
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -PublicOnly
```

等待就绪（约 30–50s 构建 / 2s 热更）：

```bash
BASE=http://<DEV_HOST>:3020
for i in $(seq 1 8); do
  H=$(curl -s --max-time 5 $BASE/api/health)
  echo "$H" | grep -q '"ok"' && { echo "HEALTH_OK after ${i}x5s"; break; }
  sleep 5
done
```

### 3.3 内置浏览器验收（Playwright）

**复用脚本**（改 `BASE` 常量即可对生产 3000 复用）：

| 脚本 | 覆盖 |
| :-- | :-- |
| `test-results/acceptance-2026-11-13.mjs` | 5 核心页面（/、/?tab=library、/storage/strm、/settings、/library）+ 扫描闭环 |
| `test-results/acceptance-player.mjs` | 快捷键（Space/F/?）、提示条三档、Escape 两段式、未捕获错误 |
| `test-results/verify-p0-layout.mjs` | 容器/控制条几何测量（控制条是否贴底）、`object-fit`、来源标记 |

运行（需先 `npm i` 装好 `playwright`）：

```bash
export PATH="/c/Program Files/nodejs:$PATH"
node test-results/acceptance-2026-11-13.mjs   # 开发：把 BASE 改 3020
node test-results/acceptance-player.mjs
node test-results/verify-p0-layout.mjs
```

**验收红线**（对齐 `AGENTS.md` §5 + 主文档 §5）：
- 5 页面全部 200，`pageErrors=0`、`consoleErrors=0`、无 hydration 崩溃、无错误覆盖层。
- 播放器：`controls.bottom == wrapper.bottom`（控制条贴底）；`objectFit` 符合预期；`pageErrors=0`。
- 投送：库设 `proxy` → 接口 `deliveryMode=proxy` + `deliverySource=library`；binding `inherit` 正确上继承。
- 扫描：进行中显示「正在智能扫描中 + 取消扫描 + 进度」，终态自动复位。

### 3.4 方案 B — 正式生产部署

```powershell
# 1) 本地门禁
npm run lint && npm run typecheck && npm run gate

# 2) 提交 + 打轻量 tag（必须 lightweight，指向 commit，不要用 annotated tag）
git add -A
git commit -m "feat/fix: ..."
git tag v2026.XX.XX          # 轻量 tag，指向 HEAD commit
git push origin mediary --tags

# 3) 等 GitHub Actions（Release Docker）构建 latest 完成
gh run list --workflow=release-docker.yml --limit 2

# 4) 触发生产重建
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Official
```

### 3.5 远程诊断（免登录）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -RemoteExec "docker logs --tail 30 mediary"
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -RemoteExec "curl -s http://127.0.0.1:3000/api/health"
```

---

## 4. R1 修复步骤（Release Desktop 失败）

**根因**：`v2026.11.13` 是轻量 tag，指向 `280f1e4a`；`docs/release-notes/v2026.11.13.md` 在 `3a169a82` 才补，tag 树中不存在 → Release Desktop preflight 的 `Require release notes` 失败。

**修复**：把轻量 tag 重指向已含发布说明的 `3a169a82` 并推送（force）。这会重新触发 Release Docker（以 `3a169a82` 重建，仅含测试修复，运行时等价）与 Release Desktop（notes 存在 → 通过）。

```bash
git tag -d v2026.11.13
git push origin :refs/tags/v2026.11.13
git tag v2026.11.13 3a169a82          # 轻量 tag 指向含发布说明的提交
git push origin v2026.11.13 --force
```

**后续可选**：镜像重建后，生产 3000 仍为旧 `280f1e4a` 镜像（运行时等价），如需版本指纹完全一致可再跑一次 `-Mode Official`。

> ⚠️ 不要把 R1 与 R7（115 视觉回归）或 P1/P2 代码改动混在同一 tag 里——每次 tag 应只承载一个明确发布目的，降低回归面（主文档 §6.6）。

---

## 5. 命令速查表

| 目的 | 命令 |
| :-- | :-- |
| 开发部署（自动策略） | `powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev` |
| 静态资源热更 | `... -PublicOnly` |
| 生产部署 | `... -Mode Official` |
| 仅诊断 | `... -CheckOnly` |
| 远程执行 | `... -RemoteExec "docker ps"` |
| 本地全门禁 | `npm run gate` |
| 指定解析器单测 | `npx vitest run packages/workflow/tests/strm/delivery-mode-resolver.test.ts` |
| 查看 CI | `gh run list --limit 4` |
| 等待 CI 完成 | `gh run watch <run_id> --exit-status --interval 20` |
| 重建并修复 tag | 见 §4 |

---

## 6. 风险与边界（执行时注意）

1. **115 凭据**：当前 `refresh_token` 失效，真实视频无法加载（`videoWidth=0`）。R2/R4/R7 的「真实画面」验证必须等用户在设置页重新扫码授权后进行；在此之前非 16:9 验证只能靠**几何测量**。
2. **Release Desktop 是发布闭环的硬门**：不修 R1，桌面端发布永远失败；但**不影响**生产 3000 容器（由 Release Docker + 官方部署独立保障）。
3. **行数棘轮**：`sqlite-schema.ts` / `sqlite-media-library.ts` 受「只降不升」约束。新增 DB 方法务必放独立文件（如 `sqlite-media-library-lookup.ts`），勿直接撑大这两个 baseline 文件。
4. **契约门禁**：任何接口新增/变更字段必须同步 `gate:contracts`；新增 `account_settings` 键必须走白名单（R5）。
5. **勿顺手改缓存键**：投送解析与 `strm_link_cache` 的 UA 分桶是两件事（主文档 §6.6）。
6. **凭据红线**：文档、脚本、截图中的主机地址用 `<DEV_HOST>` 占位；真实凭据只从 `env/.envdev` 读取，绝不入库。

---

## 7. 参考文件

- 主调研文档：`docs/research/2026-11-13-player-viewport-fit-and-delivery-mode-resolution-research.md`（根因、方案对比、P0 验收记录）
- 上一轮验收基线：`docs/research/2026-11-13-implementation-and-acceptance-report.md`
- 部署规范：`AGENTS.md` §2–§5
- 已落地代码：`packages/workflow/src/strm/delivery-mode-resolver.ts`、`packages/workflow/src/persistence/sqlite/sqlite-media-library-lookup.ts`、`apps/web/features/player/components/mediary-player-core.tsx`、`apps/web/app/api/library/play/[episodeId]/route.ts`
- 可复用验收脚本：`test-results/acceptance-2026-11-13.mjs`、`test-results/acceptance-player.mjs`、`test-results/verify-p0-layout.mjs`
- 发布说明：`docs/release-notes/v2026.11.13.md`
