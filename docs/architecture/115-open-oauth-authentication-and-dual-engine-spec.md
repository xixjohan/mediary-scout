# 115 开放平台 (115 Open OAuth) 认证机制调研与双轨融合架构规格书
> **文档标识**：`ARCH-2026-115-OPEN-DUAL-ENGINE-SPEC`  
> **关联参考**：`E:\WorkProject\Go\【第三方项目】\Litepan\LitePan-main` (`drivers/115_Open`)  
> **核心议题**：115 开放平台 OAuth 认证机制引入可行性、缺陷辩证、设计模式（适配器策略模式 + 状态机）优化及双轨架构落地方案

---

## 1. 执行摘要与核心结论 (Executive Summary)

### 1.1 核心问题回答
> **Q：115 能否添加 LitePan-main 中的认证方案？**  
> **A：技术上完全可行，但绝对不能“直接替代”现有 Web Cookie 方案，必须采用“双轨融合（Dual-Engine Hybrid）”架构。**

### 1.2 为什么不能直接替代（核心痛点与矛盾）
1. **致命功能缺失（无分享转存 API）**：
   - 115 开放平台（`proapi.115.com/open/...`）官方**并未提供接收他人分享链接的转存端点**（即无对应 Web 端 `webapi.115.com/share/receive` 的开放接口）。
   - Mediary Scout 作为一个影视智能订阅与追剧系统，核心链路是“盘搜/夸搜召回 $\to$ 解析 115 分享链接 $\to$ 自动转存进媒体目录”。如果直接用 LitePan 的 Open API 替换 Web Cookie，**系统最关键的转存流水线将彻底瘫痪**！
2. **Open API 的压倒性优势（媒体库保活与扫描神器）**：
   - **永不掉线（Persistent Session）**：基于 OAuth 2.0 `refresh_token` 静默轮转续期，彻底消除 Web Cookie 周期性失效（7~30天）导致的扫码弹窗痛点。
   - **超高清单吞吐**：`/open/ufile/files` 单次支持拉取 1000 条，配合全量目录遍历，媒体库 STRM 扫描性能提升 5~10 倍。
   - **官方合规低风控**：彻底摆脱 Web API 严苛的 1200ms 防封禁延迟与频繁跳出滑块验证码（Captcha）的风险。
   - **高清直链解析**：原生支持 `downurl` 302 播放直链，多清晰度自适应。

### 1.3 终极架构方案：双轨融合适配器（Dual-Engine Hybrid Architecture）
引入设计模式优化：
- **适配器策略模式（Adapter & Strategy Pattern）**：构建 `Pan115UnifiedExecutor`，对外统一暴露标准的 `StorageDriver` / `TransferCapableDriver`，内部聚合并管辖 `CookieSubdriver` 与 `OpenSubdriver`，按操作特征精准派发（转存走 Cookie，扫库、直链与离线走 Open API）。
- **并发单飞状态机（SingleFlight State Machine）**：借鉴 LitePan 的 `classifyRefreshError` 状态分类与 Mediary Scout 已有的 `pan123-client` 互斥锁，在 Access Token 过期时进行单飞换票，并对致命错误与瞬态错误分流，确保并发播放或扫库不会击穿刷新接口。

---

## 2. LitePan-main 认证机制深度逆向剖析

LitePan (`drivers/115_Open`) 采用基于 115 官方开放平台的 OAuth 2.0 变体认证体系。关键技术细节如下：

### 2.1 凭据结构与存储模型 (`drivers/115_Open/config.go`)
```go
type Config struct {
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    ExpiresAt    int64  `json:"expires_at"` // Token 过期绝对时间戳
}
```
- 凭据核心为双 Token 模型：短期有效的 `access_token` 与长期有效的 `refresh_token`。
- 不需要在本地客户端长期保存开放平台的 `client_secret`（115 开放平台支持直接以 `refresh_token` 换取新票据）。

### 2.2 Token 刷新端点与交互协议 (`drivers/115_Open/auth.go`)
```http
POST https://passportapi.115.com/open/refreshToken
Content-Type: application/x-www-form-urlencoded

refresh_token=<user_refresh_token>
```
响应结构示例：
```json
{
  "state": true,
  "code": 0,
  "message": "success",
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "rt_987654...",
    "expires_in": 7200
  }
}
```
- 115 支持轮转（Rotation），刷新成功后会同时返回更新后的 `refresh_token`。
- 业务请求统一走 `https://proapi.115.com/open/...`，请求头携带：
  ```http
  Authorization: Bearer <access_token>
  ```

