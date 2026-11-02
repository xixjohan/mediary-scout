# 巡影 · 单用户局域网免密开箱与纵深防御安全架构规范 (Single-User LAN Auth & Defense-in-Depth Spec)

> **文档版本**: 1.0.0  
> **适用范围**: `apps/web/proxy.ts`, `apps/web/platform/next-context/page-auth-guard.ts`, `apps/web/features/auth/**/*`  
> **核心主题**: 局域网开箱即用、无硬编码默认弱口令、动态密码生命周期、防公网抢占隔离  

---

## 1. 为什么没有默认密码？设计理念与安全哲学

在传统路由器、NAS 或 Docker 工具中，经常能看到预置固定出厂密码（如 `admin/admin`、`root/123456`）的做法。**巡影（Mediary Scout）在架构设计之初便坚决摒弃了任何硬编码默认弱口令**，其核心原因如下：

### 1.1 杜绝公网扫描器与全网自动化漏洞入侵
- 无论是部署在家庭 NAS、云服务器还是轻量主机上，一旦用户配置了公网端口映射、DDNS 或反向代理，暴露在公网上的端口会在数秒内被全网扫描器（如 Shodan、Censys、ZoomEye 等自动化爬虫）探测；
- 如果系统存在预置默认密码，只要用户部署后未第一时间手动修改，攻击者便可利用默认口令直接爆破并接管系统，导致绑定的网盘 Token / Cookie 泄露、存储文件被清空或影视隐私数据外泄；
- **巡影出厂安全基准**：系统代码和数据库初始化阶段**不植入任何固定密码**，从物理上杜绝弱口令字典攻击。

### 1.2 局域网零摩擦开箱即用 (Zero-Friction Out-of-the-Box)
- 自建影音与媒体工具（如 Jellyfin、Plex、Sonarr 等）的用户普遍希望完成 `docker run` 或 `npm run dev` 后，在家庭内网（LAN）下能第一时间直达面板，验证网盘挂载与影视检索能力，而无需查阅长篇文档寻找初始凭据；
- 因此，系统确立了**「局域网首次免密直达，设置密码后全网强制收紧」**的渐进式安全模型。

---

## 2. 身份裁决与纵深防御矩阵 (Security Matrix)

系统的身份裁决由 `proxy.ts`（Edge 网关）、`page-auth-guard.ts`（页面守护组件）与 `identity-resolver.ts`（核心领域纯函数裁决器）多层协同完成。

### 2.1 单用户模式三态矩阵

| 请求来源网络 | 密码状态 (`hasPassword`) | Session 凭据 | 裁决结果 | 用户交互体验 |
| :--- | :--- | :---: | :---: | :--- |
| **局域网 (LAN)**<br>`10.x.x.x` / `192.168.x.x` | **未设置 (`false`)** | 无 | `DEFAULT_ACCOUNT_ID`<br>**(放行)** | 直接进入主面板（`/` 或 `/?tab=library`），左下角显示管理员身份，可开箱体验 |
| **局域网 (LAN)**<br>`10.x.x.x` / `192.168.x.x` | **已设置 (`true`)** | 无 | `UNAUTHENTICATED`<br>**(阻断)** | **全链路收紧**：自动重定向至 `/login`，输入设定的管理员密码后方可访问 |
| **局域网 (LAN)** | **已设置 (`true`)** | 有有效 Cookie | `DEFAULT_ACCOUNT_ID`<br>**(放行)** | 校验通过，正常访问 |
| **远程/公网 (Remote)**<br>经 Cloudflare/反代隧道 | **未设置 (`false`)** | 无 | `UNAUTHENTICATED`<br>**(阻断)** | 强制重定向至 `/login`，**且禁止公网访客设置初始密码**（提示必须回到局域网完成设密） |
| **远程/公网 (Remote)** | **已设置 (`true`)** | 无 | `UNAUTHENTICATED`<br>**(阻断)** | 强制重定向至 `/login`，凭管理员账号密码登录 |

---

## 3. 防公网抢占隔离机制 (Remote-First Protection)

