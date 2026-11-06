# 助手工作台与相似页面响应式体验调研

**项目**：Mediary Scout

**日期**：2026-11-06

**范围**：/chat 助手工作台、相似的多栏/高密度业务页面、可复用前端设施、库选型与回归门禁

**性质**：源码调研与设计建议；第 10 节记录本轮执行结果与验证数据

## 1. 结论摘要

助手页需要优化。截图中会话历史与聊天内容在窄屏仍并排显示，聊天区域被压窄，标题旁的 MCP 工具按钮挤占空间，消息区出现横向滚动条。源码证据与现象相符：全局 App Shell 有 860px 断点，但助手工作区样式没有任何媒体断点；会话侧栏固定 260px 且不可收缩，聊天主体与消息内容缺少完整的最小宽度约束。

这首先是布局信息架构和 CSS 固有尺寸问题，适合用原生 CSS Grid/Flex、媒体/容器查询和少量抽屉开关修复。为此不需要引入通用 UI 框架。建议宽屏保留历史列表与聊天并排，中等宽度收起历史列表并由抽屉打开，手机以聊天为主视图、历史作为模态抽屉。窄屏阈值应按扣除全局导航后的实际可用宽度确定；1200px 可作为初始检查点，而不是未经验收的硬编码结论。

本系统还有可分阶段处理的消息加载和交互状态问题：会话列表/单会话消息接口未分页，历史消息选择后全量加载，每次发送又把全部消息重新发给服务端；聊天 API 当前在 Agent 完成后一次返回 JSON，并非已落地的 SSE 流式传输。它们与截图中的 CSS 缩窄不是同一根因，应分开排期。

## 关键概念

- **响应式信息架构**：窄屏改变“哪些面板同时可见”，不只是压缩桌面双栏的宽度。
- **页面溢出与局部滚动**：根页面不能横向滚动；代码块、表格等明确的内容容器可以保留自己的横向滚动。
- **视口查询与容器查询**：媒体查询切换整页/工作台结构；容器查询可让受全局导航挤压的子面板按自身实际宽度适配。
- **布局状态与请求状态**：断点属于 CSS 布局决策；抽屉开关、加载、生成、取消和错误才是交互状态。

## 2. 截图现象与源码根因

### 2.1 可见现象

- 历史会话与聊天面板占用同一行；空历史区在手机上仍占据接近一半宽度。
- 消息气泡被压成窄列；标题、MCP 工具编排按钮和状态标签发生挤压/遮挡。
- 消息区底部出现横向滚动条，快捷指令和输入框也变得拥挤。
- 全局移动导航仍可见，因此问题更像助手功能内部未响应式降级，而不是全局侧栏断点完全失效。

截图无法单独证明 CSS 视口宽度、缩放倍率或 DPR；本判断由截图线索和源码结构共同支持。

### 2.2 直接证据

| 位置 | 现状 | 影响 |
|---|---|---|
| apps/web/components/layout/app-shell.css:154-168 | 全局 Shell 在 861px 及以上使用 264px 应用侧栏；较窄视口切到单列框架 | 聊天可用宽度还要扣除应用导航、页面留白和底部导航 |
| apps/web/features/assistant/styles/assistant-chat.css:5-22 | 聊天主区使用 100vh 固定计算高度；工作区保持横向 flex；会话栏固定 260px 且 flex-shrink:0 | 在 Shell 已缩窄的情况下，历史栏继续占据固定宽度 |
| 同文件:267-288 | 聊天面板为 flex:1 且 overflow:hidden；header 左右两组内容并排，内部收缩依赖默认固有尺寸 | 外层会裁切内容，头部控件和消息子项仍可能争宽或在内部形成横向溢出 |
| 同文件:343-400 | 消息列表仅约束纵向滚动；消息 row 仅限制 max-width；内容列没有 min-width:0 | 长文本、宽卡片或 flex 子项可能撑开消息区；不能用全局 overflow:hidden 遮住 |
| 同文件:482-510 | 快捷指令可换行，但 textarea 是 flex 子项且没有 min-width:0 | 极窄输入栏仍可能被 textarea 的固有尺寸挤压 |
| 整个 assistant-chat.css | 源码未找到 @media 规则 | 助手布局没有跟随全局窄屏状态切换的规则 |
| chat-workspace.tsx:19,123-132 | 已有 isCollapsed 状态和收起/展开按钮，但收起由用户手动触发 | 可复用部分交互能力；没有按视口自动采用抽屉/单栏体验 |

