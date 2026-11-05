# 移动端布局问题调研与优化方案

日期：2026-11-05。范围：截图中的搜索/发现页及其共用页面框架；文档记录调研结论和已实施的布局修复。

## 现象与证据

截图中桌面侧栏占据手机屏幕大部分宽度，右侧搜索内容被挤成窄列，标题和筛选项逐字换行，部分内容超出屏幕。图片不能证明实际 CSS 视口宽度、缩放比例或浏览器设置，需要登录后的真机和开发者工具确认。

源码存在可直接解释该现象的层叠冲突：`apps/web/app/globals.css` 在文件开头导入 `features/catalog/styles/catalog-search.css`；后者在 `max-width: 860px` 为 `.app-shell` 设置 `grid-template-columns: minmax(0, 1fr)`，并将 `.sidebar` 改为横向顶栏。导入之后，`globals.css` 又以相同选择器定义 `.app-shell { grid-template-columns: 264px 1fr }` 和 `.sidebar { flex-direction: column; position: sticky; height: calc(100vh - 16px) }`。当断点命中时，这些后出现、同等优先级的桌面声明仍会覆盖对应移动端声明。其他没有被后续规则覆盖的移动样式仍可能生效，因此不能仅凭截图断言整个移动样式文件未加载。

此外需核实页面实际输出的 viewport meta、`window.innerWidth`、`visualViewport.width`、设备缩放和 CSS 缓存版本。缺少 viewport meta 可能使手机以较宽的布局视口渲染，但目前没有证据证明它是本次原因。[MDN 视口说明](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Viewport)

## 系统已有能力

- 共用框架：`apps/web/components/layout/app-sidebar.tsx`、`apps/web/app/globals.css`；根页面、网盘工作区、设置及存储等页面共用 `.app-shell`，修改须跨页面验收。
- 已有移动设计：`catalog-search.css` 的 860px 断点包含单列框架、顶栏、固定底部导航、安全区、工作区切换及账户入口；`activity-queue.css` 还有 376px 窄屏规则。优先修正层叠顺序并复用这些规则。
- 设计系统：`apps/web/design-system/` 已有颜色、排版、控件 token；图标使用 `lucide-react`。搜索发现卡片已有懒加载与网格样式。
- 质量基础：仓库使用 Playwright、Vitest 和 `tools/gates/check-layout.mjs`；当前静态布局门禁不能证明 CSS 在真实视口的计算结果。已有 Next.js Server Components、Suspense，无需为了响应式布局添加客户端状态库。
- 依赖清单未见 Radix UI、Tailwind、MUI 作为直接依赖；不要依赖偶然存在的传递依赖。

## 参考与取舍

