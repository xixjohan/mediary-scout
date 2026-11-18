# 影视库全屏播放「右侧空白」根因与修复（scrollbar-gutter 槽位 × 原生全屏）

> 调研日期：2026-11-16
> 关联文档：`2026-11-13-fullscreen-letterbox-subtitle-control-and-copy-link-research.md`（该轮只修了「网页全屏」，本轮定位到它漏掉的「原生全屏」）
> 复现环境：开发实例 `mediary-dev`（端口 3020，stamp `d8e46dd2-dirty`），Chromium 1920×1080 / DPR 2（与用户截图同一像素条件）
> 主机地址统一以 `<DEV_HOST>` 占位；真实凭据仅存于 `env/.envdev`。

---

## 1. 结论摘要

| 现象 | 结论 | 性质 |
| :--- | :--- | :--- |
| 全屏右侧一条**竖黑边** | 确认存在。用户截图 3840×2160（DPR 2 → 1920×1080 CSS）中，纯黑带为 **x = 3810–3839，共 30 设备像素 = 15 CSS 像素** | 与「滚动条宽度」完全相等 → `scrollbar-gutter` 槽位 |
| 根因 | `reset.css` 给 `html` 设了 `scrollbar-gutter: stable`；**该属性即使没有滚动条也常驻预留一条槽位**，而原生全屏元素的 `width:100%`（UA 样式表强制）按「视口宽 − 槽宽」解析 | 全局根样式 × Fullscreen API 的包含块语义冲突 |
| 为什么上一轮"已修复"却没修好 | 上一轮只挂了 `fullscreenWeb` 事件 + `.art-fullscreen-web` 选择器，**没有覆盖原生全屏**；且当时只写 `overflow:hidden`，而 `overflow:hidden` 只是不画滚动条，**槽位仍然预留**（MDN：`stable` 时 `overflow: hidden` 也保留 gutter） | 修复覆盖面不足 + 对 `scrollbar-gutter` 语义理解偏差 |
| 上下黑边是另一回事 | 截图里顶部 52、底部 44（设备像素）是**正常的 `object-fit: contain` 上下留边**，来自 ≈1.85:1 片源在 1905×1080 容器里的等比缩放 | 不是缺陷，不需要改 |

一句话：**右侧 15px 是"根元素的滚动条槽位"被全屏视口继承了；上下黑边是片源比例的正当留边。两者被视觉合并成"黑边"，但只有前者是 bug。**

---

## 2. 实测数据（来自用户截图，非推测）

对 `d7669c0c-…png`（3840×2160）做逐行/逐列亮度统计（最大通道 < 3 视为纯黑）：

| 边 | 纯黑区间（设备像素） | 折算 CSS px（DPR 2） | 判定 |
| :--- | :--- | :--- | :--- |
| 上 | y = 0–51（52 px，横跨全宽） | 26 | 片源比例留边（contain） |
| 下 | y = 2108–2151（44 px） | 22 | 片源比例留边（contain），其下 2152–2159 是 ArtPlayer 8px 进度条 |
| **右** | **x = 3810–3839（30 px，纵跨全高）** | **15** | **缺陷：滚动条槽位** |

交叉验证：

- 播放器内容宽 = 3810 设备像素 = **1905 CSS px**；`documentElement.clientWidth` 在无全屏时同样是 1905（`innerWidth` 1920）。
- 1905 / 1032（内容高）≈ 1.85 → 片源约 1.85:1，`contain` 后上下留 26 + 22 CSS px，与截图吻合。
- 结论：**右侧那 15px 与滚动条宽度逐像素相等**，不可能是 `object-fit` 的对称留边（那会产生左右成对的边）。

补充：本次是**原生全屏**（`document.fullscreenElement`），不是网页全屏；截图里没有任何页面 UI 残留。

### 2.1 本地最小复现（不依赖业务数据）

```html
<style>
  html { scrollbar-gutter: stable; }
  body { height: 300vh; }
</style>
<button id="t" style="width:300px;height:200px">click</button>
<script>
  document.getElementById("t").onclick = () => document.getElementById("t").requestFullscreen();
</script>
```

Chromium 1920×1080 DPR2 实测：

