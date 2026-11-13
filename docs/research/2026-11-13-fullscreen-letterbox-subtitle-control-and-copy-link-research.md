# 全屏右侧黑边 / 字幕开关与多轨选择 / 复制链接失效 · 调研与修复方案

> 调研日期：2026-11-13
> 关联文档：`2026-11-13-subtitle-matching-and-remaining-optimizations-research.md`、`2026-11-13-player-telemetry-and-startup-latency-research.md`
> 实测环境：开发实例 `mediary-dev`（端口 3020，stamp `4cc81a78-dirty-150821`），Chromium 1440×900
> 主机地址统一以 `<DEV_HOST>` 占位；真实凭据仅存于 `env/.envdev`。

---

## 1. 结论摘要

| 问题 | 结论 | 性质 |
| :--- | :--- | :--- |
| ① 全屏右侧黑边 | **确认存在**，实测网页全屏下播放器右边界 1425 px、视口 1440 px，**右侧裸露 15 px**。根因是 `.art-fullscreen-web` 用 `width:100%` 相对「扣掉滚动条后的初始包含块」计算，不是视频比例问题 | 框架层 CSS 缺陷，可修 |
| ② 字幕开关与多轨选择 | **已实现**（设置面板「字幕」可关闭/切换、「字幕编码」、「字幕偏移」），全屏下同样可用（实测 8 个设置项）。但**生产 3000 仍是旧镜像**，且入口藏在设置里，可发现性不足 | 已解决 + 待优化可发现性 |
| ③ 复制链接无效 | **确认失效**：页面在 HTTP 局域网源下 `isSecureContext=false`，`navigator.clipboard` 为 `undefined`，点击直接抛 `TypeError: Cannot read properties of undefined (reading 'writeText')` | 明确的 API 误用，可修 |

三者都不是"性能问题"，而是**平台能力边界**（安全上下文、全屏包含块）与**可发现性**问题。

---

## 2. 问题一：全屏右侧黑边

### 2.1 实测数据

| 状态 | 播放器 rect | 视口 | 右侧间隙 |
| :--- | :--- | :--- | :--- |
| 弹窗内（normal） | x=21, w=1382, right=1404 | 1440 | 36（弹窗内边距，正常） |
| **网页全屏（web-fullscreen）** | x=0, w=1425, right=1425 | 1440 | **15** |
| 原生全屏（native） | 未在无头环境生效（`document.fullscreenElement` 为 null） | — | — |

同时 `video` 与 `.art-video-player` 的 rect **完全一致**（1425×900），`object-fit: contain`——说明**不是**视频比例导致的左右对称黑边，而是**容器本身没盖满视口**。

### 2.2 根因

ArtPlayer 的网页全屏实现（`node_modules/artplayer/dist/artplayer.mjs:2787-2815`）：

```js
set(value) {
  if (value) {
    art.state = "fullscreenWeb";
    setStyle($player, "width", "100%");
    setStyle($player, "height", "100%");
    addClass($player, "art-fullscreen-web");
  }
}
```

配套 CSS：

```css
.art-fullscreen-web { position: fixed; inset: 0; width: 100%; height: 100%; }
```

`position: fixed` 的包含块是**初始包含块**；在存在经典滚动条时，Chrome 的布局视口宽度 = `innerWidth - 滚动条宽`。于是 `width:100%` = 1425 px，而视口是 1440 px，右侧 15 px 露出底下的页面（深色背景 → 看起来就是"黑边"）。

> 用户截图里黑边看起来更宽，是因为窗口更窄/滚动条更宽/系统缩放，比例上同样是"视口减滚动条"的差值；本质相同。

### 2.3 为什么不是 `object-fit` 或竖屏适配

- `applyVideoFit()` 在非竖屏分支只清空 `width/max-width/margin-inline`，`objectFit` 恒为 `contain`（`mediary-player-core.tsx:80-110`）；
- 实测 `video` 与容器同尺寸，`contain` 若生效只会产生**上下或左右对称**留边；
- 因此黑边来自容器宽度，不来自画面适配。

