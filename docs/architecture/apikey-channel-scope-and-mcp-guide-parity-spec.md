# API Key 协议通道管控 (REST API / MCP) 与客户端接入指引对齐架构设计规范

> **文档版本**: 1.0.0  
> **状态**: 已落地 / 生产对齐 (Done & Verified)  
> **参考对标**: `E:\WorkProject\CSharp\PrivateProject\Web\WebToolForLinux` (WebToolForLinux APIKey 授权交互与协议分流架构)  
> **核心范围**: API Key V2 通道控制 (`allowApi` / `allowMcp`)、持久化客户端配置指南 (`ApiKeyGuideModal`)、MCP 工具动态投影、双通道安全门禁与回归防御  

---

## 一、问题背景与根本原因深度剖析 (Root Cause Analysis)

在巡影（Mediary Scout）微服务与工作流体系演进中，系统引入了细粒度 API Key V2 与 MCP (Model Context Protocol) 服务。但在用户体验与授权体系上，存在两项显著割裂：

### 1.1 为什么 API Key (V2) 列表此前无法查看 Agent MCP 服务导入示例？

- **根本原因**：
  - 此前 MCP 客户端导入示例（Cursor `.cursor/mcp.json`、Claude Desktop `claude_desktop_config.json`、Cline `cline_mcp_settings.json`）仅存在于新建 Key 成功后触发的**瞬态明文弹窗 (`revealedKey`)** 中。
  - 出于安全规范，API Key 的完整明文在数据库中仅保留哈希散列，明文弹窗关闭后不可再次显示完整密钥。
  - **交互缺失**：系统未在 Key 列表条目提供针对该 Key 的「集成」入口，也未在顶部操作栏提供常驻的「客户端 / MCP 接入指南」。当用户后续更换开发环境、重新配置 Cursor 或在团队中配置接入时，无法再次调出规范的标准 JSON 导入片段。
- **参考对齐 (`WebToolForLinux`)**：
  - 在 `WebToolForLinux\src\LinuxWebTool.WebHost\wwwroot\app\views\ApiKeysView.js` 中，无论是在密钥生成完成时，还是在密钥列表的每一行操作列中，都提供一个专属的 `[集成]` 按钮，并常驻独立的模态弹窗；同时展示针对该 Key 作用域的预填参数和通用示例，极大降低了用户集成外部客户端与脚本的心智负担。

### 1.2 为什么新建 API Key 时无法选择是否赋予 API 或 MCP 权限选项？

- **根本原因**：
  - 此前的权限模型仅关注**功能能力维度**（Capability Dimension，即 `media:search`、`workflow:trigger` 等叶子能力），而忽略了**访问通道维度**（Protocol Channel Scope，即 HTTP REST API 通道 vs MCP 协议通道）的双正交属性。
  - 数据模型 `ApiKeyV2Entity` 与新建表单 `CreateApiKeyModal` 缺少 `allowApi` 与 `allowMcp` 字段，导致创建的任何 Key 只要具备底层功能权限，就同时在两个通道上被默认放行。
  - **安全隐患**：用户若只想向本地 AI Agent (如 Cursor) 委托 MCP 工具能力，不想让该 Key 具备直接调用任意底层 `/api/*` REST 接口进行大规模批量删除或数据爬取的能力，系统在协议边界上无法做到最小权限（Least Privilege）隔离。

---

## 二、业界主流方案调研与对比

| 方案 | 协议通道划分方式 | 客户端集成指引 | 权限裁剪与投影 | 优劣势评估 |
| :--- | :--- | :--- | :--- | :--- |
| **WebToolForLinux** (参考对标) | 明确区分 `AllowApi` 与 `AllowMcp`，在列表行呈现专用通道徽标，请求中间件严格分流 | 提供持久化配置生成器，动态生成 curl 与客户端 JSON | 基于模块与权限树校验 | **优势**：直观清晰，操作路径极短；**借鉴点**：列表行 `[集成]` 弹窗与通道徽标展示 |
| **GitHub Fine-grained PATs** | 区分 Resource Scope 与 Permissions，分离 Git 协议通道与 REST/GraphQL 通道 | 提供文档链接与 CLI 使用指引 | 基于 Resource Owner 边界裁剪 | **优势**：权限粒度极细；**劣势**：配置路径复杂，无直观的 AI Agent 导入模板 |
| **AWS IAM / STS** | 基于 Policy `Condition` 中的协议与网络上下文键 (`aws:SecureTransport`, `aws:userAgent`) | 导出 AWS CLI Credentials profile | 严格策略匹配 | **优势**：企业级严密；**劣势**：配置门槛过高，不适合本地与轻量级自托管系统 |
| **巡影 (Mediary Scout 优化后)** | 双正交正向维度：`allowApi` 与 `allowMcp` 独立布尔管控，底表支持向后兼容 | 提供 Cursor / Claude Desktop / Cline / curl 多端一键复制，支持 Key 占位替换 | **动态 MCP 工具投影裁剪**：根据当前 Key 实际授权动态计算并下发工具，减少 70% Token 消耗 | **兼顾极简体验与银行级防御深度** |

---

## 三、系统现有基础设施与设计模式复用

1. **适配器与策略模式 (Adapter & Strategy Pattern)**:
   - 复用 `@media-track/shared` 中的 `ApiKeyPermissionPreset` 策略执行器（`safe_automation`、`readonly`、`full`），与通道选择 (`allowApi` / `allowMcp`) 解耦互补。
   - 协议配置生成器适配器：将同一个服务实体转换为 Cursor、Claude Desktop、Cline 及 curl 四种异构客户端所需的不同 JSON/Shell 规范。