MDN 对 flex/grid 子项的自动最小尺寸说明：min-width:auto 可能使用 min-content 尺寸，导致子项拒绝收缩；这与当前聊天面板缺少 min-width:0 的链路相符。应在真正需要收缩的每一层容器上设置 min-width:0 / min-inline-size:0，并约束具体内容，而不是把整页横向溢出一概隐藏。[MDN：min-width](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/min-width)

代码块和 Markdown 表格已有局部 overflow-x:auto（assistant-chat.css:952-970）。这些内容应继续在自己的滚动容器内查看；回归门禁只应禁止页面级横向溢出。

### 2.3 伴随的交互与性能风险

- ChatSidebar 初始会话列表为空，同时异步拉取列表；没有明确的 loading/error 状态，空状态可能先于请求结果出现，失败也被静默处理（chat-workspace.tsx:19-36）。
- 切换会话时全量加载消息；加载失败后显示欢迎消息，无法分辨“空对话”和“加载失败”（chat-panel.tsx:83-119）。
- 每次发送都会把当前全部消息重新序列化并提交，历史越长单次请求体越大；多轮累计传输量会随会话增长明显上升（chat-panel.tsx:150-163）。
- 消息视图对完整数组逐项渲染，没有分页/虚拟化（chat-panel.tsx:283-297）。目前没有基准证明需要立即引入虚拟列表；长会话性能应先量化。
- 会话列表 API 和单会话消息 API 当前均返回未分页结果（apps/web/app/api/chat/conversations/route.ts:15-16；apps/web/app/api/chat/conversations/[id]/route.ts:24-25）。
- 会话列表行用 li role="button" 包含重命名/删除按钮（chat-sidebar.tsx:127-131, 186-201）。后续布局重构应顺带整理为语义正确的主按钮与独立操作按钮，避免嵌套交互语义。

## 3. 系统已有基础设施与相似页面范围

### 3.1 可复用的系统能力

- **框架**：React 19、Next.js 16、TypeScript；根 Shell 以 CSS Grid 实现，移动断点已在 app-shell.css 和 catalog-search.css 中落地。
- **样式**：Design Tokens 在 apps/web/design-system/；图标使用 lucide-react；助手 CSS 已按 Feature 分文件，通过 globals.css 引入。
- **助手组件**：ChatWorkspace、ChatSidebar、ChatPanel 已分层；URL 查询参数保存当前会话；ChatPanel 已有历史加载、busy、MCP 抽屉、快捷指令和消息卡片。
- **现有抽屉/对话框**：McpServerDrawer 是助手内的自定义 Portal；AppConfirmDialog 是确认对话框。目前没有通用 Drawer 原语，MCP Drawer 不应未经检查就当作完整、可访问的通用历史抽屉。
- **AI 基础**：根 package.json 有 ai 6.x 与 @ai-sdk/openai-compatible；未找到 @ai-sdk/react、assistant-ui、Radix Dialog 或 @tanstack/react-virtual 的直接声明/助手 UI 使用。
- **状态机依赖**：xstate 由 packages/workflow 声明，但当前源码搜索没有找到 xstate 导入；它不是 apps/web 已复用的助手状态设施。简单历史抽屉不值得为此加一层依赖。
- **质量工具**：Playwright、Vitest 已安装；当前 tests/e2e 只有桌面 Chromium 项目和搜索/获取链路，没有助手窄屏 E2E。gate:layout 检查工作区结构和文件长度，不计算浏览器实际溢出。