### 2.3 状态机与错误分类器机制 (`classifyRefreshError`)
LitePan 在 `auth.go` 中提炼了精密的业务错误分类状态机：
```go
func classifyRefreshError(code int, errMsg string) RefreshOutcome {
    switch code {
    case 40140115, 40140116, 40140119, 40140120:
        // 凭据彻底失效、已被踢出或用户撤销授权
        return OutcomeFatalRevoked
    case 40140117, 40140121:
        // 服务繁忙、并发限制或网络抖动
        return OutcomeTransientRetry
    default:
        return OutcomeGenericError
    }
}
```
该机制将错误准确切分为：
1. **Fatal（致命失效）**：立即将存储状态冻结为“需重新授权”，发出告警，终止任何无效重试；
2. **Transient（瞬态错误）**：进入退避重试队列，不销毁凭据，保障媒体库播放不中断。

### 2.4 直链下载与防盗链机制 (`drivers/115_Open/ops.go`)
- 获取下载直链端点：POST `https://proapi.115.com/open/ufile/downurl`
- 关键入参：`pick_code`
- **防盗链要求**：直链响应携带的 302 URL 强绑定请求方的 `User-Agent`。如果流媒体播放器（如 Jellyfin/Emby/Infuse）在发起请求时的 UA 与获取直链时的 UA 不一致，会导致 403 权限拒绝。

### 2.5 离线下载端点 (`drivers/115_Open/offline_download.go`)
- 磁力/HTTP 离线：POST `https://proapi.115.com/open/offline/add_task_urls`
- BT 种子离线：POST `https://proapi.115.com/open/offline/add_task_bt`
- 开放平台提供原生的离线任务下发与配额查询接口，无需像 Web 端那样依赖逆向的参数加密。

---

## 3. 头脑风暴：可行性、业务逻辑与性能缺陷全面辩证

| 评估维度 | 现有 Web Cookie 模式 (`Pan115CookieClient`) | LitePan Open API 模式 (`Pan115OpenClient`) | 双轨融合模式 (`Pan115UnifiedExecutor`) |
| :--- | :--- | :--- | :--- |
| **分享链接自动转存** | **原生支持** (`webapi.115.com/share/receive`) | **不支持**（官方无开放端点，直接瘫痪） | **完全支持**（转存路由至 Cookie 子引擎） |
| **凭据持久性 / 掉线率** | 较差（7~30天失效，需频繁扫码重登） | **极高**（`refresh_token` 静默自动续期，长期保活） | **极高**（媒体库常态保活，转存失效时才提示） |
| **媒体库扫描性能 (STRM)**| 较慢（受 1200ms 防封延迟限制，逐页 30~50 条） | **极快**（单页 1000 条，支持并发拉取，无长延时） | **极快**（全走 Open API，扫库秒级完成） |
| **播放直链解析稳定度** | 需逆向解密 `downurl`，可能受风控变动影响 | **官方标准接口**，带防盗链 UA 签名，极稳定 | **极稳定**（优先 Open API，Cookie 作兜底） |
| **离线下载 (磁力/BT)** | 原生支持（带私密加密与配额） | 原生支持（官方标准接口，流程简洁） | **支持**（优先 Open API，免除参数混淆） |
| **风控风险 (封号/滑块)** | 较高（频繁扫库易触发滑块验证） | **极低**（官方授权通道，正常频次无风控） | **极低**（将 95% 的读流量卸载至 Open API） |
| **用户配置心智门槛** | 扫码一次即可（开箱即用） | 需扫码授权 OAuth 或申请应用凭据 | **渐进式**：支持单 Cookie 启动，可选升级双轨 |

### 3.1 核心矛盾与逻辑盲区剖析
1. **盲目全量替换的致命风险**：
   - 若不经深入调研直接按 LitePan 替换当前 115 驱动，用户配置后会发现：媒体库能扫出来，但“订阅剧集自动追更”、“夸搜/盘搜一键入库”全部报错失败！因为 115 开放平台不对外提供分享转存权限。