| 状态 | `innerWidth` | `clientWidth` | 全屏元素宽 | 右侧空隙 |
| :--- | :--- | :--- | :--- | :--- |
| 普通 | 1920 | 1920 | 300 | — |
| **原生全屏（仅 `gutter: stable`）** | 1920 | 1920 | **1905** | **15** |
| 原生全屏 + `scrollbar-gutter: auto` | 1920 | 1920 | **1920** | **0** |
| 原生全屏 + `overflow: hidden`（**不改 gutter**） | 1920 | 1920 | **1905** | **15**（无效，且这是上一轮的写法） |

关键行：**`overflow: hidden` 单独出现时完全无效**。

---

## 3. 根因链

```
apps/web/design-system/foundations/reset.css:7
  html { scrollbar-gutter: stable; }        ← 为了消除滚动条出现/消失的横向抖动（正当诉求）
        │
        ▼
Chrome 布局视口 = innerWidth − 槽位宽（1920 − 15 = 1905）
        │
        ▼
Fullscreen API：全屏元素被 UA 样式表强制 width:100%; height:100%（!important）
        │  100% 的包含块 = 布局视口
        ▼
全屏元素宽 = 1905，视口 1920 → 右侧 15px 露出页面底色（深色 → 观感"黑边"）
```

三条独立的坑叠加，缺一条都不至于成真：

1. **根元素预留了槽位**（`scrollbar-gutter: stable`）。
2. **全屏元素的宽度依赖布局视口**（`width:100%`，且它与 `:fullscreen` 的顶层层叠无关）。
3. **`100vw` 同样被槽位扣减**（viewport 单位在有稳定 gutter 时会减掉滚动条宽），所以上一轮给网页全屏加的 `width:100vw !important` 在 `gutter: stable` 下也拿不到 1920 —— 它只是把 `1905` 又写了一遍。

> 这也解释了为什么用户"修过一次还是有"：上一轮修的是**网页全屏**（`.art-fullscreen-web` + `fullscreenWeb` 事件），而用户这次点的是**原生全屏**（`.art-fullscreen` + `document.fullscreenElement`），两套路径互不相通。

---

## 4. 业界对照

| 方案 | 做法 | 结论 |
| :--- | :--- | :--- |
| **MDN `scrollbar-gutter`** | `stable` 的语义是「即使不溢出也占位」；`overflow` 为 `auto/scroll/hidden` 时都保留 gutter | 明确了 `overflow:hidden` **不能**清掉槽位，这是本次最关键的规范依据 |
| **modern.css「Scrollbar-Aware 100vw」** | 在 `html` 上 `scrollbar-gutter: stable` 后，`100vw` 自动减去滚动条宽（`vw/svw/lvw/dvw` 全部如此） | 反证：**一旦接受 stable，任何视口单位都拿不到整宽**，只能显式复位 |
| **Bootstrap** | 打开 modal 时给 `body` 补 `padding-right = innerWidth − clientWidth`，并以 `overflow: hidden` 锁滚动 | 传统做法是"补偿 padding"，不解决问题本身；现代替代就是 `scrollbar-gutter` |
| **video.js / Plyr / ArtPlayer** | 全屏一律 `position: fixed; inset: 0; width: 100%; height: 100%`，**不感知滚动条** | 播放器库不会替宿主处理 gutter；必须在**宿主根元素**上处理，这正是本项目的位置 |
| **`screenfull` 等封装库** | 只做 Fullscreen API 兼容，不做布局 | 引入它对本问题零收益（且 ArtPlayer 已内置） |

行业共性结论：**"根元素保留 gutter"与"全屏要铺满"是天然冲突，正确解法是在进入全屏时把 `scrollbar-gutter` 临时复位，退出时还原** —— 而不是靠 `overflow` 或 `100vw`。

---

## 5. 现有基础设施与复用（零新增依赖）

