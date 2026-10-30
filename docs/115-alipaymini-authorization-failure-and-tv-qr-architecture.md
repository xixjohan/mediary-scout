# 115 扫码鉴权失败（502 Bad Gateway / 支付宝小程序失效）深度调研与架构治理方案

> **状态**：已落地并执行  
> **日期**：2026-10-30  
> **涉及模块**：`packages/workflow/src/pan115-qrcode-login.ts`、`apps/web/app/api/115/qrcode/confirm/route.ts`、`apps/web/lib/workflow-runtime.ts`、`apps/web/components/pan115-qr-connect.tsx`

---

## 1. 现象溯源与问题本质 (Root Cause Analysis)

### 1.1 报错现象
用户在网盘连接设置页尝试授权 115 网盘时，浏览器控制台抛出高危错误：
```text
Failed to load resource: the server responded with a status of 502 (Bad Gateway)
```
用户提出核心疑问：**“为什么 115 支付宝授权失败？”**

### 1.2 问题本质的多层拆解
经过全链路排查，该故障是由**“文案诱导认知偏差”**、**“上游官方通道下架”**与**“网关状态码粗暴映射”**三重叠加导致的系统性问题：

```mermaid
flowchart TD
    A["用户在 UI 看到：支付宝小程序（推荐，长效）"] --> B["用户误以为是支付宝授权或用支付宝扫码"]
    B --> C["实际二维码为 115 协议二维码 https://115.com/scan/dg-xxx"]
    C --> D["用户使用 115生活 App 扫码并确认"]
    D --> E["前端发送确认请求 POST /api/115/qrcode/confirm { app: 'alipaymini' }"]
    E --> F["后端请求 115 官方端点 /app/1.0/alipaymini/1.0/login/qrcode/"]
    F --> G["115 官方早前已彻底下架 alipaymini 通道"]
    G --> H["115 官方返回：老乡验证失败！/ 登录失败，系统已下架！"]
    H --> I["Pan115QrLoginClient 抛出 PAN115_QR_EXCHANGE_FAILED 异常"]
    I --> J["confirm/route.ts 盲目 catch 并一律返回 HTTP 502"]
    J --> K["浏览器控制台报 502 Bad Gateway，掩盖真实业务原因"]
```

#### ① 认知偏差与文案误导（Cognitive Illusion）
* 前端 `pan115-qr-connect.tsx` 原先下拉选项首位且默认选中值为：
  `{ value: "alipaymini", label: "支付宝小程序（推荐，长效）" }`。
* 文案带有“支付宝小程序”，导致大量用户误以为这是“支付宝账号授权”或直接掏出手机支付宝扫码。但 115 扫码端点下发的二维码实际是 `https://115.com/scan/dg-${uid}`，只能由手机端的**【115生活 App】**扫码识别，支付宝直接扫只会当成普通网页链接跳出或报错。

#### ② 协议层失效：115 官方全面下架 `alipaymini`（Protocol Deprecation）
* 115 历史上有过多个终端标识（`web`, `android`, `ios`, `tv`, `alipaymini`, `wechatmini`, `qandroid`）。
* **115 官方已在近年风控收敛中，彻底关闭并下架了 `alipaymini`（支付宝小程序）和 `wechatmini`（微信小程序）的扫码换票接口**。
* 当客户端请求 `https://passportapi.115.com/app/1.0/alipaymini/1.0/login/qrcode/` 时，115 接口统一返回 `{"state":0, "error":"老乡验证失败！", "errno":40101017}` 或 `"登录失败，系统已下架！"`，且不返回任何 `UID` / `CID` / `SEID` 凭证。

#### ③ 网关状态码扭曲（Semantic Gateway Confusion -> 502）
* 检查 `apps/web/app/api/115/qrcode/confirm/route.ts` 原逻辑：
  ```typescript
  try {
    const result = await completePan115QrLogin(...);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof StorageOwnedByOtherAccountError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: (error as Error)?.message || "登录失败" },
      { status: 502 }, // ❌ 严重语义错误：将业务失败当成了基础设施崩溃
    );
  }
  ```