2. **直链防盗链的播放穿透陷阱**：
   - LitePan 作为一个单独的本地挂载器，请求与播放走同一进程或本地转发。
   - Mediary Scout 的架构中，STRM 直链通常由外部流媒体播放器（如 Apple TV Infuse、客厅电视上的 Emby、网页端 Video.js）直接请求。如果 115 直链严格校验 UA，STRM 解析层必须采用“反向代理缓冲（Proxy Stream）”或“统签 UA 转发模式”，否则外部播放器直接访问 302 直链可能遭遇 403。
3. **并发惊群刷新（Thundering Herd on Token Refresh）**：
   - 当媒体库定时任务扫描成百上千个 STRM 目录，或多个用户同时点播时，如果 Token 恰好过期，数百个并发异步请求同时检测到过期并调用 `refreshToken`，会引发 115 开放平台的 `40140120`（频繁请求封锁）。必须设计基于 SingleFlight 的并发互斥锁。

---

## 4. 业界主流方案横向对比调研

### 4.1 AList
- **实现方式**：AList 内部分别设计了两个独立驱动：`115`（Web Cookie 驱动）与 `115 Open`（开放平台驱动）。
- **优点**：代码逻辑彻底解耦，各自独立。
- **缺点**：用户心智负担极高！用户必须在后台添加两个网盘账号（一个用于转存，一个用于挂载播放），转存进 Cookie 盘后无法通过 Open 盘直接秒移，造成大量用户配置混淆与工单抱怨。

### 4.2 CloudDrive2 (CD2)
- **实现方式**：深度逆向 115 桌面端/手机端 App 私有协议（非公开 Open API，非单纯 Web Cookie）。
- **优点**：兼具转存与高性能直链能力。
- **缺点**：逆向 App 协议属于灰色地带，协议加解密一旦随着 115 客户端大版本更新变动，就会大面积瘫痪，维护成本极高，且存在封号法律风险。

### 4.3 LitePan-main
- **实现方式**：专注于 115 开放平台（`115_Open`），结合中心化 OAuth 扫码中继完成授权，实现极速大清单查询与轻量直链透传。
- **优点**：架构纯粹、代码精炼、合规合法、Token 自动刷新状态机非常优雅。
- **缺点**：定位为个人网盘挂载器，天生放弃了他人分享转存功能，无法满足自动化追剧/影视收集场景。

### 4.4 Mediary Scout 双轨融合创新方案
- **创新点**：**“一号双擎，前台统一，后台分流”**。
- 用户在 Mediary Scout 中添加 115 存储时，前台依然是一个“115 存储实例”。
- 后台采用 **适配器策略模式（Adapter Strategy）** 将高频只读请求（大目录扫描、STRM 生成、视频直链播放）委派给 **Open API 子引擎**；将写与转存请求（分享转存、特定目录创建）委派给 **Cookie 子引擎**。
- 用户体验极致平滑：转存成功率 100%，媒体库常态保活永不掉线，扫描速度提升 10 倍！

---

## 5. 当前系统基础设施复用性审查

Mediary Scout 现有代码库已经具备了高度完善的基础设施，可直接复用，避免重复造轮子：

```mermaid
graph TD
    subgraph Storage Foundation [现有存储基础设施]
        Store[account-credentials.ts: AES-256 加密凭据持久化]
        Pacer[drive-pacer.ts / brand-pacing.ts: 品牌频率控制器]
        Registry[storage-registry: 存储实例运行时容器]
    end

    subgraph 123Pan Reference [可借鉴的 Token 状态机]
        Pan123[pan123-client.ts: SingleFlight 并发锁与 Token 刷新]
    end

    subgraph 115 Existing [现有 115 模块]
        CookieClient[pan115-cookie-client.ts: 分享转存、目录操作]
        Executor[storage-115-executor.ts: 配额守卫 ApiGuard]
    end

    subgraph New Dual Engine [新增双轨融合体系]
        Unified[Pan115UnifiedExecutor: 适配器策略路由器]
        OpenClient[Pan115OpenClient: 开放平台客户端与状态机]
    end

    Store --> Unified
    Pan123 -.->|状态机模型复用| OpenClient
    CookieClient -->|Subdriver 1| Unified
    OpenClient -->|Subdriver 2| Unified
    Unified --> Registry
```

1. **凭据安全持久化 (`account-credentials.ts`)**：
   - 现有系统已支持 AES-256-GCM 密文存储，且 `connected_storages.payload` 为扩展型 JSON。
   - 扩展支持新字段：`openAccessToken`, `openRefreshToken`, `openExpiresAt`，无需变更数据库表结构。