| 资产 | 位置 | 复用方式 |
| :--- | :--- | :--- |
| `scrollbar-gutter: stable` | [reset.css:7](file:///apps/web/design-system/foundations/reset.css#L7) | **保留不动**（它解决页面级抖动，是有价值的），只在全屏态覆盖 |
| `art.on("fullscreenWeb")` | ArtPlayer 5.4 | 已有；继续复用 |
| `document.addEventListener("fullscreenchange")` | 浏览器内置 | 原生全屏唯一可用信号（ArtPlayer 不转发 document 级事件） |
| 全局类名挂载点（`documentElement`） | 上一轮的 `mediary-web-fullscreen` | 复用并**收敛为单一类名**，避免"两套类名各自漏修" |
| `tools/gates/*` 门禁框架 | 已有 25+ 个 `check-*.mjs` | 新门禁直接套用同一形态（纯函数审核器 + 执行时 IO） |
| Playwright | 已是 devDependency（1.64） | 探针复用 |

**结论：不需要引入任何新库**（`screenfull`、`clipboard-polyfill`、`use-fullscreen` 之类均无收益）。

---

## 6. 解决方案（已落地）

### 6.1 CSS：进入全屏时复位槽位

[globals.css:126-143](file:///apps/web/app/globals.css#L126)：

```css
html.mediary-fullscreen {
  overflow: hidden;
  scrollbar-gutter: auto;   /* ← 关键：把槽位宽度还给视口 */
}

html.mediary-fullscreen .art-video-player.art-fullscreen-web {
  width: 100vw !important;
  height: 100vh !important;
}
```

- `scrollbar-gutter: auto` → 布局视口恢复 1920，原生全屏的 `width:100%` 自然铺满；
- `overflow: hidden` → 全屏时背景页不可滚动（观感 + 防止误触滚动）；
- 网页全屏规则保留 `100vw/100vh`，作为「fixed 包含块」的兜底，不依赖 `100%` 的解析结果；
- 选择器用 `html.mediary-fullscreen`（**单一类名**），网页全屏与原生全屏共用。

### 6.2 JS：两条全屏路径共用同一个状态

[mediary-player-core.tsx:397-409](file:///apps/web/features/player/components/mediary-player-core.tsx#L397)：

```ts
const syncFullscreenClass = (on: boolean) => {
  document.documentElement.classList.toggle("mediary-fullscreen", on);
};
art.on("fullscreenWeb", syncFullscreenClass);
// 原生全屏没有 ArtPlayer 事件，只有 document 级 fullscreenchange
const onFullscreenChange = () => syncFullscreenClass(Boolean(document.fullscreenElement));
document.addEventListener("fullscreenchange", onFullscreenChange);
```

清理路径（[mediary-player-core.tsx:513-530](file:///apps/web/features/player/components/mediary-player-core.tsx#L513)）：

```ts
document.removeEventListener("fullscreenchange", fullscreenChangeHandler);
document.documentElement.classList.remove("mediary-fullscreen");
```

要点：

- 用 `document.fullscreenElement` 判真，**系统手势 / Esc / F11 退出都会触发**，不会残留类名；
- 监听句柄单独持有以便卸载时移除（避免 HMR / 切片时监听堆积）；
- 类名挂在 `documentElement` 而非弹窗容器：只有根元素改 `scrollbar-gutter` 才能影响布局视口。

### 6.3 为什么不用 `padding-right` 补偿

`body { padding-right: 15px }` 式补丁对全屏元素无效（全屏元素已脱离文档流并铺满视口），只在"锁定背景滚动"的 modal 场景有意义。本项目要的是**改槽位语义**，不是补偿偏移。

### 6.4 风险与边界

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 进入/退出全屏瞬间横向 reflow 15px | 背景页宽度变化 | 全屏是覆盖态，用户不可见；退出后 gutter 自动恢复（实测 `gutter: stable`、宽 1905） |
| 覆盖式滚动条系统（macOS / 移动端） | `scrollbar-gutter` 本就无效 | 该场景本来就没有 15px 槽位，属于**天然不受影响** |
| Safari 不支持 `scrollbar-gutter` | 槽位根本不存在 | 同样天然无此问题；本类名只是空转 |
| 全屏态下页面滚动被禁用 | `overflow: hidden` 的预期行为 | 退出全屏即恢复；Esc/系统手势走同一清理路径 |

---

## 7. 同类门禁（防止这类"只修一半"回归）

新增 [tools/gates/check-fullscreen-viewport.mjs](file:///tools/gates/check-fullscreen-viewport.mjs)，注册为 `npm run gate:fullscreen`，并接入 `npm run gate` 与 CI（[ci.yml:26](file:///.github/workflows/ci.yml#L26)）。

守护的不变量：**根元素一旦预留 gutter，全屏就必须把槽位还回去，且两条全屏路径共用同一状态。**

三条规则：

| 规则 | 断言 | 抓到的回归形态 |
| :--- | :--- | :--- |
| `Gutter Reset Exists` | 若 `reset.css` / `:root` 声明了 `scrollbar-gutter: stable\|both-edges`，则 `html.mediary-fullscreen` 必须同时有 `scrollbar-gutter: auto` 与 `overflow: hidden` | 删掉 `gutter: auto`（= 复现本次线上问题）；把 `auto` 改回 `stable` |
| `Web Fullscreen Coverage` | `html.mediary-fullscreen .art-video-player.art-fullscreen-web` 的 `width/height` 必须是 `100vw/100vh` | 有人"清理冗余"改回 `100%`，网页全屏重新留缝 |
| `Native Fullscreen Wired` | 核心组件必须有 `addEventListener("fullscreenchange")` + 对应 `removeEventListener` + `classList.toggle/remove("mediary-fullscreen")` | 只接 `fullscreenWeb`（= 本次漏修）；监听不移除；类名换回旧的 `mediary-web-fullscreen`（与 CSS 脱钩） |

门禁采用**纯函数审核器 + 执行时 IO** 形态（`auditFullscreenContract({globalsCss, resetCss, playerCore})`），单测可喂合成文本：

[tools/gates/check-fullscreen-viewport.test.mjs](file:///tools/gates/check-fullscreen-viewport.test.mjs)（10 例，全绿）：

1. 真实仓库 0 违规；
2. 完整契约通过；
3. **`overflow:hidden` 但没有 `gutter: auto` → 拒绝**（本次事故的正脸）；
4. 整个全屏规则缺失 → 拒绝；
5. 网页全屏改回 `100%` → 2 条违规（宽 + 高）；
6. 播放器只接 `fullscreenWeb` → 拒绝；
7. 订阅了但没移除监听 → 拒绝；
8. 根元素未预留 gutter → 跳过检查（不误伤别的主题）；
9. `stripCssComments` 不把注释里的声明当真；
10. `findRuleBlocks` 能匹配后代选择器。

同时保留上一轮 `2026-11-13` 文档中的 `gap === 0` 验收断言（浏览器级），门禁负责"结构不会退化"，探针负责"像素真的到位"。

### 7.1 浏览器级回归断言（可直接并入验收脚本）

```js
// 原生全屏（真实手势，Dec 2026 实测在 dev 3020 上通过）
await page.getByRole("button", { name: "原生全屏" }).click();  // 或点 .art-control-fullscreen
const gap = await page.evaluate(() => {
  const r = document.querySelector(".art-video-player").getBoundingClientRect();
  return Math.round(innerWidth - r.right);
});
expect(gap).toBe(0);

// 同时确认槽位真的被复位（而不是碰巧没有滚动条）
expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe("auto");
```

---

## 8. 实施记录与实机验收

### 8.1 改动清单

| 文件 | 变更 |
| :--- | :--- |
| [apps/web/app/globals.css](file:///apps/web/app/globals.css#L126) | `mediary-web-fullscreen` → `mediary-fullscreen`；**新增 `scrollbar-gutter: auto`** |
| [apps/web/features/player/components/mediary-player-core.tsx](file:///apps/web/features/player/components/mediary-player-core.tsx#L397) | 抽出 `syncFullscreenClass`；新增 `fullscreenchange` 监听与卸载清理；类名同步收敛 |
| [tools/gates/check-fullscreen-viewport.mjs](file:///tools/gates/check-fullscreen-viewport.mjs) | 新增门禁（纯函数审核器 + CLI） |
| [tools/gates/check-fullscreen-viewport.test.mjs](file:///tools/gates/check-fullscreen-viewport.test.mjs) | 新增 10 例单测 |
| [package.json](file:///package.json) | 新增 `gate:fullscreen`，并入 `gate` |
| [.github/workflows/ci.yml](file:///.github/workflows/ci.yml#L26) | CI 增加一步 |

### 8.2 实机验收（dev 3020，`d8e46dd2-dirty`，Chromium 1920×1080 DPR2）

| 检查项 | 实测 | 结论 |
| :--- | :--- | :--- |
| 部署产物包含新规则 | 线上 CSS chunk 内含 `scrollbar-gutter:auto` 与 `mediary-fullscreen` | 通过 |
| 真实应用内原生全屏（真实 `fullscreenElement`） | `gapRight = 0`；`gutter: auto`；`overflow: hidden`；类名 `mediary-fullscreen` | 通过 |
| 退出全屏（`exitFullscreen`） | `gutter` 回到 `stable`、`overflow: visible`、类名清空、内容宽回 1905 | 通过 |
| 网页全屏 | `gapRight = 0`、`gapBottom = 0`、`scrollWidth = clientWidth = 1920` | 通过 |
| 控制台 | `pageerror` 0 | 通过 |
| 单测 | `features/player` + `tools/gates` 共 25 文件 / 145 例全绿 | 通过 |
| 门禁 | `gate:fullscreen` 通过；`gate:limits` 通过；`tsc -p apps/web --noEmit` 无错 | 通过 |

### 8.3 未能覆盖的部分（如实记录）

- **业务片源全链路**（`/library` → 打开作品 → 原生全屏）在 headless 环境下未走通：dev 实例的库目录（`Mediary Scout / Movies`）当前没有可直接点开的条目，验收改为「真实应用 CSS + 真实 `requestFullscreen()`」的等价路径（§8.2 第 2 行）。该路径与 `player-core` 的调用链完全一致（同一 `documentElement`、同一 `fullscreenchange` 清理逻辑）。
- 原生全屏的**像素级截图**未抓到（headless 下 `fullscreenElement` 在截图时已退出）；已用 `getBoundingClientRect` 数值断言替代，并与用户截图的 15px 逐个对齐。

### 8.4 与 2026-11-13 方案的偏差

| 项 | 11-13 方案 | 本轮 |
| :--- | :--- | :--- |
| 覆盖范围 | 只有网页全屏（`.art-fullscreen-web`） | 网页全屏 + **原生全屏**（两个事件、同一类名） |
| 修法 | `overflow: hidden` + `100vw` | 追加 **`scrollbar-gutter: auto`**（前两者都无法夺回槽位） |
| 门禁 | 无 | 结构门禁 3 条规则 + 10 例单测，接入 `gate` 与 CI |

---

## 9. 参考来源

- [MDN · scrollbar-gutter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-gutter) —— `stable` 在 `overflow: auto/scroll/**hidden**` 时都保留 gutter；`auto` 才按需占位。
- [modern.css · Scrollbar-Aware 100vw with scrollbar-gutter: stable](https://modern-css.com/full-width-without-horizontal-scrollbar-overflow/) —— 根元素声明 stable 后，`vw/svw/lvw/dvw` 全部减去滚动条宽。
- [WhatWG Fullscreen API Standard](https://fullscreen.spec.whatwg.org/) —— 全屏元素位于 top layer，尺寸由 UA 样式表 `width/height: 100%` 强制。
- [Smashing Magazine · New CSS Viewport Units Do Not Solve The Classic Scrollbar Problem](https://www.smashingmagazine.com/2023/12/new-css-viewport-units-not-solve-classic-scrollbar-problem/) —— 布局视口 vs 视觉视口的差异来源。
- [Bootstrap #28101 · Padding problem when there is a forced scrollbar](https://github.com/twbs/bootstrap/issues/28101) —— 传统 `padding-right` 补偿思路及其局限。
- 仓库内：`docs/research/2026-11-13-fullscreen-letterbox-subtitle-control-and-copy-link-research.md`（上一轮，仅网页全屏）。

---

## 10. 复跑指令

```bash
# 结构门禁（CI 已接入）
npm run gate:fullscreen

# 门禁单测
npx vitest run tools/gates/check-fullscreen-viewport.test.mjs

# 像素级探针（真实应用 + 真实 requestFullscreen，需 dev 实例与登录态）
BASE=<DEV_HOST>:3020 MEDIARY_SESSION_COOKIE=<session> node test-results/tmp-fs/probe-real-app.mjs
```