当实例在公网被暴露但尚未设密时，存在一种极端攻击路径：**外部黑客抢先打开实例并设置自己的密码，从而把合法站长反锁在外**。

为了彻底消除该攻击面，系统在 `apps/web/proxy.ts` 与 `app/login/page.tsx` 中实施了严格的**反抢占断言**：

1. **远程请求特征识别 (`isRemoteRequest`)**：
   通过物理标头（`cf-ray`、`cdn-loop`、`cf-connecting-ip`）精确判定请求是否越过局域网边界；
2. **首次设密白名单约束**：
   - 当 `isRemote === true` 且 `passwordState === false` 时，`/login` 页面不会呈现「设置新密码」表单，而是呈现安全警示：
     > *“实例尚未设置访问密码。出于安全考虑，为防止外网访客抢占管理员权限，初次设置密码必须在家庭局域网内进行。”*
   - 后端 `POST /api/auth/password` 端点在 `passwordState === false` 时，同样硬编码拒绝任何携带远程标记的请求，只有直连局域网的请求才被允许完成首次设密。

---

## 4. 关键架构实现链路 (Implementation Traces)

### 4.1 核心裁决器：`identity-resolver.ts`
```ts
// apps/web/features/auth/core/identity-resolver.ts
export function resolveSingleUserAccountId(opts: {
  hasPassword: LoginPasswordState;
  isRemote: boolean;
  sessionAccountId: string | null;
}): string {
  // 未设密码 且 处于局域网（LAN）下：授予站长默认账号
  if (!opts.isRemote && opts.hasPassword !== true) {
    return DEFAULT_ACCOUNT_ID;
  }
  // 设了密码 或 处于远程访问下：必须持有合法的管理员 Session
  if (opts.sessionAccountId === DEFAULT_ACCOUNT_ID) {
    return DEFAULT_ACCOUNT_ID;
  }
  return UNAUTHENTICATED_ACCOUNT_ID;
}
```

### 4.2 页面级登录守卫：`page-auth-guard.ts`
```ts
// apps/web/platform/next-context/page-auth-guard.ts
export function shouldRedirectToLogin(input: PageAuthGuardInput): boolean {
  if (!input.guarded) return false;
  if (input.hasSession) return false;
  // 一旦密码被设置（passwordState === true），即使在局域网内未登录也会触发跳转 /login
  return input.passwordState === true;
}
```

### 4.3 网关层预拦截：`proxy.ts`
```ts
// apps/web/proxy.ts
export function proxy(request: NextRequest): NextResponse {
  const multiUser = process.env.MEDIA_TRACK_MULTI_USER === "1";
  // 远程流量或多用户模式下，一律拦截
  const gated = multiUser || isRemoteRequest(request);
  ...
}
```

---

## 5. 操作指引与安全加固 (Hardening Guide)

### 5.1 方式一：设置管理员密码（推荐）
在部署完成并体验开箱功能后，建议立即设置管理员密码：
1. 访问面板并进入 **「设置」** 页面 (`http://<ip>:<port>/settings`)；
2. 找到 **「修改密码」** 面板（或点击左下角个人信息弹出菜单）；
3. 输入并确认您的专属高强度管理员密码并保存；
4. **生效效果**：
   - 实例状态由 `passwordState = false` 跃迁为 `passwordState = true`；
   - 系统立刻激活 **S5.7 契约**，局域网与外网均必须凭密码登录；
   - 任何未登录终端再次刷新，均会被优雅重定向至 `/login`。

### 5.2 方式二：开启多用户企业/家庭共享模式 (Multi-User RBAC)
若需要为家庭成员或不同用户提供独立的搜索偏好、网盘隔离与工单权限：
1. 在环境变量文件（如 `env/.envdev` 或 Docker Compose）中增加：
   ```env
   MEDIA_TRACK_MULTI_USER=1
   ```
2. 重启服务后，系统将彻底关闭单用户免密通道，首屏直接进入「认领站长账号（Claim Instance）」向导，支持多用户注册与基于角色的访问控制（RBAC）。