* 上游业务端点返回“系统已下架”或换票拒绝，属于典型的**上游业务验证拒绝（HTTP 422 Unprocessable Content / HTTP 400）**，绝非网关不可达（502 Bad Gateway）。
* 盲目返回 502 会导致 Chrome DevTools、反向代理（Nginx/Cloudflare）以及 APM 监控把正常的业务拒绝当作服务不可用严重故障报警。

---

## 2. 参考原仓库历史逻辑与盲区复盘 (Upstream & History Review)

### 2.1 原仓库的历史设计追踪
* 在 commit `091e7a3`（`feat: 115 QR-code login — scan to connect, cookie persisted in DB`）及设计文档 `docs/research/2026-06-12-115-qrcode-login.md` 中，原作者记录了当时的选型考量：
  > “115 每客户端类型（ssoent）只允许一个活跃会话，以类型 X 登录会踢掉已有 X 会话... `alipaymini` / `wechatmini` / `tv` 用户几乎不会自然登录，cookie 实质长效；社区推荐默认 `alipaymini`。”
* **致命盲区**：原作者在提交记录中坦承：
  > *“Live-verified to the real QR render + polling; the phone-scan confirm step is left for the user.”*
  原作者**仅在本地 mock 测试了取 Token 和长轮询状态，从未用真实手机 App 扫码跑完第 3 步换票确认**！因此当官方下架小程序接口后，该隐患一直潜伏在默认配置中。

---

## 3. 业界主流开源方案调研与横向对比 (Industry Benchmark)

我们对业界处理 115 认证的主流开源库进行了深度调研：

### 3.1 业界主流工具与库的现状
1. **AList (`alist-org/alist`) 与 `SheltonZhu/115driver` (Go)**：
   * AList 官方使用指南明确警告：**“请勿选择 alipaymini、wechatmini、web、android 作为扫码源，请统一选择 `tv`（电视端）”**。
   * `tv` 端是目前唯一被官方长期保留、协议稳定、且**拥有独立会话空间（绝不踢掉手机 App 和电脑网页端）**的扫码源。
2. **`ChenyangGao/p115client` (Python)**：
   * 115 逆向生态中最活跃的 Python SDK，其设备映射表明确将默认扫码设备设为 `qandroid` 或 `tv`，并在 Issue 中多次确认 `alipaymini` 已废弃下架。
3. **OpenList (`OpenListTeam/OpenList-APIPages`)**：
   * 在扫码登录逻辑中全面剔除了已失效的小程序通道，推荐 `tv` 端。

### 3.2 方案对比矩阵 (Comparison Matrix)

| 方案 / 渠道 | 官方活跃状态 | 稳定性 | 防顶号能力 (互踢隔离) | 维护成本 | 结论与评级 |
|:---|:---:|:---:|:---:|:---:|:---:|
| **电视端 (`tv`)** | **长期活跃** | **极高 (长青稳定)** | **完全免疫 (独立会话)** | **极低 (当前系统原生支持)** | **★★★★★ 业界黄金标准** |
| **安卓通道 (`qandroid`)** | 正常活跃 | 高 | 较好 (可能与特定安卓客户端微冲突) | 低 | ★★★★☆ 推荐备用 |
| **支付宝小程序 (`alipaymini`)** | **官方已下架** | **失效 (不可用)** | 无法换取票据 (报 40101017) | 无法维护 | ❌ **必须废弃并告警** |
| **微信小程序 (`wechatmini`)** | **官方已下架** | **失效 (不可用)** | 无法换取票据 | 无法维护 | ❌ **必须废弃并告警** |
| **网页端 (`web`)** | 正常活跃 | 差 (极易被顶) | 只要电脑打开 115.com 立即互踢失效 | 低 | ★★☆☆☆ 仅限临时调试 |
| **开放平台 PKCE (`open`)** | 正常活跃 | 高 | 独立 Token | 极高 (需 AppID，缺少 webapi 离线与转存) | ★★☆☆☆ 无法满足全量功能 |

---

## 4. 当前系统基础设施复用确认 (Infrastructure Reuse)

当前仓库已经具备了完善的基础设施，无需引入任何外部大包即可完美修复：

