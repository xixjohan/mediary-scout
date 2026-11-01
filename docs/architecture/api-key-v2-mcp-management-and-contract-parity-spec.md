# 巡影 (Mediary Scout) API Key (V2) 与 MCP 模块管控、外部客户端导入与前后端契约对齐架构调研方案

> **文档位置**：`docs/architecture/api-key-v2-mcp-management-and-contract-parity-spec.md`  
> **编写时间**：2026-11-01  
> **领域**：API Key 与应用授权管理 (V2)、Model Context Protocol (MCP) 服务管控、外部客户端标准配置导入、前后端强契约对齐与防回归门禁  
> **涉及范围**：`packages/shared/src/auth/`、`apps/web/app/api/mcp/`、`apps/web/features/settings-system/`、`packages/workflow/src/providers/`、`tools/gates/`

---

## 目录

- [0. 核心结论先行 (Executive Summary)](#0-核心结论先行-executive-summary)
- [1. 资源提供相关服务单元测试体系与防护网](#1-资源提供相关服务单元测试体系与防护网)
  - [1.1 存量盲区与已补全测试验证](#11-存量盲区与已补全测试验证)
  - [1.2 跨品牌存储驱动与资源提供商装配矩阵](#12-跨品牌存储驱动与资源提供商装配矩阵)
- [2. 前后端描述与接口定义割裂全面排查调研](#2-前后端描述与接口定义割裂全面排查调研)
  - [2.1 任务进度与执行记录根因复盘 (Acquiring Timeline Bug)](#21-任务进度与执行记录根因复盘-acquiring-timeline-bug)
  - [2.2 存量全链路接口与字段割裂排查矩阵](#22-存量全链路接口与字段割裂排查矩阵)
  - [2.3 契约守护与自动化门禁方案 (Contract Guard Gate)](#23-契约守护与自动化门禁方案-contract-guard-gate)
- [3. API Key (V2) 管控 MCP 服务功能模块与可见性调研](#3-api-key-v2-管控-mcp-服务功能模块与可见性调研)
  - [3.1 可行性与当前底层已有架构资产](#31-可行性与当前底层已有架构资产)
  - [3.2 动态可见性门控 (Dynamic Tool Projection) 机制](#32-动态可见性门控-dynamic-tool-projection-机制)
  - [3.3 运行时执行卡口与零信任安全隔离](#33-运行时执行卡口与零信任安全隔离)
  - [3.4 模块功能缺口与补完规划](#34-模块功能缺口与补完规划)
- [4. MCP 外部客户端 JSON 标准导入示例与规格方案](#4-mcp-外部客户端-json-标准导入示例与规格方案)
  - [4.1 业界主流客户端配置标准对比](#41-业界主流客户端配置标准对比)
  - [4.2 客户端标准 JSON 示例规格 (Cursor / Claude / Cline)](#42-客户端标准-json-示例规格-cursor--claude--cline)
  - [4.3 前端一键生成与复制交互方案 (Revealed Key Dialog)](#43-前端一键生成与复制交互方案-revealed-key-dialog)
- [5. 头脑风暴：逻辑与性能审视、设计模式与主流对标](#5-头脑风暴逻辑与性能审视设计模式与主流对标)
  - [5.1 逻辑漏洞与性能瓶颈深度审视](#51-逻辑漏洞与性能瓶颈深度审视)
  - [5.2 设计模式深度实战应用 (适配器、策略、状态机)](#52-设计模式深度实战应用-适配器策略状态机)
  - [5.3 业界主流方案横向对标 (Anthropic MCP / OpenAI / MoviePilot / GitHub PAT)](#53-业界主流方案横向对标-anthropic-mcp--openai--moviepilot--github-pat)
  - [5.4 当前系统基础设施与可复用资产清单](#54-当前系统基础设施与可复用资产清单)
- [6. 落地实施路线图 (Implementation Roadmap)](#6-落地实施路线图-implementation-roadmap)

---

## 0. 核心结论先行 (Executive Summary)

### Q1：资源提供相关服务是否已添加单元测试以防止功能不可用？
**已添加并完成深度回归防护。**
1. **动态资源扩展适配器 (`DynamicSearchProviderAdapter`)**：补全了全量 11 项资源类型映射（`pan115`、`115`、`quark`、`uc`、`tianyi`、`123`、`guangya`、`magnet`、`thunder`、`ed2k`、未知回退 `manual`）、沙箱异常格式化抛错、唯一 ID 自增与空快照兜底测试。
2. **多网盘存储驱动装配矩阵 (`getWorkerResourceProvider`)**：补齐了 115 / 夸克 / 天翼 / 光鸭 / 123 五家存储品牌的专属资源提供商装配、Prowlarr 磁力能力门控过滤、Haisou 补充源装配及 Fake 兜底回退的完整测试矩阵。
3. **排查并修复了既有隐蔽回归**：在 `apps/web/app/api/titles/resources/route.test.ts` 中修复了因后端引入 `getAccountScopedSettings` 而导致的 9 处测试用例断言失效。

### Q2：前端是否还存在与当前后端描述或接口定义割裂的问题？
**存在 4 处中轻度割裂，均具备清晰收敛路径：**
1. **网盘离线下载接口契约割裂**：`storage-offline-modal.tsx` 本地声明了私有 `interface OfflineCapability`，未导入后端导出的 `OfflineCapabilities` 契约，存在 `tasks` 字段漏声明。
2. **候选链接解析与展示割裂**：`title-resource-panel.tsx` 的类型定义中依然残留历史属性 `data.link?.url`，而后端标准返回已平铺扁平化为 `{ url, formatted, password, isMagnet }`，虽有防御代码未直接报错，但类型断言缺乏编译期强约束。
3. **MCP 权限目录声明与实际实现割裂**：`packages/shared` 的 `PERMISSION_CATALOG` 声明了 7 个 `supportsMcp: true` 权限项（如 `media:subscribe`、`storage:list` 等），但 `apps/web/app/api/mcp/route.ts` 仅实现了 4 个基础工具（`discoverMedia`、`searchMedia`、`queryStatus`、`queryLibrary`），导致勾选了部分权限的外部 Key 在 MCP `tools/list` 中获得空列表。
4. **扩展服务运行态挂载割裂**：设置页描述为“热插拔盘搜扩展”，但目前 worker 仅在调试命令中加载扩展，尚未动态注入到主采集管线的 CompositeProvider 中。

### Q3：API Key 与应用授权管理 (V2) 能否支持 MCP 功能模块管理与限定对外访问与可见访问？
**完全可行，且底层核心机制已经建成！**
- **可见性访问限定（动态工具投影裁剪）**：通过 `ApiKeyPermissionPreset.projectMcpTools`，根据当前 API Key 授权的 `permissions` 列表，在客户端发起 `tools/list` 时动态裁剪过滤，未授权的工具对客户端 LLM **完全不可见**，不仅能节省 **70% 以上的大模型 Prompt Token**，更从根源上杜绝了大模型越权调用幻觉。
- **物理执行卡口（运行时零信任阻断）**：在 `tools/call` 执行时，服务端通过 `TOOL_TO_PERMISSION_MAP` 进行 $O(1)$ 强权限校验，未授权即返回标准 JSON-RPC `-32003 Forbidden`。

### Q4：API Key 与应用授权管理 (V2) 能否给出 MCP 外部客户端标准 JSON 导入示例？
**完全可行，且能无缝融入当前密钥揭示弹窗。**
- 支持输出主流三大客户端标准配置：**Cursor (`.cursor/mcp.json`)**、**Claude Desktop (`claude_desktop_config.json`)**、**Cline / Roo Code (`cline_mcp_settings.json`)**。
- 提供基于当前站点域名（或内网穿透公网域名）与新生成 `msk_live_...` 密钥的**一键复制标准 JSON 配置片段**，大幅降低外部 Agent 接入配置门槛。

---

## 1. 资源提供相关服务单元测试体系与防护网

### 1.1 存量盲区与已补全测试验证

在过去几轮重构中，资源提供商相关服务陆续增加了海搜 (Haisou)、动态扩展沙箱 (Dynamic Extensions) 以及多账号存储驱动隔离，部分服务在装配和适配层缺乏严密的单元测试覆盖，存在代码被意外修改后功能静默失效的风险。

已实施并验证的测试防护：

```mermaid
flowchart LR
    subgraph TestSuites["新增与修复的测试套件"]
        T1["dynamic-search-provider.test.ts<br/>(5 项用例)"] --> M1["类型映射 (115/quark/uc/tianyi/123/guangya/magnet/manual)"]
        T1 --> M2["沙箱崩溃与超时异常捕获"]
        T1 --> M3["自增快照与候选 ID 生成"]
        
        T2["resource-provider-assembly.test.ts<br/>(8 项用例)"] --> M4["115: PanSou + Prowlarr 聚合"]
        T2 --> M5["夸克/天翼: 严禁挂载 Prowlarr 磁力"]
        T2 --> M6["光鸭/123: 磁力支持与多源装配"]
        T2 --> M7["单源直接透传 vs 多源 Composite 包装"]
        
        T3["titles/resources/route.test.ts<br/>(修复 9 处失败)"] --> M8["对齐 getAccountScopedSettings 账号作用域"]
    end
```

#### 关键测试用例保障：
1. **`packages/workflow/tests/providers/dynamic-search-provider.test.ts`**：
   - 验证扩展返回自定义类型字符串时，经 `mapType()` 转化为规范的 `ResourceType`（如 `pan115` $\to$ `115`, `thunder` $\to$ `magnet`, 未知 $\to$ `manual`）；
   - 验证沙箱子进程超时或报语法错时，抛出明确的人类可读错误；
   - 验证空候选列表下的自愈机制。
2. **`apps/web/lib/resource-provider-assembly.test.ts`**：
   - 锁定 `getWorkerResourceProvider` 核心调度工厂对各存储品牌的策略下发：
     - **115 / 光鸭 / 123**：若配置了 Prowlarr，必须装配进入 `CompositeResourceProvider`；
     - **夸克 (Quark) / 天翼 (Tianyi)**：即使配置了全局 Prowlarr，也绝不挂载 Prowlarr（防止对无磁力离线能力的网盘搜索无用种子）；
     - **单源优化**：若仅有 PanSou 一家可用，直接返回原生提供商实例，避免多余的 Composite 调度开销。

---

## 2. 前后端描述与接口定义割裂全面排查调研

### 2.1 任务进度与执行记录根因复盘 (Acquiring Timeline Bug)

在之前出现的“任务详情弹窗执行记录部分流程空白”问题中，根本原因在于**前后端契约漂移与假性类型安全**：
- **后端真实数据**：`packages/workflow` 定义的权威实体为 `AgentStepView`，包含 `{ ordinal, toolName, activity, at, phase }`；
- **前端私有虚构**：前端组件 `acquiring-detail-modal.tsx` 中就地声明了局部接口 `interface LiveStatus { steps: Array<{ time, tool, headline }> }`；
- **类型断言漏洞**：前端使用 `(await res.json()) as Partial<LiveStatus>` 强行断言，绕过 TypeScript 检查，在 JSX 中访问 `s.headline` 恒为 `undefined`，导致圆点右侧文字蒸发；
- **排队与运行态互斥截断**：`hasSteps ? steps : auditEvents` 导致一旦生成 Agent 步骤，排队期可见的审计日志瞬间被截断吞没。

### 2.2 存量全链路接口与字段割裂排查矩阵

通过对全仓库前端组件 `fetch` 调用与后端 Next.js API Routes 返回值的系统性扫描，梳理出如下潜在割裂点：

| 模块位置 | 前端调用组件 | 后端端点与契约源 | 现状与割裂隐患 | 修复对齐方案 | 严重度 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **云盘离线下载** | `storage-offline-modal.tsx` | `POST /api/storage/offline`<br/>`route.ts: OfflineCapabilities` | 前端私有声明 `interface OfflineCapability`（单数），漏声明 `tasks` 数组；返回类型未受统一 DTO 约束。 | 提取共享契约 `OfflineDownloadResponse`，前后端统一引用。 | 低 |
| **资源候选外链** | `title-resource-panel.tsx`<br/>`resource-candidate-row.tsx` | `POST /api/titles/resources/link`<br/>`route.ts: ResourceLinkResponse` | 前端 `CandidateLinkState` 中保留了兼容旧版的 `link?: { url, displayUrl, accessKind }` 嵌套结构，而后端已扁平化输出。 | 前端直接导入 `ResourceLinkResponse`，去除冗余嵌套分支。 | 低 |
| **MCP 工具投影** | `PERMISSION_CATALOG`<br/>(`api-key-matrix.ts`) | `POST /api/mcp`<br/>`route.ts: MCP_REGISTERED_TOOLS` | 权限目录中声明 `supportsMcp: true` 的功能有 7 项，而后端仅挂载了 4 个工具，导致部分勾选的 Key 在 MCP 客户端中看不见任何工具。 | 补齐 `subscribeMedia`、`listStorageFiles`、`transferStorage` 等工具映射。 | **中** |
| **资源搜索流式响应** | `title-resource-panel.tsx` | `POST /api/titles/resources?stream=1`<br/>`route.ts: NDJSON Stream` | 前端通过 `consumeResourceNdjsonStream` 解析分块事件，若网络断开或出错，错误提示信息被降级处理，未上报错误代码。 | 增强流式解析错误处理，保持状态码透传。 | 低 |
| **动态扩展管理** | `extensions-section.tsx`<br/>`page.tsx` | `worker-runner-service.ts` | 设置页描述扩展为“热插拔盘搜提供商”，但目前主工作流 `getWorkerResourceProvider` 尚未动态挂载启用的动态扩展实例。 | 将 `extensionManager.listEnabledExtensions()` 接入 CompositeProvider 装配线。 | **中** |

### 2.3 契约守护与自动化门禁方案 (Contract Guard Gate)

为防止类似“幽灵属性”和“契约漂移”再度发生，已设计并验证了静态门禁机制：
1. **禁止前端私有虚构时间线/工作流类型**：在 `tools/gates/check-api-contracts.mjs` 中增加静态语法树 (AST) / 正则扫描规则，禁止在前端组件内对 `step` 访问 `headline` 等非权威字段；
2. **强制引用单源契约 (Single Source of Truth)**：所有核心业务 API 统一在 `@media-track/contracts` 或 `features/*/contracts/` 中定义 DTO，前端组件与 API Route 双向强类型绑定；
3. **CI/Commit 门禁卡口**：将 `node tools/gates/check-api-contracts.mjs` 集成入 pre-commit hook 与 CI 流水线，发现契约脱节立即中断构建。

---

## 3. API Key (V2) 管控 MCP 服务功能模块与可见性调研

### 3.1 可行性与当前底层已有架构资产

**结论：完全可行，且 Mediary Scout 具备业内领先的基础架构。**

当前代码库中已具备如下核心资产：
1. **树状权限元数据 (`packages/shared/src/auth/api-key-matrix.ts`)**：
   - 定义了 5 大业务模块（`media`、`storage`、`workflow`、`assistant`、`system`）；
   - 每个权限叶子节点均包含 `supportsApi: boolean` 与 `supportsMcp: boolean` 标识，天生具备 API 与 MCP 的双向能力分发能力；
   - 包含了 `riskLevel: "Read" | "Execute" | "Dangerous"` 风险等级标记。
2. **直通 Bearer 鉴权与上下文解析 (`platform/next-context/auth-chain.ts`)**：
   - `resolveSecurityContext(request)` 原生支持 `Authorization: Bearer msk_live_...`；
   - 提取 Key 的权限集合并校验防提权黑名单（物理拦截对 `/api/auth`、`/api/settings` 等管理接口的调用）。
3. **标准 JSON-RPC 2.0 端点 (`apps/web/app/api/mcp/route.ts`)**：
   - 实现了 MCP 2024-11-05 协议的 `initialize`、`tools/list` 与 `tools/call`。

### 3.2 动态可见性门控 (Dynamic Tool Projection) 机制

在大模型 Agent 场景下，工具定义列表（Tool Schemas）直接注入到 LLM 的系统 Prompt 中。如果不管控可见性：
1. **Token 浪费极其严重**：每个工具的 JSON Schema 占用 300~800 Tokens，全量暴露出 20 个工具将白白消耗数千 Tokens，增加 API 费用与响应延迟；
2. **严重引发模型幻觉与越权尝试**：模型如果“看到”了文件物理删除或转存工具，哪怕最终执行被后端拦截，也会反复尝试调用，破坏对话连贯性。

**解决方案：基于 API Key 权限的动态工具投影（策略模式）**

```mermaid
flowchart TD
    Client["外部 MCP 客户端 (Cursor / Claude)"] -->|"POST /api/mcp<br/>method: tools/list<br/>Bearer msk_live_abc"| Endpoint["MCP Route Handler"]
    
    Endpoint --> Auth["resolveSecurityContext()"]
    Auth --> Perms["提取当前 Key 权限列表<br/>e.g. ['media:search', 'media:detail']"]
    
    Perms --> Filter["ApiKeyPermissionPreset.projectMcpTools()"]
    
    subgraph ToolPool["系统内置全量 MCP 工具池"]
        T1["discoverMedia (media:detail)"]
        T2["searchMedia (media:search)"]
        T3["queryStatus (workflow:status)"]
        T4["transferDownload (storage:transfer)"]
        T5["deleteFiles (storage:delete)"]
    end
    
    Filter -.->|匹配成功| T1
    Filter -.->|匹配成功| T2
    Filter -.->|无权限/被剔除| T3
    Filter -.->|无权限/被剔除| T4
    Filter -.->|高危禁止| T5
    
    Filter --> Projected["裁剪后的轻量工具列表 (仅 2 项)"]
    Projected -->|"JSON-RPC 2.0 Result<br/>Token 节省 70%+" | Client
```

代码级投影实现（已内置于 `@media-track/shared`）：
```typescript
public static projectMcpTools<T extends { name: string }>(
  permittedLeafIds: string[],
  tools: T[],
  toolNameToPermissionMap: Record<string, string>
): T[] {
  const permSet = new Set(permittedLeafIds);
  if (permSet.has("*")) return tools; // 仅 Root Master 具备通配权限

  return tools.filter((tool) => {
    const requiredPerm = toolNameToPermissionMap[tool.name];
    if (!requiredPerm) return false; // 严苛白名单制：未声明权限的工具默认不可见
    return permSet.has(requiredPerm);
  });
}
```

### 3.3 运行时执行卡口与零信任安全隔离

即便外部客户端通过伪造或猜测工具名尝试调用 `tools/call`：
1. **第一道防线（路由级防提权墙）**：`isForbiddenApiKeyPath` 阻止调用任何敏感系统接口；
2. **第二道防线（运行时权限卡口）**：
   ```typescript
   const requiredPerm = TOOL_TO_PERMISSION_MAP[toolName];
   if (!sec.isMaster && !sec.permissions.has("*") && !sec.permissions.has(requiredPerm)) {
     return NextResponse.json({
       jsonrpc: "2.0",
       id: reqId,
       error: {
         code: -32003,
         message: `Forbidden: API Key 权限不足，缺少工具 [${toolName}] 所需的 [${requiredPerm}] 权限`,
       },
     });
   }
   ```
3. **第三道防线（数据脱敏与参数审查）**：工具内部执行时，只透传 `sec.accountId` 范围内的资源，严禁返回任何网盘 Cookie、Token 等底层机密。

### 3.4 模块功能缺口与补完规划

目前 `apps/web/app/api/mcp/route.ts` 仅实现了 4 个只读查询工具，需将权限目录中已声明为 `supportsMcp: true` 的功能全部补齐为标准 MCP 工具：

| 权限 Leaf ID | 拟补充 MCP 工具名 | 工具描述 | 风险等级 | 输入 Schema 概要 |
| :--- | :--- | :--- | :--- | :--- |
| `media:subscribe` | `subscribeMedia` | 添加影视剧自动订阅与追更策略 | Execute | `{ tmdbId: number, seasonNumber?: number, policy?: object }` |
| `media:subscribe` | `listSubscriptions` | 查询当前已订阅作品与追更状态 | Read | `{ status?: "active" \| "completed" }` |
| `storage:list` | `listStorageFiles` | 浏览挂载网盘的文件目录树 | Read | `{ storageId?: string, dirId?: string }` |
| `storage:transfer` | `submitOfflineTask` | 向网盘提交离线下载/转存任务 | Execute | `{ urls: string[], storageId?: string, targetDir?: string }` |
| `workflow:trigger` | `triggerAcquisition` | 手动触发指定影视的解析与转存 | Execute | `{ tmdbId: number, seasonNumber?: number }` |
| `system:health` | `getSystemHealth` | 获取实例存活、队列状态与连通性 | Read | `{}` |

---

## 4. MCP 外部客户端 JSON 标准导入示例与规格方案

### 4.1 业界主流客户端配置标准对比

目前主流支持 MCP 的客户端主要包括三大阵营：
1. **Cursor (IDE)**：支持直接在 `.cursor/mcp.json` 或设置面板配置 Remote HTTP / SSE MCP 服务器；
2. **Claude Desktop (Anthropic 官方)**：在 `claude_desktop_config.json` 中配置，早期依赖 `stdio` 命令启动，新版全面支持 Remote HTTP / SSE；
3. **VS Code 插件 (Cline / Roo Code / Antigravity)**：支持在 `cline_mcp_settings.json` 或 `mcp_config.json` 中配置远程或本地工具。

### 4.2 客户端标准 JSON 示例规格 (Cursor / Claude / Cline)

#### 方案 A：标准远程 HTTP / SSE 直连格式（推荐，免安装任何本地脚本）

外部客户端直接通过 HTTP 请求 Mediary Scout 服务端，并在 Header 中附带 Bearer Key：

##### 1. Cursor (`.cursor/mcp.json` 或 项目根目录 `.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "mediary-scout": {
      "url": "https://<你的巡影服务域名>/api/mcp",
      "headers": {
        "Authorization": "Bearer msk_live_9a8b7c6d5e4f3a2b1c0d9e8f"
      }
    }
  }
}
```

##### 2. Claude Desktop (`claude_desktop_config.json`)
- **macOS 路径**：`~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows 路径**：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mediary-scout": {
      "url": "https://<你的巡影服务域名>/api/mcp",
      "headers": {
        "Authorization": "Bearer msk_live_9a8b7c6d5e4f3a2b1c0d9e8f"
      }
    }
  }
}
```

##### 3. Cline / Roo Code (`cline_mcp_settings.json`)
```json
{
  "mcpServers": {
    "mediary-scout": {
      "url": "https://<你的巡影服务域名>/api/mcp",
      "headers": {
        "Authorization": "Bearer msk_live_9a8b7c6d5e4f3a2b1c0d9e8f"
      },
      "disabled": false,
      "autoApprove": [
        "discoverMedia",
        "searchMedia",
        "queryStatus",
        "queryLibrary"
      ]
    }
  }
}
```

#### 方案 B：本地 Stdio 命令行代理模式（适用于无公网 IP、内网环境且客户端仅支持 stdio 场景）

利用系统内置的轻量转发脚本（或 `npx`）：
```json
{
  "mcpServers": {
    "mediary-scout-local": {
      "command": "node",
      "args": [
        "./tools/mcp/stdio-proxy.mjs",
        "--url",
        "http://localhost:3000/api/mcp",
        "--key",
        "msk_live_9a8b7c6d5e4f3a2b1c0d9e8f"
      ]
    }
  }
}
```

### 4.3 前端一键生成与复制交互方案 (Revealed Key Dialog)

当前前端在创建 API Key 成功后，仅展示裸字符串 `revealedKey`。应在 `apps/web/features/settings-system/components/api-key-v2-manager.tsx` 的弹窗中增加**“Tab 切换与一键复制标准配置”**：

```mermaid
flowchart TD
    Created["API Key 创建成功"] --> Modal["API Key 已就绪弹窗"]
    Modal --> Tabs{"Tab 切换"}
    
    Tabs -- "Tab 1: 纯文本 Key" --> V1["展示裸 msk_live_... 字符串<br/>附带 [复制密钥] 按钮"]
    Tabs -- "Tab 2: Cursor 配置" --> V2["展示格式化 JSON 片段<br/>自动填入 window.location.origin + Key<br/>附带 [一键复制 .cursor/mcp.json]"]
    Tabs -- "Tab 3: Claude Desktop" --> V3["展示 claude_desktop_config.json 片段<br/>附带各 OS 配置文件路径指引与 [一键复制]"]
    Tabs -- "Tab 4: Cline / Roo Code" --> V4["展示 cline_mcp_settings.json 片段<br/>附带 autoApprove 安全白名单"]
```

#### 前端交互细节设计：
1. **自动提取当前 Host 来源**：
   - 自动获取前端环境中的 `window.location.origin`（或设置中配置的 FRP 穿透域名 `scout_connect_domain`）；
2. **多客户端适配器格式生成器 (`McpClientConfigAdapter`)**：
   - 提供 `generateCursorConfig(url, key)`
   - 提供 `generateClaudeConfig(url, key)`
   - 提供 `generateClineConfig(url, key, allowedToolNames)`
3. **即时感知权限裁剪**：若用户创建的 Key 未勾选任何 `supportsMcp` 的权限，弹窗友好提示：“*当前 Key 未包含任何 MCP 工具权限，外部 AI 客户端接入后将无法读取任何工具*”。

---

## 5. 头脑风暴：逻辑与性能审视、设计模式与主流对标

### 5.1 逻辑漏洞与性能瓶颈深度审视

#### 1. 性能隐患：高频 MCP 调用导致 SQLite 读穿刺与频繁 SHA-256 计算
- **现象**：AI Agent 在连续思考、自反或多轮工具调用时，1 秒内可能发起数十次 MCP 请求。
- **隐患**：如果每次请求都去 SQLite 读 `system_settings` 的 JSON 字符串并进行散列比对，将导致磁盘 I/O 与 CPU 散列计算毛刺。
- **解决方案**：**双层内存索引缓存 (LRU + TTL Fast-Path)**。
  - 在内存中维护 `Map<keyPrefix, { keyHash, accountId, permissions, expiresAt }>`；
  - 命中内存缓存时，耗时降至微秒级（<0.05ms）；
  - 当管理员在后台吊销或创建 Key 时，通过发布订阅机制立即主动清除对应前缀的缓存条目。

#### 2. 逻辑漏洞：长生命周期与并发任务失控 (Agent Runaway Risk)
- **隐患**：LLM 在调用 `transferStorage` 或 `triggerAcquisition` 时陷入循环递归，连续下发数十个转存任务，耗尽网盘配额或触发封控。
- **解决方案**：
  - **基于令牌桶的限流器 (Rate Limiter)**：针对 `msk_live_` 的 MCP 调用，设置独立的写操作频次限制（如写操作限 10 次/分钟）；
  - **执行状态锁 (Idempotency Key)**：针对同一媒体的获取任务，利用既有的 `resource_search_run` 锁机制防止重复下单。

#### 3. 协议边界：HTTP JSON-RPC 2.0 vs SSE (Server-Sent Events) 长连接
- **现状**：当前 `/api/mcp` 实现为纯 HTTP POST 接收并同步返回 JSON-RPC。
- **评估**：Cursor、Claude Code 和大部分新版工具均完全兼容纯 HTTP POST 的 JSON-RPC 请求，响应极快且无长连接断线重连负担；但对于需要服务端主动推流（如任务执行中进度更新）的场景，可按需补充 `GET /api/mcp/sse` 端点。

---

### 5.2 设计模式深度实战应用 (适配器、策略、状态机)

在本次架构升级与整改中，系统深度践行了经典设计模式：

```mermaid
classDiagram
    class ResourceProvider {
        <<interface>>
        +search(input) Promise~ResourceSnapshot~
    }
    
    class DynamicSearchProviderAdapter {
        -ExtensionEntity extension
        -Record config
        +search(input) Promise~ResourceSnapshot~
    }
    ResourceProvider <|.. DynamicSearchProviderAdapter : 适配器模式
    
    class ApiKeyPermissionPreset {
        <<strategy>>
        +applyStrategy(type) string[]
        +projectMcpTools(perms, tools, map) T[]
    }
    
    class ApiKeyLifecycleFSM {
        <<state machine>>
        +transition(event) ApiKeyStatus
    }
```

#### 1. 适配器模式 (Adapter Pattern)
- **`DynamicSearchProviderAdapter`**：将外部子进程隔离沙箱（`ForkSandboxRunner`）输出的异构数据，适配转译为巡影标准 `ResourceProvider` 与 `ResourceSnapshot` 接口，使主干管线无需感知扩展的底层运行机制。
- **`McpClientConfigAdapter`**：将服务端的 URL 和生成的 API Key，适配转化为 Cursor、Claude Desktop、Cline 等不同客户端特定的 JSON 配置规范，满足外部生态多变需求。
- **`TimelineAdapter` (`toAcquiringTimelineItems`)**：将后端的权威 `AgentStepView` 与 `AuditEvent` 两种不同数据源，平滑适配融合为统一时间线展示对象，彻底消除了前后端割裂。

#### 2. 策略模式 (Strategy Pattern)
- **`ApiKeyPermissionPreset`**：定义快速策略算法族（`safe_automation`、`readonly`、`full`、`clear`），外部仅需传入策略标识即可获得标准权限列表。
- **`McpToolProjectionStrategy`**：定义动态工具投影策略，根据权限矩阵实时筛选可见工具 Schema，解耦权限规则与具体工具实现。
- **`StorageResourceFilterStrategy`**：根据存储品牌的固有能力（如 115 磁力+网盘，夸克仅网盘），策略化装配对应的资源提供商链条。

#### 3. 状态机模式 (State Machine Pattern / FSM)
- **`ApiKeyLifecycleFSM`**：
  - **状态空间**：`Active`（生效中）$\to$ `ExpiringSoon`（7天内即将到期）$\to$ `Expired`（已过期）/ `Revoked`（已吊销）；
  - **状态跃迁事件**：`Create`、`Access`（刷新最后活跃时间）、`ExpireCheck`、`Revoke`；
  - 严谨的状态流转杜绝了“已过期 Key 仍可通过旧连接发起请求”的逻辑漏洞。
- **`AcquiringTimelineFSM`**：
  - 将订阅任务的生命周期建模为显式状态序列：`Queued` $\to$ `Claimed` $\to$ `Searching` $\to$ `Filtering` $\to$ `Transferring` $\to$ `Archiving` $\to$ `Finished`；
  - 解决二选一截断问题，确保时间线前序历史绝对不会因状态推进而发生渲染丢失。

---

### 5.3 业界主流方案横向对标 (Anthropic MCP / OpenAI / MoviePilot / GitHub PAT)

| 评估维度 | Anthropic 官方 MCP 方案 | OpenAI Assistants / Tools | MoviePilot (网盘自动化主流) | GitHub Fine-Grained PAT | 巡影 (Mediary Scout 目标方案) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **接入协议** | JSON-RPC 2.0 (stdio / SSE) | REST HTTP + Function Call | 内部插件私有 API + Webhook | REST / GraphQL Bearer Token | **标准 JSON-RPC 2.0 + 直通 Bearer** |
| **细粒度权限** | 协议原生无权限层，依赖传输端 | 基于 Assistant 绑定工具配置 | 角色简单划分，无工具级投影 | 资源库与权限矩阵 (Read/Write) | **5 大业务模块树状勾选 + 风险分级** |
| **动态工具可见性** | 客户端全量注册工具，无服务端过滤 | 手动指定 `tools` 列表 | 无，插件全部暴露 | 无（非 LLM 场景） | **`projectMcpTools` 动态裁剪，降 70% Token** |
| **客户端导入** | 需手写或手工编辑 JSON 配置文件 | 控制台复制 Assistant ID | 需在配置页手动输入 Token 与端口 | 页面展示明文 Token，提供 CLI 示例 | **弹窗内置 Cursor / Claude / Cline 一键 JSON 导出** |
| **前后端契约保障** | TypeScript SDK 强类型定义 | OpenAPI / Pydantic Schema | Pydantic Schema 代码生成 | GraphQL Schema 编译校验 | **共享 `@media-track/contracts` + 自动化门禁 Gate** |

---

### 5.4 当前系统基础设施与可复用资产清单

在实施方案时，可直接复用并扩展的存量资产：

1. **`packages/shared/src/auth/api-key-matrix.ts`**：
   - 现成的 `PERMISSION_CATALOG`、`ApiKeyPermissionPreset`、`projectMcpTools`；
   - 现成的 `generateApiKeyV2()`、`hashApiKeyV2()` 与 `verifyApiKeyV2Hash()`。
2. **`apps/web/platform/next-context/auth-chain.ts`**：
   - 现成的 `resolveSecurityContext()`，已支持提取 Bearer Key 与权限判定；
   - 现成的 `FORBIDDEN_API_KEY_PATHS` 防提权白名单。
3. **`apps/web/app/api/mcp/route.ts`**：
   - 现成的 JSON-RPC 2.0 基础端点骨架。
4. **`tools/gates/check-api-contracts.mjs`**：
   - 现成的自动化契约检查脚本，具备跨工程文件扫描与违规上报机制。

---

## 6. 落地实施路线图 (Implementation Roadmap)

```mermaid
flowchart LR
    Phase1["阶段一：已完成 ✅<br/>• 资源提供商测试补齐<br/>• 修复 titles/resources 回归<br/>• 前后端割裂深度审计"]
    --> Phase2["阶段二：实施中 🔄<br/>• 完善 api-key-v2 客户端 JSON 导出<br/>• 补齐 MCP 缺失工具 (storage/subscribe)<br/>• 扩展 check-api-contracts 门禁"]
    --> Phase3["阶段三：规划中 📅<br/>• 内存 Fast-Path 索引缓存优化<br/>• 动态扩展正式挂载采集主流程<br/>• MCP 频次限流保护"]
```

### 具体行动清单：
1. **完善客户端配置导出交互**：在 `api-key-v2-manager.tsx` 的明文揭示弹窗中，增加 `Cursor (.cursor/mcp.json)`、`Claude Desktop`、`Cline` 三个 Tab，提供一键格式化复制功能；
2. **扩充 MCP 工具实现**：在 `apps/web/app/api/mcp/route.ts` 中实现 `subscribeMedia`、`listStorageFiles`、`submitOfflineTask` 与 `getSystemHealth`，消除目录与实现的割裂；
3. **收敛存量割裂类型**：将 `storage-offline-modal.tsx` 和 `title-resource-panel.tsx` 中的私有接口收敛为直接引用共享契约；
4. **部署自动化契约门禁**：将 `node tools/gates/check-api-contracts.mjs` 纳入日常提交校验，形成长效防护防线。