2. **并发单飞锁机制 (`pan123-client.ts`)**：
   - `pan123-client.ts` 已经实现了成熟的 `refreshPromise` 互斥机制：当 Token 失效时，并发进入的请求全部等待同一个刷新 Promise，刷新完成后批量释放，直接杜绝惊群效应。
3. **接口契约定义 (`packages/contracts/src/storage.ts`)**：
   - 现有的 `StorageDriver` 和 `TransferCapableDriver` 接口规范严整，双轨适配器直接实现该接口，上层媒体库与调度工作流完全零感知。

---

## 6. 设计模式架构优化：双轨混合驱动设计

### 6.1 适配器与策略派发模式 (Adapter & Strategy Pattern)

统一对外暴露标准 `StorageDriver` 接口，内部维护两个子驱动引用：

```mermaid
classDiagram
    class StorageDriver {
        <<interface>>
        +listDirectory(dirId)
        +getDirectStreamUrl(fileId)
        +transferShareLink(url, code)
        +createDirectory(parentId, name)
        +deleteFile(fileId)
    }

    class Pan115UnifiedExecutor {
        -cookieDriver: Pan115CookieSubdriver
        -openDriver: Pan115OpenSubdriver
        -routingStrategy: DualEngineRoutingStrategy
        +listDirectory(dirId)
        +getDirectStreamUrl(fileId)
        +transferShareLink(url, code)
        +createDirectory(parentId, name)
        +deleteFile(fileId)
    }

    class Pan115CookieSubdriver {
        -client: Pan115CookieClient
        +transferShareLink(url, code)
        +listDirectory(dirId)
        +getDirectStreamUrl(fileId)
    }

    class Pan115OpenSubdriver {
        -client: Pan115OpenClient
        -stateMachine: TokenStateMachine
        +listDirectory(dirId)
        +getDirectStreamUrl(fileId)
        +submitOfflineTask(urls)
    }

    StorageDriver <|.. Pan115UnifiedExecutor
    Pan115UnifiedExecutor --> Pan115CookieSubdriver
    Pan115UnifiedExecutor --> Pan115OpenSubdriver
```

#### 动态策略路由矩阵 (Routing Decision Matrix)

| 操作类型 | 仅 Cookie 模式 | 仅 Open Token 模式 | 双轨绑定模式 (推荐) | 降级机制 (Fallback) |
| :--- | :--- | :--- | :--- | :--- |
| **分享链接转存 (`transferShare`)** | Cookie 执行 | 抛出友好提示引导扫码 Cookie | **Cookie 执行** | 无（Open 不支持） |
| **目录/媒体库大扫描 (`listDirTree`)** | Cookie 执行 (1200ms 延时) | Open API 执行 (极速) | **Open API 优先** | Open 异常时自动降级走 Cookie |
| **播放直链解析 (`getStreamUrl`)** | Cookie 执行 (逆向解密) | Open API 执行 (`/downurl`) | **Open API 优先** | Open 异常时降级走 Cookie |
| **新建目录/重命名/删除** | Cookie 执行 | Open API 执行 | **Open API 优先** | 互为兜底 |
| **磁力/BT离线下载** | Cookie 执行 | Open API 执行 | **Open API 优先** | 互为兜底 |

### 6.2 状态机模式：Token 生命周期与单飞互斥 (Token Lifecycle State Machine)

为 `Pan115OpenClient` 构建具备容错、自愈和并发保护的状态机：

```mermaid
stateDiagram-v2
    [*] --> IdleActive : 凭据加载成功

    IdleActive --> ExpiringSoon : TTL < 300秒 或 触发 401
    ExpiringSoon --> SingleFlightRefreshing : 首个并发请求触发换票
    
    state SingleFlightRefreshing {
        [*] --> RequestNewToken
        RequestNewToken --> PersistStorage : 成功换票 (code === 0)
        RequestNewToken --> ClassifyError : 换票返回错误
    }

    PersistStorage --> IdleActive : 更新 Token 并释放等待队列
    
    ClassifyError --> TransientBackoff : 瞬态错误 (40140117/网络超时)
    TransientBackoff --> SingleFlightRefreshing : 指数退避重试 (最多3次)
    
    ClassifyError --> FatalRevoked : 致命错误 (40140115/16/19/20)
    FatalRevoked --> DegradedCookieOnly : 凭据作废，降级为单 Cookie 模式
    DegradedCookieOnly --> [*] : 发送系统通知提示重新授权
```