### 2.4 修复方案

**方案 A（推荐）：监听 `fullscreenWeb` 事件 + 隐藏滚动条 + 视口单位**

```ts
// mediary-player-core.tsx 初始化后
art.on("fullscreenWeb", (on: boolean) => {
  document.documentElement.classList.toggle("mediary-web-fullscreen", on);
});
```

```css
/* globals.css */
html.mediary-web-fullscreen { overflow: hidden; }
html.mediary-web-fullscreen .art-video-player.art-fullscreen-web {
  width: 100vw !important;
  height: 100vh !important;
}
```

理由：`overflow:hidden` 让滚动条消失，`100%` 本可自动正确；`100vw/100vh` 作为兜底（`100vw` 含滚动条宽度）。两者叠加后右侧间隙归零。

**方案 B（纯 CSS，无 JS）**

```css
html:has(.art-video-player.art-fullscreen-web) { overflow: hidden; }
```

优点零侵入；缺点依赖 `:has()`（Chrome 105+/Safari 15.4+/Firefox 121+），且无法在退出时做额外清理。

**方案 C（改 ArtPlayer 内部）**：不可行——不修改第三方产物。

### 2.5 风险与边界

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 滚动条消失引起 reflow | 进入全屏瞬间页面宽度变化 | 全屏本身已是覆盖态，用户无感 |
| `100vw` 与横向滚动条 | 若存在横向滚动条会溢出 | 同时 `overflow:hidden` 已消除该前提 |
| 原生全屏不受影响 | 元素全屏时无滚动条 | 只对 `art-fullscreen-web` 生效 |

### 2.6 验证方式

在既有验收脚本中断言：进入网页全屏后 `player.getBoundingClientRect().right === window.innerWidth`，并截图人工确认。可直接复用 HUD「详细」档观察 `画面 W×H` 与容器尺寸。

---

## 3. 问题二：字幕开关与多轨选择

### 3.1 现状（已在开发实例实现）

`6f34fe4a` 已落地：

- 设置面板 → **字幕**：`关闭` / `简体中文 · xxx` / `English · xxx`；
- 设置面板 → **字幕编码**：UTF-8 / GB18030；
- 设置面板 → **字幕偏移**（ArtPlayer 内置，`subtitleOffset: true`）；
- 默认按语言优先级自动选轨（简 → 繁 → 英 → 日 → 韩 → 首条）。

全屏下实测设置面板仍可打开，8 个设置项齐全（`播放速度/画面翻转/字幕偏移/音量增益/画面适配/播放统计/字幕/字幕编码`）。

**关键前提**：生产 3000 仍运行 `8ad3f26d` 官方镜像，**尚未包含字幕改动**；用户若在生产验证会看不到入口。

### 3.2 仍存在的欠缺

| 欠缺 | 影响 | 建议 |
| :--- | :--- | :--- |
| 入口藏在设置里 | 用户不知道有字幕可选，尤其全屏时 | 控制条增加独立「字幕」按钮（ArtPlayer `controls.add`），一键循环 关闭→各轨 |
| 无全局默认 | 每次打开都要手动选，换集后回到自动 | 账号级偏好 `subtitle_mode`（off / auto / always）+ `preferred_language`，复用 `player_delivery_mode` 的存储与 Server Action 模式 |
| 无快捷键 | 键盘用户无法快速切换 | 复用 `player-shortcuts.ts` 增加 `V`（cycle subtitle） |
| 无"本片是否有字幕"提示 | 用户不知道有没有 | 底部提示条已显示「N 条外挂/内嵌字幕」，可再强化为可点击 |

### 3.3 设计建议

