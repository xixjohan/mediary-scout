# 巡影 (Mediary Scout) 智能体协作指南 (AGENTS.md)

> 本文档专为跨会话的 AI Coding Agent 及工程开发者编写，旨在提供统一、标准化、即开即用的环境指引、双轨制部署流程、解耦推送策略与内置浏览器实机验收规范。

---

## 1. 核心架构与技术栈速览

- **前端与全栈运行时**：Next.js (App Router, Turbopack, React 19, TypeScript 5.9)，支持 SSR / Streaming / Suspense 与 Standalone 独立服务端输出。
- **媒体与核心服务架构**：
  - **PanSou 检索微服务**：外部 Docker 容器服务（端口 5280），提供多源网盘搜索与资源频道聚合。
  - **存储适配层**：115 网盘（真实 Cookie / PickCode 直链解析）、Quark、本地 STRM 虚拟流媒体映射。
  - **Worker 调度体系**：任务队列常驻 Drain 机制，支持 `external`（独立进程）与 `inprocess`（Web 进程内轻量闭环）双模式。
  - **持久化引擎**：纯 SQLite 单文件引擎（WAL 模式，`/app/data/mediary.db`），零外部数据库容器依赖。
- **凭据与敏感环境隔离**：
  - 宿主机连接信息、SSH 私钥、115 Cookie、STRM 真实测试参数统一保存在 `env/.envdev` 中。
  - `env/.envdev` 由 `.gitignore` 严格忽略，**严禁提交至 Git 版本库**。

---

## 2. 部署双轨制（Dual-Track Deployment Pipeline）

为了彻底解决“正式发版多架构镜像构建过慢”与“日常功能敏捷迭代需要真实 Linux 实机与网盘环境验证”之间的矛盾，系统提供 **双轨制并行部署架构**：

| 维度 | 方案 A：极速开发部署管线 (`-Mode Dev`) | 方案 B：官方正式发布管线 (`-Mode Official`) |
| :--- | :--- | :--- |
| **定位** | 日常开发、功能调试、Bug 修复、敏捷实机验收 | 正式发版、合并交付、生产环境发布 |
| **容器实例** | `mediary-dev` | `mediary` |
| **对外端口** | **3020** (`-p 3020:3000`) | **3000** (`-p 3000:3000`) |
| **构建方式** | 远程 Linux 宿主机 Docker 本地快速构建 (`Dockerfile.dev`) | GitHub Actions 云端 Multi-Arch 镜像编译发布 |
| **镜像标签** | `mediary:dev` | `ghcr.io/xixjohan/mediary-scout:latest` |
| **代码同步** | **解耦 Git 依赖**，本地工作区 SSH 流式直推 (`tar.exe` -> `ssh`) | Git Commit + Push Tag 触发云端 CI/CD 构建 |
| **发布耗时** | **约 30 ~ 50 秒**（静态资源热更约 **2 秒**） | **约 20 秒**（直接拉取已编译好的 Release 镜像） |
| **生产影响** | **完全零影响**（3000 端口生产容器与业务全程保持运行） | 重建 3000 生产容器 |
| **数据目录** | 独立隔离卷 `mediary-dev-data` | 生产数据卷 `mediaray-data` |
| **Worker 模式**| `MEDIA_TRACK_WORKER_MODE=inprocess` (单容器闭环) | 生产标准编排 (external 或 inprocess) |

---

## 3. 两套方案具体使用方法