### 3.2 页面清单与后续优先级

| 路由/页面组 | 源码现状 | 建议 |
|---|---|---|
| /chat 助手 | 无助手 CSS 断点；历史栏固定 260px；聊天和消息内容缺少收缩约束 | **P0**：本次设计方案主目标 |
| /storage 网盘浏览 | storage-explorer.css 搜索框和内容区存在 240px 最小宽度；未发现该文件内媒体断点；文件表格有独立区域 | **P1**：下一个优先实机核查；小屏应决定使用卡片化行或局部表格横向滚动 |
| / 与 ?tab=library | catalog-search.css 有 1080px、860px 等断点，已经处理筛选/网格重排 | **P1 回归**：在长标题、筛选组合和窄宽度下守住现有行为，不需先重做 |
| /activity | activity-queue.css 有 860px、376px、360px 规则 | **P1 回归**：保留任务队列与卡片窄屏布局 |
| /settings | settings-panel.css 有 860px 规则、横向滚动标签和自适应卡片网格 | **P1 回归**：确认当前选中标签可见、键盘滚动可达 |
| /storage/strm | strm.css 有 600px 断点 | **P2 回归**：确认任务卡片、表单和底部导航不互相遮挡 |
| /notifications | notifications.css 有 max-width 容器与标题截断，但未发现该文件内媒体断点 | **P2 检查**：覆盖长通知标题和多个状态徽标 |
| /show/[tmdbId] | title-hub.css 有 860px 规则 | **P2 回归**：验证详情面板/集数区的窄屏重排 |
| Agent 记忆时间线（设置/活动复用） | agent-memory-timeline.css 有 860/720/420px 与触控/减弱动画规则 | **已有基础**：仅在全页回归发现问题时修补 |

当前 App Router 只有一个聊天页面 /chat；以上页面是相似的高密度、多栏或主从列表工作台，并非多个独立助手页。全站可以系统性提升，但不应强制所有页面用一种布局：聊天/文件浏览主从关系应在窄屏转为单视图或抽屉；表单设置应重排；表格可以在有限区域内横滚。

## 4. 业界方案与依赖对比