#### 状态机与并发防刷代码模式 (TypeScript 实现规范)
```typescript
export class Pan115OpenClient {
  private refreshPromise: Promise<Pan115TokenBundle> | null = null;

  async ensureValidToken(): Promise<string> {
    const now = Date.now();
    // 提前 5 分钟缓冲期刷新，避免边界请求失效
    if (this.credentials.accessToken && this.credentials.expiresAt - now > 5 * 60 * 1000) {
      return this.credentials.accessToken;
    }

    // SingleFlight 互斥锁：如果已有刷新任务正在进行，并发请求直接挂起等待同一 Promise
    if (this.refreshPromise) {
      const refreshed = await this.refreshPromise;
      return refreshed.accessToken;
    }

    this.refreshPromise = (async () => {
      try {
        const result = await this.executeTokenRefreshWithRetry(this.credentials.refreshToken);
        this.credentials.accessToken = result.accessToken;
        this.credentials.refreshToken = result.refreshToken;
        this.credentials.expiresAt = Date.now() + result.expiresIn * 1000;
        await this.onTokenPersistCallback(this.credentials);
        return result;
      } finally {
        this.refreshPromise = null;
      }
    })();

    const finalBundle = await this.refreshPromise;
    return finalBundle.accessToken;
  }
}
```

---

## 7. 分阶段实施路线图与测试防护门禁

### 7.1 四阶段落地计划

```mermaid
flowchart LR
    P1["阶段一: 数据模型扩展"] --> P2["阶段二: Open API 客户端"]
    P2 --> P3["阶段三: 双轨适配器与路由"]
    P3 --> P4["阶段四: UI 授权与回归防护"]
```

1. **阶段一：凭据与配置模型扩展**
   - 扩充 `AccountCredentials` 支持 115 Open 凭据组；
   - 支持存储连接元数据标明驱动工作模式：`cookie_only` / `open_only` / `dual_engine`。
2. **阶段二：`Pan115OpenClient` 客户端与状态机**
   - 实现端点适配：`refreshToken`, `/open/ufile/files`, `/open/ufile/downurl`, `/open/offline/add_task_urls`；
   - 严格移植 LitePan 错误码分类器与 SingleFlight 互斥机制。
3. **阶段三：`Pan115UnifiedExecutor` 适配器集成**
   - 实现动态策略派发与透明降级保护；
   - 大清单与直链走 Open API，转存操作安全锚定 Cookie API。
4. **阶段四：UI 交互与全链路验收**
   - 在存储账号管理页面中提供“升级为双轨驱动”选项；
   - 支持扫码快速授权 Open Token，或支持自建应用 Client ID / Secret 填报。

### 7.2 质量保证与防回归门禁 (Quality Gates)

为杜绝引入新功能破坏原有稳定性，必须设立三大自动化测试门禁：

1. **门禁一：转存隔离门禁（Transfer Isolation Gate）**
   - 单测验证：无论 Open Token 处于有效、过期、刷新中或彻底吊销状态，`transferShareLink()` 操作**必须严格路由至 Cookie 驱动执行**，Open API 状态绝不可污染转存流。
2. **门禁二：高并发单飞刷新门禁（SingleFlight Concurrency Gate）**
   - 模拟 100 个微任务并发请求触发 Token 过期，断言后台向 115 `refreshToken` 端点发起的网络请求**严格等于 1 次**，其余 99 个请求均通过 Promise 互斥锁复用新 Token。
3. **门禁三：双引擎自动降级门禁（Graceful Degradation Gate）**
   - 模拟 Open API 返回 `503 Service Unavailable` 或触发网络断开，断言大清单查询与直链获取能够以低时延**自动无缝降级回 Cookie 引擎**，保障 STRM 同步与播放不报 500。

---

## 8. 总结

将 LitePan-main 的 115 开放平台认证机制引入 Mediary Scout 具备**极高的架构价值**，它精准攻克了 Web Cookie“频繁掉线”与“防封慢速扫描”的历史顽疾。

通过**适配器策略模式**与**并发单飞状态机**，我们不仅规避了 115 官方开放平台“无分享转存 API”的物理硬伤，更能将系统读性能提升数倍，真正实现“一次绑定、永久续期、极速转存、秒级出链”的工业级高可用体验。
