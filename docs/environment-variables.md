# 巡影 (Mediary Scout) 环境变量全景与治理指南

本文档全面梳理当前项目中支持的环境变量，分为三个核心部分：
1. **多用户管理模式与安全凭据**：启用多用户所需的环境变量、运行机制与必须协同配置的项。
2. **全量有效环境变量参考手册**：按模块分类的完整配置清单。
3. **已失效/已废弃/可清理的环境变量调研**：历史遗留、已退役或仅用于临时测试脚本的变量分析与清理建议。

---

## 一、多用户管理模式（Multi-User Mode）

### 1. 核心开启开关

| 环境变量 | 默认值 | 作用与机制说明 |
| :--- | :--- | :--- |
| **`MEDIA_TRACK_MULTI_USER`** | 未设 (等同于 `0`) | **多用户模式总开关**。<br>• **未开启 (单用户模式)**：内网/局域网访问完全免密直通，只有经隧道（Cloudflare/Tailscale）等外网远程访问时才会强制要求输入密码；全站共享内置默认账号 (`acct_default`)。<br>• **设为 `1` (多用户模式)**：全站所有路由强制启用 Session 门禁，开放登录与注册界面。 |

#### 多用户开启后的核心运行机制：
1. **首位用户认领与数据平滑迁移（Claim / Adopt）**：
   - 实例首次设为 `MEDIA_TRACK_MULTI_USER=1` 重启后，首位打开站点的用户会看到「认领屏」，注册设定的用户名和密码将成为**站主（Owner）**。
   - 若此前单用户已绑定网盘或有媒体库，系统会自动执行 `adoptDefaultAccount`，原样接管已有数据，零丢失。
2. **多账号独立与数据隔离**：
   - 后续家庭成员或朋友各自在 `/login` 注册独立账号。
   - 每个账号独立绑定各自的网盘（115、夸克、UC、123、光鸭等）、维护独立的追更订阅与待看清单，互不干扰。
   - 站主可在「设置 → 账号管理」(`/settings/accounts`) 中查看所有账号、重置他人密码或删除账号。

---

### 2. 多用户模式强依赖变量（⚠️ 必须配置）

| 环境变量 | 必须性 | 作用与配置要求 |
| :--- | :---: | :--- |
| **`MEDIA_TRACK_WORKER_SECRET`** | **多用户模式必填** | **Web 与独立 Worker 之间的通信认证密钥**。<br>• **底层逻辑**：当 `MEDIA_TRACK_MULTI_USER=1` 时，Web 侧的任务队列消费端点 (`/api/workflows/run-next` 与 `run-type3`) 会由 `workerApiGuard` 强制鉴权。<br>• **未配置后果**：若未设置此变量，Worker 向 Web 发起的所有 HTTP Poke 请求**一律返回 HTTP 401 Unauthorized**，导致后台队列完全卡死，无法转存、无法刮削、无法推进任务。<br>• **配置方法**：在 `.env` 中生成一个随机 Hex 串（如 `openssl rand -hex 32`），由于 `docker-compose.yml` 同时将此变量注入 `web` 和 `worker` 服务，二者保持同值即可恢复正常。 |

---

### 3. 多用户认证与会话安全关联变量

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`MEDIA_TRACK_COOKIE_SECURE`** | 留空（自动探测） | 会话 Cookie (`mt_session`) 的 `Secure` 属性标记。<br>• `留空`：根据请求协议及 `x-forwarded-proto` 自动判断（HTTPS 自动附加 `Secure`，纯 HTTP 局域网不附加）。<br>• `1`：强制开启（当存在反代 HTTPS 但未透传协议头导致登录 Cookie 丢失时使用）。<br>• `0`：强制关闭（纯内网 HTTP 部署）。 |
| **`MEDIA_TRACK_SESSION_SECRET`** | 留空（自动生成） | Web 会话签名密钥。留空时首次启动会自动在 SQLite 数据库中生成 32 字节随机密钥持久化存储。 |
| **`MEDIA_TRACK_JWT_SECRET`** | 留空（自动生成） | API JWT 鉴权签名密钥。留空时自动生成并落库保存。修改或轮换它可一次性吊销所有已签发的 API JWT。 |
| **`MEDIA_TRACK_JWT_TTL_SECONDS`** | `43200` (12小时) | 外部通过 API Key 换取的 Bearer JWT 的有效存活时间（秒）。 |
| **`MEDIA_TRACK_API_KEY`** | 留空 | 外部调用端换取 JWT 的长期 API Key（`POST /api/auth/token`）。设置页保存的值优先级高于此环境变量。 |
| **`MEDIA_TRACK_ALLOWED_ORIGINS`** | 留空 | Next.js Server Actions CSRF 域名放行白名单（多个域名用逗号分隔）。在反代/穿透访问域名与容器 `x-forwarded-host` 头不一致时配置。注意：在单镜像部署模式下，推荐优先在反向代理配置透传 `Host` / `X-Forwarded-Host`。 |