| 方案 | 适用范围及取舍 |
| --- | --- |
| 原生 CSS Grid/Flex 与媒体查询 | 本项目已有实现；优先保证样式顺序与组件最小宽度，单列容器使用 `minmax(0, 1fr)`，内容子项按需 `min-width: 0`。断点按内容破裂点验证。[MDN 响应式布局](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design) |
| Radix Dialog | 若筛选器或导航改成模态抽屉，可借鉴焦点约束、Escape、标题描述及焦点恢复；已有简单布局修复不必新增库。[Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) |
| 触控与键盘 | 导航应保持语义和可见焦点，推荐约 48 CSS px 触控目标，并检查视觉顺序与键盘顺序一致。[web.dev 可访问响应式设计](https://web.dev/articles/accessible-responsive-design) |
| 图片与渲染 | 海报设置稳定比例，视具体屏幕选择合适尺寸；首屏关键图避免盲目懒加载，屏外图片延迟加载，测量后再采用 `content-visibility`。[Chrome 图片与性能指导](https://developer.chrome.com/docs/modern-web-guidance/guides/performance/performance) |

## 具体实施方案

1. **修复层叠根因**：把框架的桌面和移动规则集中到独立的 shell 样式文件，并安排在全局基础样式之后统一导入；或将对应断点规则放到桌面声明之后。确保 `.app-shell` 与 `.sidebar` 的移动覆盖在计算样式中实际生效，避免通过堆叠 `!important` 掩盖顺序问题。对影响其他组件的导入顺序逐项核对。
2. **构建手机信息层级**：沿用现有顶栏与底部导航；顶栏保留品牌、网盘选择和账户入口，必要时缩短文字；底部留出安全区和内容间距。搜索框与按钮在窄屏可换行，筛选项支持有明确提示的横向滚动或折叠，推荐海报随宽度调整列数。页面整体不得横向溢出。
3. **保证交互**：账户及网盘菜单可触控、可键盘操作，滚动时不被底栏遮挡；筛选和搜索保留当前 URL、网盘上下文、忙碌及错误反馈。若引入抽屉，仅为真正的模态交互管理 `closed/open`、焦点恢复与 Escape；不为静态断点引入状态机。
4. **性能与稳定性**：仅用 CSS 响应布局，避免按宽度在服务端和客户端输出不同 DOM 导致水合不一致；控制阴影、模糊和动画成本，尊重 `prefers-reduced-motion`。测量 LCP、CLS、INP 与资源体积后决定图片或渲染优化，不以猜测设置性能承诺。
5. **模式边界**：共享 shell 和设计 token 提供复用；网盘数据适配器仍负责后端差异，布局不需要新 Adapter。只有出现多套真实交互策略时再抽 Strategy；导航抽屉的少量状态可用 React 状态，复杂异步流程再考虑 FSM。

## 回归门禁和验收

- Playwright 使用真实页面计算样式，在 320、375、390、430、768、860、861 和桌面宽度检查 shell 的网格列、侧栏方向及可见导航；同时检查 `document.documentElement.scrollWidth <= clientWidth`（允许浏览器舍入 1px），对预期内部横向滚动区单独断言。
- 根页面及 `/w/:storageId` 搜索/发现、设置、存储、详情页在登录态覆盖；验证不同网盘和长账户名、长标题、空结果、错误、加载状态。检查搜索、筛选、网盘切换、导航和返回后的 URL/焦点。
- 检查 200% 文本缩放、横屏、安全区、触控目标、Tab 顺序、Escape、底部内容无遮挡；至少覆盖 Chromium 手机模拟、WebKit 和 Android 真机。对模态层补充焦点约束与关闭恢复测试。
- 检查控制台未捕获错误和水合错误，比较桌面布局前后；在同设备网络条件下记录首屏及交互性能基线。使用截图辅助人工检查，行为与计算样式断言作为主要门禁。
- 当前未执行登录态页面复现或性能采样；上线前必须用目标环境确认计算样式和手机显示，避免把源码推断当作实测。

## 实施结果（2026-11-05）

- 将共用框架 CSS 从 `globals.css` 拆到 `apps/web/components/layout/app-shell.css`，并在各功能样式之后加载。移动端使用单列、横向顶栏、固定底部导航和安全区留白；桌面双列侧栏仅在 861px 及以上启用。
- 480px 以下收窄品牌、网盘选择和账户信息；390px 以下进一步截短品牌/用户名，360px 以下隐藏顶栏用户名，避免长用户名挤出视口。
- 在本地 Next.js 页面加载实际样式表，并用代表性页面结构检查 320、360、375、390、430、480、768、860、861 和 1365px。检查结果为断点方向正确、长用户名顶栏内容在框内、搜索按钮可见，文档宽度未超出可用视口；发现页海报网格从窄屏 1–2 列扩展到桌面 6 列。
- 样式 token 门禁通过。布局门禁的 globals.css 行数约束已通过，但整个门禁仍报告仓库已有的 `.codex-remote-attachments/` 和 `.worker_secret`，本次未修改这些现存项目。登录态真实页面与真机检查仍需后续完成。