| 方案 | 能力与适用面 | 本项目现状/成本 | 建议 |
|---|---|---|---|
| 原生 CSS Grid/Flex + media/container queries | 响应布局、按容器可用宽度调整卡片；无需 JS 监听视口 | 项目已有 CSS 特性文件、断点和 Design Tokens | **现在采用**。大结构用媒体查询；组件宽度受全局导航挤压时可评估容器查询。[MDN：Container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries) |
| Vercel AI SDK UI useChat | 官方 React UI hook 处理消息、submitted/streaming/ready/error、停止、重试、事件和更新节流；配套服务端 UI Message Stream | 现有 ai 核心包存在，但 React hook 包未直接安装；当前 route.ts 在 await handleChatTurn 后 NextResponse.json，一次性返回结果（:106-129），没有 SSE/UI stream | **性能第二阶段候选**。能改善首字可见和取消体验，但不是布局修复；迁移需为持久化消息、thinking/toolsUsed/actionCard 建立明确的流消息适配层。[Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)、[useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)、[持久化指南](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence) |
| assistant-ui primitives | 无样式的可访问 Thread/Message/Composer 原语，提供状态、快捷键、自动滚动、流式与工具调用接线 | 未安装；现有会话持久化、工具结果卡片、MCP 与服务端 Agent 已按 Mediary 业务定制；整体接入有适配/迁移成本 | **作为重构参考，不为窄屏修复引入**。若未来重写聊天交互而非只调布局，再进行成本 spike。[Primitives](https://www.assistant-ui.com/docs/primitives) |
| Radix Dialog / WAI-ARIA Dialog Pattern | 对话框模态、焦点约束、Escape 关闭、焦点返回和屏幕阅读器标注 | Radix 不在直接依赖中；项目有自定义 Portal 和确认框 | **按需**。历史抽屉如实现成模态层，必须满足焦点进入/限制/返回、Escape 和可见关闭按钮；若多个功能都需要通用抽屉，再评估添加原语库。[Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog)、[W3C APG](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) |
| OpenAI ChatKit | 可嵌入聊天、工具/组件、服务端集成；适合以 ChatKit 为核心构建新聊天产品 | 本系统是多模型/兼容接口、内置多网盘工具和定制 SQLite 消息卡片；引入要对接 ChatKit Server/消息模型并承担迁移 | **不建议本次采用**：问题是现有页面响应式布局，不需要替换聊天运行时。[ChatKit](https://developers.openai.com/api/docs/guides/chatkit) |
| XState | 显式异步状态机与事件转移 | 仅 workflow workspace 声明，未找到现有源码使用 | 抽屉只需 open/closed 状态；流式/取消/工具审批组合变复杂时先用 useReducer/discriminated union，确有复杂转移、恢复和并行任务后再评估 XState。 |

## 5. 具体设计建议

### 5.1 布局策略

| 可用视口宽度 | 助手布局建议 | 说明 |
|---|---|---|
| 初始建议 ≥1200px | 历史侧栏 + 聊天主面板并排 | 可先将历史栏宽度设为 240–280px，并保持可手动收起；1200 是初始实测阈值，须按 264px 全局侧栏和头部控件宽度验证 |
| 861–1199px | 默认显示完整聊天；历史列表通过非阻塞的侧向抽屉打开 | 全局导航仍占 264px，不能只用 window 宽度假设内容空间充足 |
| ≤860px | 聊天全宽单栏；历史会话使用全高/近全高抽屉 | 与移动 App Shell 导航模式一致；选中会话/新建后自动关闭抽屉 |

建议在 CSS 决定主要视口布局，避免在服务器与客户端按 window.innerWidth 渲染不同 DOM。只有抽屉的 open/closed 是交互状态。若要处理“桌面主区很窄但视口仍宽”的情况，可先用容器查询增强子组件适配；不要一开始引入面板布局库。

### 5.2 具体 UI 约束

1. **补齐收缩链路**：对 workspace、chat container、message row、message content、header 分组、composer textarea 等实际 flex/grid 子项设置 min-width:0/min-inline-size:0；文本使用可换行规则。每一层确认自己的滚动责任。
2. **头部重排**：MCP 工具按钮和模式状态在中小宽度换行/折叠为操作菜单；避免继续用无布局类的内联 flex 固定在同一行。按钮触控热区以约 44 CSS px 为目标。
3. **聊天内容**：气泡最大宽度相对消息列表并设上限；宽表格/代码块仍局部滚动；工具调用和媒体卡片按单列收缩。
4. **历史抽屉**：复用现有 ChatSidebar 内容与对话 CRUD；移动端打开时遮罩/模态语义明确，关闭、Esc、选择会话、新建后都能正确回到主视图；焦点关闭后返回触发按钮。
5. **可视高度与导航**：把目前 100vh 固定高度改为尊重动态视口的容器高度方案，同时按实际 App Shell 顶栏、底部导航和 safe-area-inset 计算可用区；消息列表是主要纵向滚动区，composer 留在聊天面板底部。不能盲目把全页 overflow:hidden 来掩盖计算错误。
6. **加载/失败状态**：区分会话列表的 loading、空、ready、error；历史详情失败时显示重试入口，不伪装成新会话。忙碌时明确禁用重复发送并保留用户输入/可恢复状态。
7. **可访问结构**：把会话行主体和行尾操作拆成兄弟交互元素，提供 aria-current/label；控制顺序与视觉顺序一致。WAI-ARIA 模态规范要求焦点进入对话框、Tab 留在对话框、Escape 关闭并在关闭后恢复焦点。

### 5.3 模式应用边界

- **适配器**：现有模型服务/Provider 和持久化消息对象与 UI 类型转换是适配器的合理边界。若下一阶段接入 AI SDK stream，应把 AI SDK UIMessage/data parts 映射到当前 thinking、toolsUsed、actionCard 和 Conversation Repository；不要把 CSS 断点抽成 Adapter。
- **策略**：现有 Provider、媒体解析和搜索降级可按业务选择策略。响应式布局应由 CSS 根据视口/容器尺寸决定，不需要 DesktopStrategy/MobileStrategy 运行时对象。
- **状态机**：仅抽屉用布尔值或小型 reducer 即可；若流式改造引入 submitted、streaming、tool-running、awaiting-confirmation、cancelled、error、resume 等状态，再以显式枚举/Reducer 表达转移。满足跨会话竞态、恢复和并行工具调用复杂度后才引入 XState。
- **虚拟列表**：先采样 50/200/500 条消息下的 DOM 数量、滚动帧率和内存；超过产品阈值且实测回归后再选择 @tanstack/react-virtual 等库。虚拟化对动态高度 Markdown、滚动锚点、屏幕阅读器和复制操作都有成本。

## 6. 分阶段推进顺序

### 阶段 A：助手窄屏修复（P0）

- 先加最小浏览器回归测试，再调整聊天布局和消息内容收缩链路。
- 增加独立的历史抽屉开关状态，保留桌面原有手动收起能力。
- 按 1200/861 两个布局边界验证 MCP 按钮、状态、短/长标题和输入框。
- 维持现有 API 与消息卡片行为；本阶段不引入聊天 UI 库、不改 Agent 运行时。

### 阶段 B：状态与可访问性（P1）

- 补 loading/empty/error 状态并修复会话行嵌套交互语义。
- 验证键盘、触屏、Esc、焦点恢复和底部导航 safe area。
- 为长标题、Markdown 表格/代码、工具/媒体卡片、网络失败和历史切换补浏览器覆盖。

### 阶段 C：规模与首字延迟（P2，基于测量）

- 记录会话列表数量、每会话消息数、首字延迟、完整响应耗时、请求 payload 大小和长会话滚动指标。
- 会话列表/消息达到真实瓶颈后再做游标分页或增量加载；模型上下文采用“持久化全量 + 请求使用最近 N 条/摘要”的双层策略，不能直接丢弃历史记录。
- 若需流式体验，评估现有 AI SDK v6 + 新增兼容的 React UI 包，先完成服务端持久化边界和工具/写操作确认门禁，再以小范围流式 spike 验证首字延迟及断线恢复。
- 只有长会话基准显著退化时才引入虚拟列表。

### 阶段 D：相似页面回归与按风险修复（P1/P2）

- 先对 /storage 做实机/Playwright 测量，决定窄屏是卡片列表还是表格内横滚；随后回归 /、/activity、/settings、/storage/strm、/notifications、/show。
- 共用 Shell 和断点作为一致性基准，各 Feature 保留符合自身信息结构的呈现策略。
- 单页实测不通过再修单页，不批量覆盖所有页面，也不新增一个全局“隐藏横向溢出”规则。

## 7. 回归门禁与验收标准

现有 Playwright 和 E2E runner 可复用；当前 e2e 配置仅桌面 Chromium，测试集未覆盖 /chat。gate:layout 是源文件/工作区结构门禁，不能代替真实视口计算。建议新增一条专门的 Playwright 助手响应式 E2E，用当前确定性 fake 环境和测试账号：

1. **视口矩阵**：320×640、375×812、390×844、430×932、768×1024、860×900、861×900、1024×768、1200×900、1365×900。Playwright 支持设置 viewport/device emulation；移动软键盘遮挡仍需至少一个真实手机抽查。[Playwright：Emulation](https://playwright.dev/docs/emulation)
2. **页面级无溢出**：documentElement.scrollWidth 不超过 clientWidth 1px 容差。代码块和 Markdown 表格允许各自局部横向滚动，不允许根页面/整个聊天面板出现横向条。
3. **布局行为**：≥1200px 历史栏和聊天并排；861–1199px / ≤860px 历史列表不挤压聊天；触发器可打开抽屉，选择会话/新建/Esc/遮罩关闭都恢复聊天主视图。
4. **尺寸与可见性**：MCP/状态控件不得与标题重叠；气泡/卡片边界在消息区内；composer 和发送按钮始终可见，虚拟键盘弹出时不被底部导航盖住。
5. **状态场景**：无历史、会话加载中、历史加载失败可重试、长会话、用户/助手消息、Markdown 表格/超长 URL/代码块、媒体/工具卡片、busy/错误。
6. **可访问性**：键盘 Tab 顺序；Enter/Shift+Enter；抽屉聚焦进入与返回、Esc 关闭；按钮 accessible name；200% 文本放大与横屏。
7. **运行时红线**：无 pageerror、无 hydration failure、无未处理请求/重复提交；API 功能行为与现有会话 URL 参数和消息持久化保持一致。

性能门禁先记录基线，不设未经真实数据支持的毫秒承诺：首屏、会话切换、首字/完整响应、50/200/500 消息滚动，分别报告 p50/p95。视觉截图用于人工审查；可重复的尺寸、滚动、焦点和文本断言作为 CI 主门禁。

## 8. 文件索引

| 文件 | 用途 |
|---|---|
| apps/web/app/chat/page.tsx | /chat App Router 页面与 App Shell 装配 |
| apps/web/features/assistant/components/chat-workspace.tsx | 会话列表、激活会话、URL 与历史抽屉状态入口 |
| apps/web/features/assistant/components/chat-sidebar.tsx | 新建/切换/重命名/删除会话 |
| apps/web/features/assistant/components/chat-panel.tsx | 消息加载/提交、滚动、header、快捷指令和 composer |
| apps/web/features/assistant/styles/assistant-chat.css | 助手工作台与消息气泡样式；当前未含媒体断点 |
| apps/web/app/api/chat/route.ts | 对话请求，当前等待 handleChatTurn 后返回 JSON |
| apps/web/app/api/chat/conversations/route.ts | 会话列表/创建 API |
| apps/web/app/api/chat/conversations/[id]/route.ts | 单会话消息全量读取与 CRUD |
| apps/web/components/layout/app-shell.css | 共用 Shell、861px 桌面断点与主内容尺寸 |
| apps/web/features/storage-drives/styles/storage-explorer.css | 下一优先级网盘文件浏览布局 |
| apps/web/features/catalog/styles/catalog-search.css | 首页搜索/发现布局及移动 Shell 规则 |
| apps/web/features/activity/styles/activity-queue.css | 活动任务队列与窄屏规则 |
| apps/web/features/settings-system/styles/settings-panel.css | 设置标签和面板窄屏规则 |
| tests/e2e/playwright.config.ts | Playwright E2E 浏览器配置；当前 Chromium 基线 |
| tools/gates/check-layout.mjs | 仓库结构门禁，不是浏览器响应式门禁 |

## 9. 相关文档与外部资料

### 仓库内

- [移动端布局问题调研与优化方案](mobile-responsive-layout-investigation-2026-11-05.md) — 已修复共用 App Shell/search 的问题；本报告补查助手功能及其他相似页面。
- [智能对话助理与详情页综合优化方案设计](../architecture/chat-agent-and-smart-assistant-design.md) — 已有 Agent 适配器/策略/FSM 设计；其中“/api/chat 为 SSE”和 800ms TTFT 是目标描述，不是当前运行时事实。
- [智能助理增强体系与 React Hydration 异常根治设计方案](../postmortems/chat-advanced-features-and-hydration-fix.md) — 已实现消息卡片/Markdown 等聊天能力背景。
- [智能对话助理会话持久化与管理架构方案](../architecture/chat-conversation-persistence-architecture.md) — 会话持久化与状态设计背景。

### 外部一手资料

- [MDN：min-width 自动最小尺寸](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/min-width)
- [MDN：CSS Container Queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries)
- [Vercel AI SDK UI Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot) 与 [useChat API](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
- [assistant-ui Primitives](https://www.assistant-ui.com/docs/primitives)
- [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) 与 [W3C WAI-ARIA Dialog Modal Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [Playwright Emulation](https://playwright.dev/docs/emulation)
- [OpenAI ChatKit](https://developers.openai.com/api/docs/guides/chatkit)

## 10. 方案执行与验收记录

### 10.1 已落地的改动

- 助手工作区在 1200px 以下切成聊天单栏，会话历史通过模态抽屉打开；1200px 及以上保留历史列表与聊天并排，桌面手动收起/展开仍可用。
- 抽屉支持新建、切换会话、遮罩关闭、Escape 关闭、Tab 焦点循环和关闭后焦点返回；不增加 UI 或状态机依赖。
- 会话列表与历史消息分别呈现 loading、error 和 retry；失败不会再显示成“暂无历史”或欢迎消息。
- 会话条目改为独立的选择、重命名、删除按钮，避免在列表项上嵌套交互角色。
- 助手标题、MCP 操作、消息气泡、输入框和消息内容补齐收缩约束；窄屏快捷指令可在自己的横向滚动区查看，底部输入区位于移动导航上方。
- 跨页回归发现设置页 115 认证方式按钮会把 375px 页面撑宽 24px，且七项底部导航在窄屏超出视口。已让认证方式按钮换行，并让 320–480px 导航项均分宽度。

### 10.2 合成长会话性能基线

在本机生产构建的 Headless Chromium、375×812 视口下，每种长度加载五次合成会话。下表是最近一次完整 E2E 运行结果；时间是页面导航到消息列表渲染完成，滚动列是单次 30 帧采样。它用于本地比较，不代表真实手机或真实模型接口的延迟。

| 合成消息数 | 渲染 p50 | 渲染 p95 | 滚动帧间隔 p50 / p95 | 全部消息行 DOM 数 |
|---:|---:|---:|---:|---:|
| 50 | 131 ms | 244 ms | 16 / 18 ms | 50 |
| 200 | 206 ms | 464 ms | 17 / 18 ms | 200 |
| 500 | 527 ms | 575 ms | 17 / 17 ms | 500 |

500 条合成消息后发送一条新消息，浏览器提交请求体为 52,241 bytes，确认当前客户端会重新发送完整消息历史。样本内容短且本地服务很快；导航耗时存在波动，滚动帧间隔也只有一次采样，尚不足以据此确定虚拟列表或分页阈值。因此本轮保留现有请求和持久化协议，不新增虚拟列表、分页或流式依赖；真实设备出现明显长会话卡顿或请求体过大时再进入下一轮优化。

### 10.3 回归范围与验证

- 助手视口矩阵覆盖 320×640、375×812、390×844、430×932、768×1024、860×900、861×900、1024×768、1199×900、1200×900、1365×900；检查页面级横向溢出、侧栏切换、标题与 MCP 控件间距、输入区和底部导航间距及运行时异常。
- 相似页面检查 `/`、`/?tab=library`、`/storage`、`/activity`、`/settings`、`/storage/strm`、`/notifications`、`/show/27205` 的手机宽度页面级溢出；`/storage` 另覆盖 320px。
- 助手与相似页面的 7 项 E2E 在最终全量重跑中通过，包含布局/抽屉/错误重试/语义、相似页面溢出和 50/200/500 消息性能采样。此前全套曾 11/11 通过；最终重跑为 10/11，唯一失败来自既有 `acquire-flow.spec.ts` 对重复“当前没有正在处理的任务。”文本使用严格单元素定位，Worker 完成状态使页面出现两处相同文案，与本轮改动文件无关。
- `npm run typecheck`、生产构建、相关源文件 ESLint 与 `npm run gate:style` 通过。
- 构建仍输出现有 Next `partialPrefetching` 配置提示和动态文件系统 tracing 提示；这些位置不在本轮变更范围内。