1. **已有的客户端支持**：
   `packages/workflow/src/pan115-qrcode-login.ts` 的 `PAN115_QR_LOGIN_APPS` 原生已包含 `"tv"`。只需调整默认值与排序，并引入 `"qandroid"`。
2. **免代理白名单与错误栈格式化**：
   `apps/web/lib/http-proxy.ts` 已经实现了 `DEFAULT_DOMESTIC_NO_PROXY`（内置 `*.115.com` 直连）与 `formatNetworkError(error)`。在 `confirm/route.ts` 中复用它即可展开底层网络堆栈。
3. **夸克/UC 家族成熟的 QR 状态机实践**：
   `apps/web/app/api/cloud-family/qrcode.ts` 已经验证了清晰的状态码分类（400 参数缺失、409 账号冲突、422 业务拒绝、502 网络故障），115 路由应保持完全对齐。

---

## 5. 具体解决方案与架构改造 (Detailed Implementation)

### 5.1 领域模型与客户端改造 (`packages/workflow`)
* **调整默认客户端**：在 `Pan115QrLoginClient.exchangeCookie` 中，将缺省 `app` 从 `"alipaymini"` 变更为 **`"tv"`**。
* **扩充合法设备列表**：将 `PAN115_QR_LOGIN_APPS` 更新为 `["tv", "qandroid", "android", "ios", "web", "alipaymini", "wechatmini"]`，将 `tv` 置于首位。
* **定义专用业务异常类**：引入 `Pan115QrExchangeError`，当 115 官方返回“老乡验证失败”或“系统已下架”等无 Cookie 响应时抛出结构化异常，便于网关层精准识别业务错误。

### 5.2 前端引导与文案重构 (`apps/web/components/pan115-qr-connect.tsx`)
* **更新下拉选项**：
  * 首位与默认：`{ value: "tv", label: "电视端（推荐，长效且不挤掉手机/网页）" }`
  * 备用：`{ value: "qandroid", label: "Android 备用通道（长效）" }`
  * 标记失效通道：`{ value: "alipaymini", label: "支付宝小程序（官方已下架，已失效）" }` 与 `{ value: "wechatmini", label: "微信小程序（官方已下架，已失效）" }`
* **强化扫码提示**：
  * 提示文案明确修改为：**“请使用手机【115生活 App】扫码（切勿使用支付宝或微信直接扫码）”**。
  * 扫码状态提示：“用 115生活 App 扫码”。

### 5.3 网关状态码与错误映射治理 (`apps/web/app/api/115/qrcode/confirm/route.ts`)
* **区分业务拒绝与网关故障**：
  * 若为 `StorageOwnedByOtherAccountError`：返回 **HTTP 409**；
  * 若为 `Pan115QrExchangeError` 或业务错误（如“系统已下架”、“老乡验证失败”）：返回 **HTTP 422**，向前端传递真实业务原因，绝不返回 502；
  * 若为底层连接失败（`fetch failed` / `ECONNREFUSED` / `ETIMEDOUT`）：返回 **HTTP 502**，并调用 `formatNetworkError(error)` 展开底层 cause。

---

## 6. 同类门禁与防回归测试 (Regression Guards)

为彻底杜绝同类失效或错误映射再次发生，建立三级防线：

1. **驱动层单元测试 (`packages/workflow/tests/pan115-qrcode-login.test.ts`)**：
   * 验证 `Pan115QrLoginClient` 默认使用的 `app` 为 `"tv"`；
   * 验证 `qandroid` 正常发送对应请求报文；
   * 验证当 115 接口返回 `state: 0` 且无 Cookie 时，精准抛出 `Pan115QrExchangeError` 并携带原始错误文本（包括兼容 `error` 与 `message` 字段）。
2. **API 路由门禁测试 (`apps/web/app/api/115/qrcode/confirm/route.test.ts`)**：
   * 验证业务换票失败返回 **HTTP 422**（而非 502）；
   * 验证账号重复绑定冲突返回 **HTTP 409**；
   * 验证纯网络基础设施故障返回 **HTTP 502** 且携带展开的堆栈原因。
3. **架构静态门禁**：
   * 禁止在 UI 默认选项中把已失效的小程序通道置为推荐选项。