---

## 二、当前项目有效环境变量参考手册

### 1. 核心系统与存储持久化

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`MEDIA_TRACK_SQLITE_PATH`** | `/app/data/mediary.db` | SQLite 数据库文件绝对路径。Compose 部署默认挂载 `mediaray-data` 卷持久化存储。 |
| **`MEDIA_TRACK_CREDENTIAL_KEY`** | 留空（自动生成） | 网盘 Cookie、API Token 等敏感凭据的 AES-256-GCM 加密主密钥。留空时会在数据库同目录下自动生成 `credential.key`。⚠️ 备份数据时必须与数据库一起备份。 |
| **`MEDIA_TRACK_PUBLIC_BASE_URL`** | 留空 | 对外访问的基础 URL（如 `https://media.example.com`），用于消息推送中拼接影视详情直达卡片链接。 |
| **`MEDIA_TRACK_EXTENSIONS_DIR`** | 留空 | 插件与扩展能力加载目录。 |

---

### 2. Worker 队列与运行架构

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`MEDIA_TRACK_WORKER_MODE`** | `external` (Compose) | Worker 调度模式。`external` 表示由独立的 `worker` 容器负责定时触发（HTTP poke），彻底解耦 Next.js 主服务进程；桌面端/单进程默认为 `inprocess`。 |
| **`MEDIA_TRACK_INPROCESS_WORKER`** | 未设 | 逃生门开关。设为 `1` 时强制在 Next.js 服务进程内运行常驻 Worker（仅在独立 Worker 容器起不来时应急）。 |
| **`MEDIA_TRACK_WEB_BASE`** | `http://web:3000` | 独立 Worker 容器调用 Web 服务的内网基础地址。 |
| **`MEDIA_TRACK_WORKER_POLL_MS`** | `3000` | Worker 队列空闲时的轮询休眠时间（毫秒）。 |
| **`MEDIA_TRACK_WORKER_SWEEP_MS`** | `900000` (15分钟) | Worker 触发后台追更与孤儿任务巡检的最小轮询间隔（毫秒）。 |

---

### 3. 搜索源与适配器引擎

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`MEDIA_TRACK_SEARCH_PROVIDER`** | `tmdb` (Compose) | 影视元数据搜索源。`tmdb` 调用 TMDB 官方接口；`demo` 为固定测试种子。 |
| **`MEDIA_TRACK_WORKFLOW_ADAPTER`**| `pansou` (Compose) | 工作流资源检索适配器。生产模式必填 `pansou`；测试模式为 `fake`。 |
| **`MEDIA_TRACK_STORAGE_ADAPTER`** | `115` (Compose) | 存储执行器。实盘为 `115`；测试为 `fake`。 |
| **`MEDIA_TRACK_AGENT_ADAPTER`**   | `vercel-ai` (Compose)| 决策 Agent 适配器。当使用真实盘与检索器时必须配置为 `vercel-ai`。 |
| **`PANSOU_BASE_URL`** | `https://so.252035.xyz` | PanSou 盘搜公共检索服务基地址。Compose 部署时容器内默认指向内置 `http://pansou`。 |
| **`TMDB_READ_TOKEN`** | 留空 | TMDB v4 Read Token。留空走内置反向代理开箱即用，填入后使用自建额度。 |
| **`PROWLARR_BASE_URL`** | 留空 | Prowlarr 聚合搜索服务的完整 URL（如 `http://192.168.1.10:9696`）。 |
| **`PROWLARR_API_KEY`** | 留空 | Prowlarr 的 API Key。 |

