# 开发实例实机验收记录（2026-11-13）

> 依据 `AGENTS.md` §3 方案 A（Linux 极速开发部署管线）与 §5（内置浏览器自动化验收规范），
> 对近期改动 R3–R6 及相关核心页面做端到端实机验收。
> 主机地址统一以 `<DEV_HOST>` 占位，真实连接信息仅存于 `env/.envdev`。

## 1. 验收环境

| 项 | 值 |
| :--- | :--- |
| 部署方式 | `scripts/deploy-remote.ps1 -Mode Dev`（方案 A，Auto → GitArchive） |
| 实例 | `mediary-dev`，端口 3020，独立数据卷 `mediary-dev-data` |
| 运行提交 | `5f1ff825`（与本地 HEAD 一致，部署脚本已校验 `BUILD_COMMIT`） |
| 健康检查 | `/api/health` → `{"status":"ok"}` |
| 生产实例 | 3000 端口未受影响（部署脚本自带隔离） |
| 浏览器引擎 | Chromium（Playwright 驱动，1440×900） |

## 2. 核心页面巡检（AGENTS.md §5）

| 页面 | H1 / 主要内容 | 主题与样式 | pageerror | console error | 4xx/5xx | 结论 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/` | 搜索 | 深色，CSS 规则 1022 条 | 0 | 0 | 0 | 通过 |
| `/?tab=library` | 我的订阅（订阅中 0 / 已完成 13 / 全部 13） | 深色 | 0 | 0 | 0 | 通过 |
| `/library` | 影视库（海报网格正常渲染） | 深色 | 0 | 0 | 0 | 通过 |
| `/storage/strm` | STRM 任务计划与串流中继（3 个任务计划） | 深色 | 0 | 0 | 0 | 通过 |
| `/settings` | 设置（网盘连接、115 已连接 1 块盘） | 深色 | 0 | 0 | 0 | 通过 |

红线核对：

- 无未捕获异常（`pageerror` 全为 0）。
- 无 Next.js 水合错误、无错误浮层（`nextjs-portal` 未出现）。
- 无长时间挂起的请求，无 4xx/5xx 资源请求。
- 页面样式表均正常生效（`body` 背景 `rgb(18, 18, 18)`，`cssRules` 1022 条）。

## 3. 近期改动验收（R3–R6）

### R3 布局 fallback 状态机 + R4 竖屏/超宽适配

115 `refresh_token` 仍失效（`videoWidth = 0`），因此验证的是「元数据超时后的确定性兜底」与
「控制条贴底不变量」，而非真实画面像素。

| 断言 | 实测值 | 结论 |
| :--- | :--- | :--- |
| 8s 元数据超时后状态机落点 | `data-layout-phase = fallback` | 通过 |
| 容器适配标记 | `data-viewport-fit = fallback` | 通过 |
| video 层不裁切 | `object-fit: contain` | 通过 |
| 控制条贴底 | wrapper/controls/video bottom 均为 864（差值 0） | 通过 |
| 刷新重开后仍确定性回落 | `afterReload.viewportFit = fallback` | 通过 |

### R6 决策原因常驻提示

- 首屏（控制层未交互）：`投送决策：来源：library，配置为 proxy` 常驻可见，无需 hover。
- 切换后：`投送决策：用户手动选择：302 CDN 直连（已记忆，下次打开保持）`。
- 恢复默认后：`投送决策：已恢复默认：下次打开重新按路径绑定 / 影视库配置解析投送模式`。

三种状态下 `reasonVisible` 均为 `true`，且不随控制层渐隐消失。

### R5 投送模式会话记忆

| 阶段 | 模式标签 | 决策原因 | 恢复默认入口 |
| :--- | :--- | :--- | :--- |
| 初始 | `服务器分片代理 · library` | 来源：library，配置为 proxy | 无（未覆盖，符合预期） |
| 手动切换 | `302 CDN 直连 · library` | 用户手动选择（已记忆） | 出现 |
| 刷新重开 | `302 CDN 直连 · session` | 已记忆的投送偏好（刷新后保持） | 保留 |
| 点击恢复默认 | `302 CDN 直连 · session` | 已恢复默认 | 消失 |

闭环成立：覆盖写入 `account_settings.player_delivery_mode` → 刷新后由服务端恢复为 `session` 来源 →
恢复默认后交回库 / 绑定配置解析。

## 4. 交互回归（既有用例复跑）

| 用例 | 结果 |
| :--- | :--- |
| 播放器打开 | 1 个 video 节点 |
| 提示条三档偏好 | 首次点击 `hidden` → 再次点击 `always`，均即时生效 |
| ESC 两段式关闭 | 第一次 ESC 仅退出全屏/还原，第二次关闭弹窗 |
| 快捷键 | Space / F / `?` 均 `prevented`，帮助面板正常弹出 |
| 控制条几何 | `objectFit=contain`，投送标签 `服务器分片代理· library`，0 报错 |

## 5. 遗留与阻塞

| 项 | 状态 | 说明 |
| :--- | :--- | :--- |
| 四类片源像素级回归（竖屏/超宽/16:9/宽银幕） | 阻塞 | 115 `refresh_token` 失效导致 `videoWidth=0`，需重新扫码授权后补测 |
| 生产 3000 业务页完整验收 | 阻塞 | 生产启用访问密码，缺少有效会话 cookie；HTTP 层健康与 5 页面 200 已通过 |

## 6. 证据

- 报告：`test-results/browser-acceptance/acceptance-report.json`
- 截图：`test-results/browser-acceptance/01-home.png` ~ `10-player-after-reset.png`
- 脚本：`test-results/browser-acceptance/acceptance-full.mjs`（可重复执行，`BASE=<url>` 指定实例）
- 交互回归：`player-shortcuts.json`、`p0-layout.json`