统一使用根目录自动化脚本 [`scripts/deploy-remote.ps1`](file:///scripts/deploy-remote.ps1) 执行所有操作：

### 方案 A：Linux 极速本地开发验证管线 (默认推荐)

#### 1. 全量工作区快速验证（Auto 智能自适应）
直接执行开发部署，无需手动传递复杂参数：
```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev
```
> **自适应行为 (Auto Strategy)**：
> - **若 Git 工作区干净（Clean）**：自动选用 `GitArchive` 策略，打包最新的 HEAD Commit，享受 100% 纯净度与版本溯源标签。
> - **若存在未提交/未暂存修改（Dirty）**：自动切换为 `Direct` 策略，使用原生 `tar.exe` 毫秒级打包当前实时工作区（严格排除 `.git`、`node_modules`、`.next`、`run`、`data`、`env`），确保本地刚刚修改的实时代码立即在远程生效。

#### 2. 代码同步策略显式指定（备选方案）
支持通过 `-SyncMethod` 参数显式覆盖自适应逻辑：
```powershell
# 策略 1: Auto (默认) - 干净则 GitArchive，脏工作区则 Direct
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev -SyncMethod Auto

# 策略 2: Direct - 强制直推本地实时工作区（完全解耦 Git，包含未提交代码）
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev -SyncMethod Direct

# 策略 3: GitArchive - 强制仅打包本地最新的 Git 已提交 HEAD 节点
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev -SyncMethod GitArchive

# 策略 4: GitPull - 远程 Linux 主机直接从 GitHub 执行 git fetch & reset
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Dev -SyncMethod GitPull
```

#### 3. 静态资源秒级热更（Public HotSync - 2 秒极速）
如果仅修改了前端静态资产（如 `apps/web/public/` 下的 SVG 图标、公共脚本、品牌资源），**无需重新构建 Docker 镜像，无需重启容器**：
```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -PublicOnly
```
> **效果**：约 2 秒完成双层热补丁（同时更新远程宿主机目录与容器内 `/app/apps/web/public`）。完成后在浏览器直接按 `Ctrl + F5` 刷新页面即可查看改动！

---

### 方案 B：官方正式生产部署管线

当功能在开发环境验证完毕，准备正式发版交付时：
1. **本地质量门禁校验**：
   ```powershell
   npm run lint
   npm run typecheck
   npm run gate
   ```
2. **提交代码并推送 Tag**：
   ```powershell
   git add .
   git commit -m "feat: your new feature"
   git tag v2026.XX.XX
   git push origin main --tags
   ```
3. **等待 GitHub Actions 构建完成**（生成并发布 `ghcr.io/xixjohan/mediary-scout:latest`）。
4. **触发远程生产环境拉取与重建**：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -Mode Official
   ```
   > 脚本将自动拉取官方最新 Release 镜像、平滑重建 `mediary` 容器、探测 `/api/health` 就绪，并比对 `BUILD_COMMIT` 提交指纹。

---

## 4. 远程主机诊断与辅助命令

脚本内置了通信适配器工具，可直接穿透执行诊断与探针操作：

```powershell
# 检查远程主机连通性与容器运行状态（不执行任何写操作）
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -CheckOnly

# 在远程主机上安全穿透执行任意 Shell 命令
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -RemoteExec "docker ps"
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -RemoteExec "docker logs --tail 30 mediary-dev"
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -RemoteExec "curl -s http://127.0.0.1:3020/api/health"
powershell -ExecutionPolicy Bypass -File scripts/deploy-remote.ps1 -RemoteExec "curl -I http://127.0.0.1:5280"
```

---

## 5. 内置浏览器自动化验收规范 (Playwright / Chrome DevTools MCP)

所有核心页面改动交付前，Agent 与开发者应优先通过内置浏览器进行端到端回归验收：

1. **连接入口与端口映射**：
   - 开发实例入口：`http://192.168.1.100:3020/`
   - 生产实例入口：`http://192.168.1.100:3000/`
   - PanSou 实例入口：`http://192.168.1.100:5280/`
2. **核心巡检页面与功能点**：
   - `/`：首页（验证搜索英雄区、精选推荐流、Suspense 骨架屏平稳水合，无循环刷新）。
   - `/?tab=library`：媒体库视图（验证影视列表渲染、海报卡片、分页切换）。
   - `/storage/strm`：STRM 任务中心（验证 STRM 定时任务、关联远程媒体库选择弹窗、手动同步按钮）。
   - `/settings`：系统设置（验证 TMDB Token、PanSou 地址 `http://192.168.1.100:5280`、115 网盘授权状态）。
3. **质量验收红线**：
   - 页面不得产生未捕获的控制台错误（`pageerror` 或 `Uncaught Exception`）。
   - 不得发生 Next.js SSR 水合崩溃（`Hydration failed because the server rendered HTML didn't match the client`）。
   - 任何网络请求不得长时间挂起（HTTP 超时限制保护）。

---

## 6. 容器运行时、跨平台防御与网络代理规范

### 1. 终端 Shell 脚本换行符防御（CRLF vs LF）
- **背景**：Windows 环境下检出代码或直推时，若脚本携带 `\r\n` (CRLF)，Linux 容器在执行脚本时会抛出 `\r: command not found` 语法错误。
- **三重防御机制**：
  1. **Git 属性约束**：根目录 [`.gitattributes`](file:///.gitattributes) 强制声明 `*.sh text eol=lf`。
  2. **同步自动清洗**：`scripts/deploy-remote.ps1` 在远端解包后主动执行 `find scripts -name '*.sh' -exec sed -i 's/\r$//' {} +`。
  3. **镜像构建自愈**：`Dockerfile.dev` 内部环境原生规范化处理。

### 2. 原生 C++ 模块与依赖隔离
- **禁止混入 Windows `node_modules`**：Windows 编译生成的 `better-sqlite3.node` 为 PE/COFF 二进制，无法在 Linux glibc 下运行。`deploy-remote.ps1` 打包时严格排除 `node_modules`，镜像构建利用分层缓存机制在 Linux 内部执行原生 `npm ci`。
- **数据卷完全隔离**：开发容器挂载独立卷 `mediary-dev-data:/app/data`，其 SQLite 数据库与生产容器 `mediaray-data` 完全物理隔离，开发测试随意增删改查绝不污染真实影视数据。

### 3. 局域网网络代理与 PanSou 协同
- **代理加速**：对于位于中国大陆的宿主机，在 `env/.envdev` 中注入 `HTTP_PROXY=http://127.0.0.1:7890` 与 `HTTPS_PROXY`，加速 TMDB 元数据与 AI 模型通信。
- **直连免代理 (NO_PROXY)**：严格设置 `NO_PROXY=localhost,127.0.0.1,115.com,.115.com,quark.cn`，确保 115 视频直链播放与国内网盘下载流量直连，避免代理带宽跑满或防盗链握手失效。

---

## 7. 凭据安全红线与脱敏规范 (Security & Credential Governance)

在后续所有任务、功能开发、排障文档编写以及测试用例编写中，必须严格遵守以下凭据安全红线：

### 1. 文档规范 (`docs/` 目录严禁真实凭据)
- **严禁真实密钥与密码**：编写技术方案、排障复盘（Lessons Learned）、API 调研或 curl 示例时，绝对禁止将真实的 OpenAI Key、平台管理员密码（如 `WEB_ADMIN_PASSWORD`）、隧道 ID、EasyTier 组网密钥 (`network_secret`) 或公网对端域名写入文档。
- **强制使用标准占位符**：
  - **Tunnel ID**：统一使用符合格式校验的虚拟占位符 `tunnel_0123456789abcdef0123456789abcdef`。
  - **API Key / Token**：使用 `sk-proj-test-secret-key-1234567890`、`sk-test-super-secret-12345` 或 `lwt_live_8f3a9e...`。
  - **管理员/系统密码**：使用 `your_secure_password_here` 或 `<ADMIN_PASSWORD>`。
  - **EasyTier 组网配置**：使用 `network_name = "demo_net", network_secret = "demo_secret_token", peers = ["wss://easytier-peer.example.com"]`。
  - **网络地址**：使用 RFC 5737 示例域名 `example.com` 或 `127.0.0.1`。

### 2. 测试用例规范 (`tests/` 与 `plugins/**/tests`)
- **单元与集成测试夹具**：默认使用纯内存/本地 Mock 凭据（如 `mockPrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK_KEY_DATA\n-----END OPENSSH PRIVATE KEY-----"`）。
- **动态密码防泄露**：端到端集成测试若需生成真实密码，必须动态随机生成（如 `[guid]::NewGuid().ToString('N')`），并在测试日志持久化时显式执行脱敏过滤（如 `.Replace($password, '[REDACTED]')`）。

### 3. 真实密钥与环境连接加载规范 (`/env/.envdev`)
- **唯一合法来源**：若本地联调、端到端冒烟测试或远程诊断确需使用真实密钥与宿主连接信息，必须且只能从项目根目录的 `/env/.envdev` 文件（或读取系统当前环境变量）中动态提取。
- **Git 隔离防护**：`/env/.envdev` 已被根目录 `.gitignore` 全局严格忽略（`env/`, `.envdev`, `*.envdev`），绝对禁止将其提交到版本库中。
- **环境回退机制**：测试脚本在未检测到 `/env/.envdev` 中的特定凭据时，应设计优雅降级或跳过远程鉴权逻辑，绝不允许通过在代码中硬编码真实密钥来“临时跑通”测试。