---

### 4. 大语言模型（AI Agent）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`AGENT_MODEL_BASE_URL`** | 留空 | 任意 OpenAI 兼容服务端点（如 `https://api.deepseek.com/v1`、Ollama 本地地址等）。三项留空时自动回落使用内置免费模型池（Kilo Code）。 |
| **`AGENT_MODEL_ID`** | 留空 | 模型标识（如 `deepseek-chat`、`qwen-plus`）。 |
| **`AGENT_MODEL_API_KEY`** | 留空 | 大模型 API Key（本地 Ollama 等无 Key 服务可留空）。 |
| **`MEDIA_TRACK_AGENT_LOG`** | 留空 (关) | 设为 `1` 时将 Agent 的逐步执行轨迹（关键词检索、转存判定等）实时输出到标准输出容器日志中，便于排障。 |
| **`MEDIA_TRACK_AGENT_TOKEN`** | 留空 | 供外部 Coding Agent / 自动化客户端调用本项目 Agent API 的 Bearer Token。 |

---

### 5. 存储与目录结构定制

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`MEDIA_TRACK_LIBRARY_ROOT_DIR`**   | `Mediary Scout` | 自定义网盘内影音库根容器目录名。仅影响后续新绑定的网盘。 |
| **`MEDIA_TRACK_LIBRARY_MOVIES_DIR`** | `Movies` | 电影分类目录名称。 |
| **`MEDIA_TRACK_LIBRARY_TV_DIR`**     | `TV` | 剧集分类目录名称。 |
| **`MEDIA_TRACK_LIBRARY_ANIME_DIR`**  | `Anime` | 番剧分类目录名称。 |
| **`MEDIA_TRACK_115_MIN_DELAY_MS`**   | `1200` | 115 接口请求间最小间隔（毫秒），防止高频触发风控。 |
| **`MEDIA_TRACK_115_MAX_API_CALLS`**  | `300` | 单次转存任务允许调用的 115 接口最大次数阈值。 |
| **`MEDIA_TRACK_115_WRITE_SCOPE_CIDS`** | 留空 | 严格限制 115 仅允许写入的目录 CID 白名单列表（逗号分隔）。 |
| **`MEDIA_TRACK_115_PROTECTED_CIDS`**   | 留空 | 绝对受保护的目录 CID 列表，执行器禁止对这些目录执行删除操作。 |

---

### 6. 网络出站代理（科学上网）