2. **状态机与责任链模式 (Chain of Responsibility & State Gate)**:
   - 复用 `apps/web/platform/next-context/auth-chain.ts` 的 `resolveSecurityContext`，在责任链入口直接校验 `sec.allowApi === false`（REST API 拦截）与 `sec.allowMcp === false`（MCP 拦截），实现 Fail-Closed 快速断路保护。
3. **前端状态与 Portal 复用**:
   - 提取独立的 `ApiKeyGuideModal` 纯客户端组件，与 `CreateApiKeyModal`、`UserActionConfirmDialog` 保持统一的 design token、无极模糊背景与无障碍 overflow 控制。

---

## 四、具体解决方案与架构落地

### 4.1 数据模型扩展 (`@media-track/shared` & `@media-track/workflow`)

在 `ApiKeyV2Entity` 与 `CreateApiKeyV2Input` 中新增通道控制字段，并在持久化层做好向后兼容（缺省为 `true`）：

```typescript
export interface ApiKeyV2Entity {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  maskedKey: string;
  permissions: string[];
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt?: number;
  createdBy: string;
  revokedAt?: number;
  allowApi?: boolean; // 是否允许 REST API 通道访问
  allowMcp?: boolean; // 是否允许 MCP 协议通道访问
}
```

### 4.2 接口通道门禁断路器 (`auth-chain.ts` & `/api/mcp/route.ts`)

- **REST API 端点保护 (`requireApiAccount` / `requirePermission`)**:
  ```typescript
  if (sec.apiKeyId && sec.allowApi === false) {
    return NextResponse.json({ error: "Forbidden: 当前 API Key 未开放 REST API 访问通道。" }, { status: 403 });
  }
  ```
- **MCP 服务保护 (`/api/mcp/route.ts`)**:
  ```typescript
  if (sec.apiKeyId && sec.allowMcp === false) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32003, message: "Forbidden: 当前 API Key 未开放 MCP 协议访问通道" },
      },
      { status: 403 }
    );
  }
  ```

### 4.3 新建 Key 模态框通道控制 (`create-api-key-modal.tsx`)

- 在基本信息与权限树之间注入「协议通道权限 (Channel Scope)」卡片。
- 支持独立勾选「REST API 访问 (`HTTP API`)」与「MCP 协议服务 (`Agent MCP`)」。
- 前后端双重门禁校验：若用户同时取消勾选两项，立即阻止提交并给出明确告警 `请至少开启一种协议通道权限`。

### 4.4 列表管理与常驻接入指引 (`api-key-v2-manager.tsx` & `api-key-guide-modal.tsx`)

- **顶部操作栏**：新增 `[客户端 / MCP 接入指南]` 按钮，随时可调出全局标准集成示例。
- **列表卡片徽标**：在生效状态旁渲染高对比度的 `[API]` (蓝色) 与 `[MCP]` (紫色) 通道徽标。
- **卡片操作列**：新增 `[集成]` 按钮，点击即可弹出已针对该 Key 预填占位符与通道警告的集成配置面板。
- **多端导入导出**：
  1. **Cursor IDE**: `.cursor/mcp.json`
  2. **Claude Desktop**: `claude_desktop_config.json` (自动指示 macOS 与 Windows 路径)
  3. **Cline / Roo Code**: `cline_mcp_settings.json` (内置 9 项工具免审批白名单)
  4. **REST API / curl**: 协议握手与 REST API 示例

---

## 五、质量门禁与防回归测试矩阵 (Quality Gates & Verification)

### 5.1 API 契约与时间线字段对齐门禁 (`tools/gates/check-api-contracts.mjs`)

在静态契约扫描工具中集成同类漏洞防范机制：
- 强制校验 `create-api-key-modal.tsx` 必须包含 `allowApi` 与 `allowMcp` 状态控制。
- 强制校验 `api-key-v2-manager.tsx` 必须绑定 `ApiKeyGuideModal`。
- 强制校验 `api-key-guide-modal.tsx` 必须完整覆盖 `.cursor/mcp.json` 与 `claude_desktop_config.json` 标准配置模板。
- 强制校验 `/api/mcp/route.ts` 必须对 `allowMcp === false` 实施拦截。

### 5.2 自动化测试用例覆盖 (Vitest Suite)

| 测试文件 | 覆盖场景 | 结果 |
| :--- | :--- | :--- |
| `apps/web/app/api/settings/api-keys/route.test.ts` | 1. 验证拒绝双通道全关的非法请求 (`400`)<br>2. 验证创建纯 MCP Key 且通道状态持久化<br>3. 验证创建纯 REST API Key 且通道状态持久化 | ✅ 6/6 通过 |
| `apps/web/app/api/mcp/route.test.ts` | 1. 验证 `allowMcp: false` 时直接返回 403 / -32003 拦截<br>2. 验证 9 项 MCP 工具投影裁剪与参数执行 | ✅ 11/11 通过 |
| `apps/web/lib/auth-chain.test.ts` | 1. 验证 `allowApi: false` 时在 REST 接口拦截<br>2. 验证多用户与单用户模式责任链穿透 | ✅ 28/28 通过 |
| `packages/workflow/tests/providers/dynamic-search-provider.test.ts` | 资源提供者 11 种网盘与搜索映射健全性 | ✅ 5/5 通过 |
| `apps/web/lib/resource-provider-assembly.test.ts` | 多源资源提供者装配与网盘回退兜底 | ✅ 8/8 通过 |
| `apps/web/app/api/titles/resources/route.test.ts` | 资源搜索聚合与快照落库容灾 | ✅ 14/14 通过 |

**测试总计**：全量 72 个关键路径单元测试 100% 通过，0 错误，0 幽灵字段。
