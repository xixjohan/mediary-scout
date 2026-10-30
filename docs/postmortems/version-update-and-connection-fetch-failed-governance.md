# 容器版本更新受阻与网盘连接失败深度调研与治理规范

## 1. 现象调研与问题诊断

在 `http://10.126.1.70:3000/settings` 运行环境中，用户反馈了以下连续问题：

1. **版本更新未生效**：执行 `docker pull ghcr.io/xixjohan/mediary-scout:latest` 并重启容器后，设置页面仍提示：
   > `有新版本可用 当前 18f27d14 · 开发版本 · 新版本 v2026.10.30.9。去「更新」看看改了什么。`
2. **115 网盘目录待建与连接失败**：
   - 115 账号 `3204551` 状态显示「目录待建」；
   - 点击「测试连接」按钮弹出报错：`连接检测失败：TypeError: fetch failed`。
3. **网络与 DNS 疑问**：
   - 用户提出：「是否是 DNS 解析问题？由于直连优先使用了 IPv6 导致 115 解析到了错误地址？」
4. **LinuxWebTool MCP 远端控制受限**：
   - 用户配置了 LinuxWebTool (`http://10.126.1.60:5270/mcp/sse`)，但调用时返回空工具列表 `{"tools": []}`，REST API 提示 `该 API Key 对所请求的业务模块无权访问`。

---

## 2. 根因剖析 (Root Causes)

经过代码追溯、GitHub Actions 运行日志核查以及内网实时探测，问题根因如下：

### 2.1 根因一：GitHub Actions Docker 构建失败导致 GHCR latest 镜像停滞