- **策略 Strategy**：`SubtitleSelectionPolicy`（`auto` 按语言优先级 / `always` 强制开 / `off` 强制关），把"默认选哪条"从组件里抽成纯函数（`pickDefaultTrack` 已有，扩展为接受 policy）。
- **状态机 State**：字幕的 `idle → loading → ready → error` 已有隐式状态（`art.subtitle` 的 Promise），建议显式化，避免"切换失败但 UI 显示已切换"。
- **适配器 Adapter**：`SubtitleTrackAdapter` 把 `SubtitleTrackInfo`（本地/在线/内嵌）统一成播放器轨道，为 L2 在线字幕预留。

### 3.4 业界对照

| 产品 | 开关位置 | 默认策略 |
| :--- | :--- | :--- |
| YouTube | 控制条 CC 按钮 | 记忆上次选择 |
| Netflix | 控制条字幕/音轨菜单 | 账号级偏好 + 记忆 |
| Plex | 播放器内菜单 + 账号「字幕模式」（始终/外语/强制） | 账号级 |
| Jellyfin | 播放器内菜单 + 用户「默认字幕语言」 | 账号级 |

共性：**控制条一键入口 + 账号级默认 + 记忆上次**。本项目目前只有"每次手动选"，应向账号级偏好演进。

---

## 4. 问题三：复制链接失效

### 4.1 实测

```json
{ "isSecureContext": false, "clipboard": "undefined", "writeText": "undefined", "execCommand": "function" }
```

点击后：

```
pageerror: Cannot read properties of undefined (reading 'writeText')
```

按钮文案不变（`copied` 状态永远不置位），用户看到的就是"点了没反应"。

### 4.2 根因

`mediary-player-modal.tsx:123-129`：

```ts
const copyAbsoluteLink = () => {
  const fullUrl = ...;
  void navigator.clipboard.writeText(fullUrl).then(() => { setCopied(true); ... });
};
```

Clipboard API **仅限安全上下文**（MDN：`Navigator.clipboard` 标注 Secure context）。本系统以 HTTP + 局域网 IP 访问（`http://<DEV_HOST>:3020`），不属于安全来源，`navigator.clipboard` 直接不存在。既没有能力探测，也没有降级与错误处理。

### 4.3 修复方案：三级降级的 ClipboardAdapter

```
1. navigator.clipboard.writeText（安全上下文）
2. document.execCommand('copy') + 隐藏 textarea（HTTP 场景，仍被 Chrome/Firefox/Safari 支持）
3. 兜底：弹出只读输入框并全选，提示「按 Ctrl+C 复制」
```

配套：

- 成功 → 按钮变「已复制」2 s；
- 失败 → 按钮变「复制失败」并展开手动复制框（不能静默）；
- 记录一次 `reportPlaybackMetric("copy_link", ...)` 便于统计成功率。

### 4.4 更深一层：这个链接到底有没有用

按钮 title 写的是「复制真实串流直链 (可直接在 PotPlayer / VLC 播放)」，但：

| 投送模式 | 复制的 URL | 外部播放器可用性 |
| :--- | :--- | :--- |
| proxy | `/api/strm/play/...&delivery=proxy` | **不可用**：需要本系统会话 Cookie，外部播放器没有 |
| redirect | `/api/strm/play/...` | 302 到签名 CDN 直链；但签名在解析时绑定了**客户端 UA**，外部播放器 UA 不同可能 403 |

结论：这个按钮当前的语义是"复制给我自己排障/自测"，而不是"复制给外部播放器"。建议二选一：

- **A. 明确语义**：改文案为「复制播放地址（本机自测）」，proxy 模式下加提示"该地址需登录态，外部播放器请切换为 302 直连"；
- **B. 提供外部可用链接**：新增一次性签名 token（`/api/strm/play/...?token=&exp=`，路由已有 `verifyStrmPlayToken` 能力），生成 10 分钟有效、免 Cookie 的直链，专供 PotPlayer/Infuse。

B 方案与既有 STRM 签名能力天然契合（`validatePlayToken` 已实现），但需要决定 token 的签发入口与权限。