项目内置基于 Node `undici` 的全局出站代理拦截器（[`http-proxy.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/features/settings-system/core/http-proxy.ts)）：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`HTTP_PROXY`** / **`http_proxy`** | 留空 | HTTP 出站代理地址（如 `http://172.17.0.1:7890`）。用于国内服务器访问 TMDB 官方接口或 GitHub Release。 |
| **`HTTPS_PROXY`** / **`https_proxy`** | 留空 | HTTPS 出站代理地址。 |
| **`NO_PROXY`** / **`no_proxy`** | 内置国内网盘及内网 IP | 免代理白名单。系统会自动将 `115.com`、`quark.cn`、`uc.cn`、`123pan.com`、`189.cn`、`douban.com` 以及常见私网网段合入白名单，防止国内网盘误走代理。 |

---

### 7. 远程访问与隧道

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`TUNNEL_TOKEN`** | 留空 | Cloudflare Tunnel 连接器 Token。仅在 `docker compose --profile tunnel up -d` 时生效。 |
| **`TUNNEL_TRANSPORT_PROTOCOL`** | `auto` | Cloudflare 隧道传输协议。若遇到网络封锁 UDP 导致频繁掉线，可在 `.env` 中指定为 `http2`。 |
| **`MEDIARY_CONNECT_HOSTNAME`** | 留空 | Mediary Connect 官方穿透服务分配给本实例的公网域名。 |
| **`SCOUT_CONNECT_URL`** | `https://mediaryconnect.app` | 穿透控制面 Worker 基地址。 |

---

### 8. 推送通知渠道（Push Channels）

可直接在环境变量中配置，留空时可在「设置 → 通知」页面配置并持久化入库：

| 环境变量 | 说明 |
| :--- | :--- |
| **`MEDIA_TRACK_PUSH_BARK_KEY`** | iOS Bark 设备 Key。 |
| **`MEDIA_TRACK_PUSH_SERVERCHAN_SENDKEY`** | Server酱 SendKey。 |
| **`MEDIA_TRACK_PUSH_WECOM_WEBHOOK`** | 企业微信群机器人 Webhook 地址。 |
| **`MEDIA_TRACK_PUSH_WEBHOOK_URL`** | 自定义通用 Webhook 回调地址。 |

---

### 9. 智能预筛选服务（Jev Prefilter）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`JEV_BASE_URL`** | `https://typesafe.ai/api/systemone` | Jev 资源智能决策过滤服务基地址。 |
| **`JEV_API_KEY`**  | 留空 | Jev 服务 API 授权密钥。 |

---

### 10. 部署镜像与更新管理

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **`DOCKER_MIRROR`** | 留空 | Docker Hub 国内镜像加速域名（如 `docker.1ms.run`、`hub.rat.dev`）。 |
| **`MEDIARY_IMAGE`** | `ghcr.io/...:latest` | Web 与 Worker 共用的发布镜像标签。 |
| **`PANSOU_IMAGE`**  | `ghcr.io/fish2018/pansou-web:latest` | PanSou 镜像地址。国内拉不动时可指定为国内代理源。 |
| **`MEDIA_TRACK_UPDATE_REPO`** | `xixjohan/mediary-scout` | 在线一键更新检查的目标 GitHub 仓库。 |
| **`WEB_PORT`** | `3000` | 宿主机对外映射的 Web 端口。 |

---

## 三、已失效 / 已废弃 / 建议清理的环境变量清单

经对全仓库源码与历史提交的严格审计，以下环境变量在当前项目中**已经完全失效、退役，或已被更优方案替代**。若你的 `.env` 中包含这些变量，建议进行清理：

### 1. 彻底失效 / 代码已退役（Dead Code）

| 环境变量 | 原用途 | 失效原因与现状 | 处理建议 |
| :--- | :--- | :--- | :--- |
| **`MEDIA_TRACK_PATROL_IGNORE_TIME_GATE`** | 早期桌面版跳过每日巡检时间窗口 | **已退役**。源码明确注释：该变量为早期桌面端零点巡检 bug 的源头，现调度闸逻辑已全部统一收归 `runScheduledType3` 内核，生产代码中完全不再读取此变量。 | **立即从 `.env` 中删除** |
| **`MEDIA_TRACK_POSTGRES_URL`** | 早期 PostgreSQL 数据库连接串 | **已彻底废弃**。在 S1.4b 版本中，项目已彻底移除 PostgreSQL 依赖，全面收敛为纯 SQLite 单文件引擎（`/app/data/mediary.db`）。 | **立即从 `.env` 中删除** |
| **`MEDIA_TRACK_BASE_URL`** | 旧独立调度脚本的 Web 目标基址 | 仅存在于已过时的手工脚本 `scripts/scheduler.mjs` 中。生产部署已全面使用 `apps/host-worker`，对应标准变量为 `MEDIA_TRACK_WEB_BASE`。 | **清理，无需配置** |
| **`MEDIA_TRACK_RUN_NEXT_INTERVAL_MS`**<br>**`MEDIA_TRACK_TYPE3_PING_INTERVAL_MS`**<br>**`MEDIA_TRACK_SCHEDULER_ONCE`** | 旧独立脚本 `scripts/scheduler.mjs` 的轮询参数 | 同样仅存在于旧版调试脚本。现由 Worker 容器的 `MEDIA_TRACK_WORKER_POLL_MS` 与 `MEDIA_TRACK_WORKER_SWEEP_MS` 替代。 | **清理，无需配置** |

---

### 2. 已被新方案替代（不推荐在 `.env` 中配置）

| 环境变量 | 原用途 | 替代方案与现状 | 处理建议 |
| :--- | :--- | :--- | :--- |
| **`CLAWD_MEDIA_ROOT_CID`**<br>**`MOVIES_CID`**<br>**`TV_SHOWS_CID`**<br>**`ANIME_CID`** | 早期 Clawd 阶段手动在 115 创建的目录 CID | **历史遗留 fallback**。现代架构中，所有网盘（115/夸克/UC等）均在前端「设置 → 网盘」扫码或 Token 绑定，程序会自动在网盘根目录建树并将生成的 CID 加密落库。`.env.example` 已明确标明 `leave these empty`。 | **从 `.env` 中留空或删除** |
| **`MEDIA_TRACK_DEFAULT_TV_STORAGE_DIRECTORY_ID`** | 强制指定剧集落盘的目标目录 CID | 留空才会让工作流自动创建标准的 `剧名 (年份)/Season N` 规范结构。手动设置反而会破坏多季分层归类。 | **从 `.env` 中留空或删除** |
| **`MEDIA_TRACK_TV_PARENT_CID`**<br>**`MEDIA_TRACK_MOVIES_PARENT_CID`**<br>**`MEDIA_TRACK_ANIME_PARENT_CID`**<br>**`MEDIA_TRACK_115_TEST_ROOT_CID`** | 指定各分类的父目录 CID | 仅作为早期单网盘在数据库无记录时的 fallback。现代多网盘与多用户模式下完全按绑定的 `connected_storages` 库表字段寻址。 | **新部署保持留空或删除** |
| **`XIAOMI_MIMO_BASE_URL`**<br>**`XIAOMI_MIMO_MODEL_ID`**<br>**`XIAOMI_MIMO_API_KEY`** | 早期硬编码小米 MiMo 模型的配置项 | **已弃用**。现已全面重构为通用的 `AGENT_MODEL_*`（支持任意 OpenAI 兼容服务），代码中仅保留向后兼容读取。 | **迁移为 `AGENT_MODEL_*` 或在「设置」页配置** |
| **`PAN115_COOKIE`** | 在环境变量写死 115 网盘 Cookie | 多用户模式下各用户各自绑定网盘，全局 Cookie 已失效；单用户模式也推荐直接在网页端扫码绑定，Cookie 会自动加密保存在数据库并支持健康状态检查。 | **多用户模式下无需配置** |

---

### 3. 仅限开发测试 / 单次探针使用的变量（严禁作为生产配置）

以下变量仅存在于开发调试工具或探针测试脚本中，不属于生产环境配置：
- **`OPENROUTER_API_KEY`** / **`JEV_FAKE`**：仅在 `tests/live-probes/providers/jev-prefilter-replay.mts` 脚本中用于回放重测，生产逻辑不存在。
- **`AB_SQL`**：仅在 `tests/live-probes/providers/jev-ab-run.mts` 脚本中通过 SSH/Docker Exec 传递 SQL 探针。
- **`E2E_BASE_URL`** / **`E2E_SQLITE_PATH`**：Playwright 端到端集成测试专用。
- **`UPSTREAM_REPO_URL`**：开发工具 `tools/upstream/audit-upstream.mjs` 代码同步审计专用。

---

## 四、运行时配置治理与 UI 设置页迁移演进

随着系统功能的演进与多网盘多用户架构的成熟，我们正在推进将业务运行时配置全面从 `.env` 移入 Web 设置页面，并精简废弃环境变量。

详细调研、头脑风暴方案、设计模式应用与落地路线图已完整收录于：
👉 [运行时配置下放与系统架构治理方案](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/architecture/runtime-configuration-ui-migration-and-multi-user-governance.md)

### 核心演进方向速览：
1. **配置下放设置页**：网盘媒体库根目录/分类子目录命名偏好、网盘安全频控与防风控调用阈值、出站代理（HTTP_PROXY 热生效）、推送通知渠道等，全面由设置页面可视化管理并落库 SQLite。
2. **彻底移除 `MEDIA_TRACK_MULTI_USER`**：系统全面默认原生多用户体系，首个注册者即站主（Owner），老单用户数据自动无损继承；消除近百处双轨分支逻辑。
3. **消除 `MEDIA_TRACK_WORKER_SECRET` 手动配置**：Web 与 Worker 容器通过共享卷自动签发并读取通信 Secret，消除 401 队列卡死隐患。
4. **适配器生产默认化**：生产环境下四大适配器默认启用真实实现（TMDB、PanSou、网盘驱动注册表、Vercel AI），仅在测试时激活 Fake。