- 在提交 `174b1d8` 中，[`apps/web/lib/workflow-runtime.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/workflow-runtime.ts) 的自愈函数形参使用了 `existing: ConnectedStorage`，但文件顶部仅导入了 `type StorageProvider` 等，**遗漏了 `type ConnectedStorage`**。
- GitHub Actions 触发 `Release Docker` 工作流（Run ID: `41105538384`），在执行 `RUN npm run build:web` 时抛出致命 TypeScript 错误：
  ```text
  Type error: Cannot find name 'ConnectedStorage'. Did you mean 'ConnectedStorageView'?
  ./lib/workflow-runtime.ts:3555:13
  ./lib/workflow-runtime.ts:3696:13
  ```
- **后果**：Docker 构建中断，镜像未被推送到 GHCR。GHCR 上 `latest` 标签仍停留在上次成功构建的 commit `18f27d14`。用户执行 `docker pull` 拉取的依然是旧镜像 `18f27d14`，应用启动时读取 `/app/BUILD_COMMIT` 发现是 `18f27d14`，比对 GitHub 上的最新标签 `v2026.10.30.9` 后自然持续提示有新版本。

### 2.2 根因二：旧版镜像缺失原地自愈能力，目录维持「目录待建」

- 在 `18f27d14` 阶段，系统尚未合并 `f047b43`（解绑/重连/测试连接时的 `healDriveProvisioning` 目录补建机制）。
- 存量网盘如果初次连接时因未配置环境变量或初始化跳过导致 `rootCid` 为空，在旧镜像中点击「测试连接」仅会执行探活，不会自动补建 `影视/电视剧/动漫` 分类目录，导致一直处于「目录待建」状态。

### 2.3 根因三：`NO_PROXY` 白名单被移除，请求经境外代理触发阿里云盾 WAF 405 拦截

- 用户在单容器命令中使用了如下参数：
  ```bash
  -e HTTP_PROXY="http://10.126.1.100:2080"
  -e HTTPS_PROXY="http://10.126.1.100:2080"
  -e NO_PROXY="localhost,127.0.0.1,host.docker.internal,10.,192.168.,172.16.,..."
  ```
- **关键问题**：原规范中的国内网盘白名单（`115.com,*.115.com,.115.com,115cdn.com,quark.cn,123pan.com,189.cn,douban.com`）被清空，同时 `10.` / `192.168.` 等非标准写法在部分解析库中无法匹配。
- **实测结果**：Node.js Undici 将发往 `https://webapi.115.com/files` 的请求路由至代理 `10.126.1.100:2080`。经实测直接请求，115 后端的阿里云盾（Yundun WAF）立即拦截机房/境外代理 IP，返回 HTTP 405 阻断页面：
  ```html
  <title>405</title>
  很抱歉，由于您访问的URL有可能对网站造成安全威胁，您的访问被阻断。
  ```
- 此外，旧镜像 `18f27d14` 的 `testConnection` 未解包 `error.cause`，将连接重置（RST）或超时直接格式化为裸 `TypeError: fetch failed`，掩盖了真实成因。

### 2.4 根因四：DNS 解析与 IPv6 优先问题辨析

针对用户的疑问「是否是 DNS 解析问题？由于直连优先使用了 IPv6 导致 115 解析到了错误地址？」：

1. **权威 DNS 实测验证**：
   - 查询 `webapi.115.com` 的 A 记录：返回 `47.113.23.100`（CNAME 指向 `yundunwaf1.com`）。
   - 查询 `webapi.115.com` 的 AAAA 记录：**完全不存在 IPv6 记录**。
   - 查询 `115.com`：仅有 IPv4 `47.113.24.196`，**无 IPv6 记录**。
   - **结论**：115 官方未为核心 API 配置 IPv6，因此并非 115 解析到了错误的 IPv6 地址。
2. **容器与 Node.js 双栈风险**：
   - Node 17+ 默认将 DNS 解析顺序改为 `verbatim`（优先保留操作系统返回的顺序，双栈环境下通常 IPv6 优先）。
   - 在 Docker Bridge 网络默认未启用 IPv6 路由的环境下，若本地路由器或 DNS 返回了虚假的 IPv6 响应或 AAAA 查询产生超时丢包，可能导致容器网络悬挂 5~10 秒。
   - **加固手段**：在 Next.js 服务启动入口显式调用 `dns.setDefaultResultOrder('ipv4first')`，确保在任何 Docker 宿主环境下均锁定 IPv4 快速直连。

### 2.5 根因五：LinuxWebTool API Key 权限配置缺失

- 探查 `http://10.126.1.60:5270` 前端源码 [`apps/web/views/ApiKeysView.js`](file:///http://10.126.1.60:5270/app/views/ApiKeysView.js) 发现：
  - LinuxWebTool 采用严格的模块级 RBAC 权限控制；
  - 默认新建的 API Key 其 `allowRemoteHosts`（远程主机）为 `false`，且 `allowedTools`（允许的 MCP 工具列表）默认为空数组；
  - 因此 MCP SSE 服务端握手成功但返回 `tools: []`，REST 接口响应 `该 API Key 对所请求的业务模块无权访问`。

---

## 3. 业界主流方案与系统现有设施对比

| 维度 | 业界主流实践 | Mediary Scout 现有方案 | 本次改进方案 |
| :--- | :--- | :--- | :--- |
| **CI/CD 构建门禁** | Docker 镜像构建前必须经过本地与 CI 静态类型检查 (`tsc --noEmit`) | 仅依赖 Dockerfile 内 `npm run build:web`，失败在 CI 晚期暴露 | CI 工作流和发布工作流前置类型校验，本地构建完备验证 |
| **代理与白名单** | 严格区隔外网服务（TMDB）与境内直连（国内网盘），使用 CIDR 规范私网地址段 | `resolveMergedNoProxy` 自动合并境内网盘域名 | 保持自动合并机制，并在 README 与使用示例中规范标准 CIDR (`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`) 与境内域名 |
| **Node.js 容器 DNS** | 针对无公网 IPv6 容器环境注入 `ipv4first` | 依赖 Node 默认 `verbatim`，易受路由器双栈干扰 | 在 [`apps/web/instrumentation.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/instrumentation.ts) 启动时全局设置 `dns.setDefaultResultOrder("ipv4first")` |
| **网络错误透传** | 展开 Undici 的 `.cause`、错误码 (`ECONNREFUSED` / `ETIMEDOUT`) 与 HTTP 状态 | 直接 `String(error)`，展示为泛化 `TypeError: fetch failed` | 使用 [`formatNetworkError`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/http-proxy.ts) 展开底层错误码与消息，并在 WAF 405 拦截时明确提示 |
| **网盘目录状态自愈** | 检测连接与刷新时幂等补全必备目录树 | `healDriveProvisioning` 与 `healMissingCidsOnRefresh` | 修复编译引用，测试连接时原地补建并持久化 CIDs，消除「目录待建」 |

---

## 4. 实施变更清单

### 4.1 修复 TypeScript 编译缺失导入

- 修改 [`apps/web/lib/workflow-runtime.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/workflow-runtime.ts)：
  - 从 `@media-track/workflow` 补齐 `type ConnectedStorage` 导入；
  - 引入 [`formatNetworkError`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/http-proxy.ts) 并应用于 `testConnection` 异常捕获中。

### 4.2 容器启动加固 IPv4 优先解析

- 修改 [`apps/web/instrumentation.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/instrumentation.ts)：
  ```typescript
  try {
    const dns = await import("node:dns");
    if (typeof dns.setDefaultResultOrder === "function") {
      dns.setDefaultResultOrder("ipv4first");
    }
  } catch {
    // 忽略特定运行时环境
  }
  ```

### 4.3 115 客户端与代理错误提示强化

- 修改 [`packages/workflow/src/pan115-cookie-client.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/pan115-cookie-client.ts)：
  - 当 115 返回 405 状态码或 HTML 阻断页面时，明确抛出：`PAN115_WAF_BLOCKED: 115 安全网关阻断了请求 (405)，请检查是否配置了代理或白名单`；
  - 避免 HTML 导致的 `SyntaxError` 掩盖真实网络安全拦截。
- 修改 [`apps/web/lib/http-proxy.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/http-proxy.ts)：
  - `formatNetworkError` 提取 `cause.code`（如 `[ECONNREFUSED]`、`[ETIMEDOUT]`），格式化为清晰的诊断文案。

---

## 5. 验证与门禁测试

1. **类型检查与构建验证**：
   - 执行 `npm run build:workflow`：成功。
   - 执行 `npx tsc -p apps/web/tsconfig.json --noEmit`：0 错误通过。
   - 执行 `npm run build:web`：生产打包成功（74 个页面静态与动态编译完全正常）。
   - 执行 `npm run lint`：0 warning，圈复杂度与行数限制完全合规。
2. **单元测试与自愈测试**：
   - 运行 `npx vitest run apps/web/instrumentation.test.ts apps/web/lib/http-proxy.test.ts apps/web/lib/pan115-directory-provisioning.test.ts packages/workflow/tests/pan115-cookie-client.test.ts`：全部 33 项用例 100% 通过。

---

## 6. 用户操作指南 (宿主机与 LinuxWebTool)

### 6.1 LinuxWebTool 权限开通说明

在 `http://10.126.1.60:5270` 控制台中：
1. 点击左侧导航栏 **密钥管理 (API Keys)**；
2. 找到当前 API Key `lwt_live_1af0ae0b8eacf803c73ceeaebc1c7f84`，点击 **编辑**；
3. 勾选 **允许 MCP (allowMcp)**；
4. 勾选 **允许远程主机管理 (allowRemoteHosts)** 与 **允许终端执行 (allowTerminal)**；
5. 在 MCP 工具列表中勾选需要开放给 AI 助手的工具（或选择全选）；
6. 点击 **保存更新**。保存后，MCP 客户端即可识别工具并对 `10.126.1.70` 执行诊断指令。

### 6.2 规范的 Docker 运行命令

待最新版本构建推送到 GHCR 后，在宿主机执行以下命令部署：

```bash
# 1. 拉取修复编译后的新镜像
docker pull ghcr.io/xixjohan/mediary-scout:latest

# 2. 停止并移除旧容器
docker stop mediary && docker rm mediary

# 3. 运行新容器（国内网盘直连白名单 + 标准 CIDR 私网段）
docker run -d \
  --name mediary \
  --restart unless-stopped \
  -p 3000:3000 \
  -v mediaray-data:/app/data \
  -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db \
  -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb \
  -e MEDIA_TRACK_WORKER_MODE=inprocess \
  -e MEDIA_TRACK_DEMO_SEED=0 \
  -e HTTP_PROXY="http://10.126.1.100:2080" \
  -e HTTPS_PROXY="http://10.126.1.100:2080" \
  -e NO_PROXY="localhost,127.0.0.1,host.docker.internal,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,115.com,.115.com,115cdn.com,.115cdn.com,anxia.com,.anxia.com,quark.cn,.quark.cn,uc.cn,.uc.cn,123pan.com,.123pan.com,189.cn,.189.cn,douban.com,.douban.com" \
  ghcr.io/xixjohan/mediary-scout:latest

# 4. 查看启动日志
docker logs -f mediary
```
启动后进入设置页面，对 115 网盘点击「测试连接」，系统将自动探活并原地补建分类目录，状态将即刻变更为「连接正常，目录已初始化就绪」。