### 4.5 风险

| 风险 | 说明 |
| :--- | :--- |
| `execCommand` 已废弃 | 仍被主流浏览器实现；若未来移除，则退化为方案 3（手动复制） |
| 剪贴板内容含内网地址 | 无敏感凭据，仅本机 URL；不记录到日志 |
| 一次性 token 泄露 | 需限时（≤10 min）、限 IP（可选）、限单文件 |

---

## 5. 设计模式落点

| 模式 | 落点 | 收益 |
| :--- | :--- | :--- |
| **适配器 Adapter** | `ClipboardAdapter`（clipboard → execCommand → 手动）；`FullscreenAdapter`（web/native 统一封装 `art.fullscreenWeb` / `art.fullscreen`） | 平台差异收敛到一处，UI 不再关心能力探测 |
| **策略 Strategy** | `SubtitleSelectionPolicy`（off/auto/always + 语言优先级） | 默认选轨可配置、可测试 |
| **状态机 State** | `PlayerUiState`：`inline → web-fullscreen → native-fullscreen`（与播放状态机正交）；`SubtitleLoadState`：`idle → loading → ready → error` | 避免"全屏样式与播放状态互相覆盖"（R3 的教训） |
| **观察者 Observer** | 订阅 `fullscreenWeb` / `subtitle` 事件驱动 UI，而非在点击处散落 DOM 操作 | 退出全屏（ESC/系统手势）也能正确清理 |

**不建议**：为这三个问题引入状态库；它们都是**局部 UI 能力**，用纯函数 + 适配器即可。

---

## 6. 可复用的库与基础设施

| 资产 | 类型 | 结论 |
| :--- | :--- | :--- |
| `art.fullscreenWeb` / `fullscreenWeb` 事件 | 已有（ArtPlayer 5.4） | **直接用**，无需 screenfull |
| `art.notice` | 已有（未使用） | 可用于「已复制 / 复制失败」轻提示 |
| `document.execCommand('copy')` | 浏览器内置 | HTTP 环境唯一可行路径 |
| `screenfull` | 第三方（~2 KB） | **不需要**：ArtPlayer 已封装全屏 |
| `clipboard-polyfill` | 第三方 | **不需要**：execCommand 兜底足够 |
| `player-shortcuts.ts` | 本仓库 | 加 `V` 键切字幕的落点 |
| `player_delivery_mode` 的存取模式 | 本仓库 | 账号级字幕偏好的模板（白名单 + Server Action） |

---

## 7. 实施计划

| 期 | 内容 | 成本 | 验收 |
| :--- | :--- | :--- | :--- |
| **P0** | 修全屏黑边（方案 A）+ 修复制链接（三级降级 + 反馈） | 0.5 天 | 全屏 `right === innerWidth`；HTTP 下复制成功且按钮变「已复制」 |
| **P1** | 控制条字幕按钮 + `V` 快捷键 | 0.5 天 | 一键关闭/切换；全屏可用 |
| **P2** | 账号级字幕偏好（off/auto/always + 语言） | 1 天 | 换集保持；设置页可改 |
| **P3**（可选） | 外部可用签名链接（token + exp） | 1 天 | 外部播放器可直接播放，10 min 后失效 |

### 验收断言（可直接并入现有脚本）

```js
// 全屏
await page.locator(".art-control-fullscreenWeb").click();
const gap = await page.evaluate(() => {
  const r = document.querySelector(".art-video-player").getBoundingClientRect();
  return Math.round(innerWidth - r.right);
});
expect(gap).toBe(0);

// 复制（HTTP 源）
await page.getByRole("button", { name: /复制链接/ }).click();
expect(await page.getByRole("button", { name: /已复制/ }).count()).toBe(1);
```

---

## 8. 附录：实测方法

```bash
# 全屏几何 + 剪贴板能力
BASE="http://<DEV_HOST>:3020" node test-results/probe-fullscreen.mjs
# 复制按钮失败复现
BASE="http://<DEV_HOST>:3020" node test-results/probe-copy.mjs
# 全屏下设置面板可达性
BASE="http://<DEV_HOST>:3020" node test-results/probe-fs-sub.mjs
```

三项探针均已落盘，可直接复跑；截图见 `test-results/browser-acceptance/probe-fullscreen-web.png`、`probe-fs-settings.png`。

---

## 9. 实施记录与实机验收（P0 + P1 + P2）

### 9.1 已实施

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| 全屏铺满 | `mediary-player-core.tsx` + `app/globals.css` | 监听 `fullscreenWeb` 事件给 `<html>` 加/去 `mediary-web-fullscreen`；CSS 隐藏根滚动条并用 `100vw/100vh` 兜底；卸载时清理类名 |
| 复制链接 | `features/player/clipboard.ts` + `mediary-player-modal.tsx` | 三级降级适配器（clipboard → execCommand → 手动面板）；按钮三态「复制链接 / 已复制 / 请手动复制」；按钮 title 按投送模式给出准确说明 |
| 手动复制兜底 | `components/manual-copy-panel.tsx` | 程序化复制全失败时展示只读输入框并自动全选 |
| 字幕一键控制 | `mediary-player-core.tsx` | 控制条右侧新增「字幕 <语言>」按钮，点击循环 关闭 → 各轨 → 关闭 |
| 字幕快捷键 | `player-shortcuts.ts` + `player-api.ts` | `V` 键切换；命令经 WeakMap 注册表调用，避免全局状态；提示条文案同步更新 |
| 字幕关闭修复 | `mediary-player-core.tsx` | ArtPlayer 的 `switch("")` 是空操作，改为显式清 `<track>` 的 src 与字幕层 |
| 字幕偏好记忆 | `subtitle-preference.ts` | localStorage 记录 `{mode, language}`；刷新/换集后按上次选择选轨；非法值一律回落默认 |
| 字幕控制器 | `subtitle-controller.ts` | 把「轨道装配 / 选轨 / 开关 / 编码 / 偏好 / 按钮文案」收敛为独立控制器；同时把核心组件从 604 行降到 572 行（600 行门禁） |

单测新增：`clipboard.test.ts`（3 例）、`subtitle-preference.test.ts`（8 例），播放器相关合计 69 例通过。

### 9.2 实机验收（开发实例 3020）

| 检查项 | 实测 | 结论 |
| :--- | :--- | :--- |
| 全屏右侧间隙 | `gap = 0`（修复前 15），播放器宽 1440 = 视口宽 | 通过 |
| 全屏类名 | 进入时 `<html>` 有 `mediary-web-fullscreen`、`overflow: hidden`；退出后移除 | 通过 |
| 复制链接 | HTTP 源（`isSecureContext=false`、`clipboard=undefined`）下点击后按钮变「已复制」 | 通过 |
| 字幕按钮 | 控制条出现「字幕 简体中文」 | 通过 |
| V 键循环 | 中文 → 英文 → 关闭（cue 归零）→ 中文 | 通过 |
| 偏好记忆 | 停在英文后刷新重开，默认仍为英文（cue 为英文文本） | 通过 |
| 控制台 | pageerror 0 / console error 0 | 通过 |

回归（同一实例）：五页巡检 + R3–R6 全 true；控制条 wrapper/controls/video 底部均 864、`object-fit: contain`；HUD 三档与分段文案通过；字幕专项（SRT 解析、语言识别、切轨、编码项）通过。

### 9.3 与方案的偏差

- **P2 改为设备级记忆**：方案原写「账号级 `subtitle_mode`」，本轮用 localStorage 实现设备级记忆（零后端改动、换集与刷新即生效）。账号级多设备同步留作后续，可与 `player_delivery_mode` 同构落地。
- **P3（外部可用签名链接）未做**：需要先决定 token 签发入口与权限，暂缓。
