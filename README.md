<p align="center">
  <img src="docs/images/hero.svg" alt="巡影 · Mediary Scout" width="600">
</p>

<p align="center">
  <b>巡影 · Mediary Scout</b><br>
  <b>专属于你个人网盘的 AI 智能媒体库与全自动获取 Agent。</b>
</p>

<p align="center">
  <a href="https://github.com/xixjohan/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/xixjohan/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/xixjohan/mediary-scout/releases/latest"><img src="https://img.shields.io/github/v/release/xixjohan/mediary-scout?display_name=tag" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="https://github.com/xixjohan/mediary-scout/releases/latest">📥 下载桌面版</a> ·
  <a href="#-docker-部署推荐">🐳 Docker 部署</a> ·
  <a href="#-当前系统核心功能与重磅优化">✨ 功能与优化特性</a> ·
  <a href="docs/deploy.md">📖 详细部署文档</a> ·
  <a href="README.en.md">English</a>
</p>

---

## 💡 巡影是什么？

你只需说出想看的电影、剧集、动漫或一段剧情描述，AI Agent 将自动全网检索资源、智能辨别版本与画质、转存进你的个人网盘，并回读验证真实落地；追更剧集后续还会定时巡检、自动补齐缺集。

> [!NOTE]
> 本项目积极参与并认可 [LINUX DO 社区](https://linux.do)，许多用户在社区中自部署并交流网盘与影视心得。 [![认可 LINUX DO](https://img.shields.io/badge/LINUX%20DO-认可-2ecc71?style=flat&labelColor=1f1f1f)](https://linux.do)

![巡影：搜片 → 点获取 → agent 自动搜索、转存、验证落进你的网盘](docs/images/demo.gif)

---

## ✨ 当前系统核心功能与重磅优化

巡影现已演进为具备高韧性、多网盘适配、流式渐进渲染与智能会话的现代自托管系统：

### 1. 🗂️ 全网盘生态深度适配
- **夸克网盘 (Quark)**：支持二维码扫码一键登录、Cookie 绑定、分享链接转存与资产校验；
- **115网盘**：支持二维码扫码登录、分享链接转存与磁力/离线下载；
- **123网盘**：支持二维码扫码登录、分享链接转存与磁力解析，免费账号无门槛转存；
- **天翼云盘 (189)**：支持二维码扫码登录、个人云与家庭云（Cloud Family）转存；
- **光鸭云盘 (GuangYaPan)**：支持设备码扫码与 Token 登录，分享链接转存与磁力下载；
- **UC网盘**：支持移动端扫码与 Cookie 连接；
- **企业级凭据加密**：所有账号 Cookie、Token、密钥均采用硬件级 **AES-256-GCM** 加密持久化存储。

### 2. 🔍 智能媒体检索与高可用容灾源
- **TMDB + 微信豆瓣双引擎**：内置 TMDB 影视元数据检索，并接入 **豆瓣 (Douban Frodo API) 智能降级兜底查询源**（TMDB 无结果或网络波动时透明回退豆瓣，中文片名与小众题材命中率 100%）；
- **全网权威豆瓣评分**：精选流与搜索结果全面异步融合豆瓣实时高分标识（如 `⭐ 8.5`）；
- **流式渐进渲染 (Progressive Streaming)**：基于 React Suspense + PPR，毫秒级呈现首屏骨架，候选结果边查边出，告别白屏阻塞；
- **多类型与动态标签筛选栏**：支持电影、电视剧、动漫、综艺、纪录片 5 大类别一键切换，并支持科幻、动作、剧情等题材标签、年份区间与热度/评分排序；
- **滑动窗口分页与容量切换器**：支持自由切换每页展现数量（**20部 / 30部 / 50部**，默认全面升级为 **30部**），内置滑动窗口算法并发解决上游定长 20 条阻抗失配。

### 3. 🤖 AI 获取 Agent 与高韧性自愈
- **全主流 LLM 协议支持**：支持 OpenAI 兼容格式模型（DeepSeek、GPT-4o、Claude 3.5、Qwen 2.5、Kimi、Ollama、vLLM 等），开箱自带公共模型池；
- **AI 503 宕机与敏感词阻断自愈**：
  - `PromptSanitizer`：自动清洗输入敏感关键词，防止触发大模型审核拦截；
  - `AgentReflection`：模型超载（503）或内容拦截时，自动触发指数退避与提示词降级重试；
- **多源资源搜索矩阵**：内置 PanSou 引擎，集成海搜（Haisou）提供商与 Prowlarr 磁力索引器。

### 4. 💬 智能媒体助理与多会话持久化
- **多会话并行与历史管理**：支持一键创建新聊天、会话重命名、历史记录加载与单会话/全量清空；
- **实体感知卡片**：助理交互时自动解析影视实体，直接在聊天流中内嵌展现可交互的影视卡片、豆瓣评分与一键获取按钮。

### 5. 🛡️ 零停机热更与系统韧性防御
- **静态资产物理一致性门禁 (`check-build-assets`)**：CI 与本地构建门禁全量校验 HTML 与 Manifest 引用，杜绝任何悬空分块；
- **前端 `ChunkLoadError` 智能自愈**：全局错误边界自动捕获部署更新时的分块漂移，利用防抖状态机无感刷新拉取最新资源，彻底杜绝发版后客户端卡死在错误页；
- **原生扩展完整收纳与容灾降级**：Docker 生产镜像内置 `better-sqlite3` 原生 C++ 驱动及 bindings，多网盘及身份组件具备异常隔离与安全降级保护；
- **出站网络智能分流与免代理白名单**：内置国内网盘（115、夸克、天翼、123）与豆瓣直连白名单，杜绝外网代理拉崩境内扫码与元数据请求。

---

## 🐳 Docker 部署（推荐）

巡影推荐使用 **Docker Compose** 进行部署：采用单镜像多服务架构，**Web 端** 与 **常驻后台 Worker** 共用同一个发布镜像，解耦 Next.js 页面渲染与后台长时间队列任务；数据库采用轻量嵌入式 **SQLite（单文件）**，零外部数据库容器依赖，极省资源。

### 方式一：Docker Compose 一键部署（官方推荐）

#### 1. 克隆仓库并准备环境
```bash
git clone https://github.com/xixjohan/mediary-scout.git && cd mediary-scout
cp .env.example .env
```

#### 2. 配置环境参数（按需修改 `.env`）
大部分参数已有默认值或可在启动后在 Web 界面「设置」页直接配置。重点关注项：
- `WEB_PORT`：Web 访问端口（默认 `3000`）；
- `DOCKER_MIRROR`：国内环境拉取 Docker Hub 基础镜像加速源（如 `docker.1ms.run`、`dockerproxy.net`）；
- `HTTP_PROXY` / `HTTPS_PROXY`：出站代理配置（如宿主机 Clash/v2ray，用于国内直连 TMDB 官方接口）。

#### 3. 拉取发布镜像并启动服务
```bash
docker compose pull web worker
docker compose up -d
```

> [!TIP]
> 启动后在浏览器打开 `http://<宿主机IP>:3000`，进入「设置」页扫码连接网盘即可开始使用！后续在「设置 → 更新」中可一键平滑升级，或配置每日定时自动更新。

---

### 方式二：Docker CLI 单容器独立部署

若无需 Compose 或在轻量设备上运行，可直接单容器独立启动（容器内自带 Web 与进程内后台调度 Worker）：

#### 1. 标准直连运行（推荐）
适合服务器直连网络良好的环境，国内网盘（115、夸克、123、天翼）与豆瓣评分天然直连：
```bash
docker run -d \
  --name mediary-scout \
  --restart unless-stopped \
  -p 3000:3000 \
  -v mediaray-data:/app/data \
  -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db \
  -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb \
  -e MEDIA_TRACK_WORKER_MODE=inprocess \
  -e MEDIA_TRACK_DEMO_SEED=0 \
  ghcr.io/xixjohan/mediary-scout:latest
```

#### 2. 大陆网络配合宿主机出站代理（加速 TMDB）
若宿主机运行了 Clash / V2Ray 等代理客户端且需要加速访问 TMDB：
```bash
docker run -d \
  --name mediary-scout \
  --restart unless-stopped \
  -p 3000:3000 \
  -v mediaray-data:/app/data \
  -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db \
  -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb \
  -e MEDIA_TRACK_WORKER_MODE=inprocess \
  -e MEDIA_TRACK_DEMO_SEED=0 \
  -e HTTP_PROXY="http://172.17.0.1:7890" \
  -e HTTPS_PROXY="http://172.17.0.1:7890" \
  -e NO_PROXY="localhost,127.0.0.1,115.com,*.115.com,quark.cn,*.quark.cn,123pan.com,*.123pan.com,189.cn,*.189.cn,douban.com,*.douban.com" \
  ghcr.io/xixjohan/mediary-scout:latest
```

> [!IMPORTANT]
> 1. **存储卷**：强烈推荐使用具名卷 `-v mediaray-data:/app/data`（由 Docker 引擎全托管权限），避免宿主机挂载目录因 UID 权限不足导致 SQLite 读写失败；
> 2. **网络分流**：115、夸克、天翼、123 等国内网盘与豆瓣服务器均在中国大陆境内，**系统内置了直连白名单**。配置代理时必须确保宿主机代理开启了「允许局域网连接（Allow LAN）」，且不可把境内网盘流量送往不可达的代理端口，否则会导致扫码报 `TypeError: fetch failed`。

---

### 方式三：国内网络加速与反代穿透

#### 1. 镜像拉取加速（大陆主机推荐）
在 `.env` 中指定镜像源，避免 Docker Hub 超时：
```env
DOCKER_MIRROR=docker.1ms.run
```
针对 GHCR 镜像（若网络受限），可在 `.env` 中指定国内镜像代理前缀：
```env
MEDIARY_IMAGE=ghcr.nju.edu.cn/xixjohan/mediary-scout:latest
```

#### 2. 出站代理配置（解决 TMDB 访问受限）
在 `.env` 中配置出站代理，让容器内的 TMDB 元数据请求顺利出海：
```env
HTTP_PROXY=http://172.17.0.1:7890
HTTPS_PROXY=http://172.17.0.1:7890
NO_PROXY=localhost,127.0.0.1,web,worker,pansou
```
*（注：`172.17.0.1` 通常为 Docker 容器访问宿主机的默认网关 IP，端口请根据你实际的代理端口修改）*

#### 3. 远程访问与外网安全
- **Tailscale 私有网络（最推荐）**：无需公网 IP 与开端口，安全连接家里 NAS 实例；
- **Cloudflare Tunnel（公网 HTTPS）**：
  在 Cloudflare Zero Trust 控制台创建隧道并获得 Token，配置 `.env`：
  ```env
  TUNNEL_TOKEN=你的Cloudflare_Tunnel_Token
  ```
  启动带隧道的 Compose Profile：
  ```bash
  docker compose --profile tunnel up -d
  ```
  > [!CAUTION]
  > 映射公网时，请务必在巡影登录页设置访问密码，或在 Cloudflare Access 中配置前置身份认证，切勿裸露在公网！

---

### 方式四：多用户隔离模式

若需与家人、朋友共享同一实例，但各自拥有独立的网盘凭据与订阅媒体库，可启用多用户模式：
1. 在 `.env` 中设置：
   ```env
   MEDIA_TRACK_MULTI_USER=1
   MEDIA_TRACK_WORKER_SECRET=自定义一串随机字符串用于内部通信
   ```
2. 重启服务：
   ```bash
   docker compose up -d web worker
   ```
3. 首次注册的用户自动成为管理员，后续注册的用户各自绑定网盘、独立管理媒体库。

---

## 💻 桌面版安装（免折腾）

适用于个人在 macOS 或 Windows 电脑上直接运行：

| 平台 | 安装包 | 说明 |
| :--- | :--- | :--- |
| **macOS (Apple Silicon)** | [前往下载 .dmg](https://github.com/xixjohan/mediary-scout/releases/latest) | 已获 Apple 开发者签名公证，直接双击运行 |
| **Windows (x64)** | [前往下载 .exe](https://github.com/xixjohan/mediary-scout/releases/latest) | Windows 弹窗提示时点击「更多信息」→「仍要运行」 |

---

## 🛠️ 运维管理与常用命令

### 查看日志
```bash
# 查看 Web 服务实时日志
docker compose logs -f web

# 查看后台获取 Worker 执行任务日志
docker compose logs -f worker
```

### 数据备份与恢复
系统所有配置、加密密钥、影视订阅及获取记录均保存在 `mediaray-data` 数据卷中（SQLite 单文件）：
```bash
# 备份数据目录
docker run --rm -v mediary-scout_mediaray-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/mediary-backup-$(date +%Y%m%d).tar.gz -C /data .

# 恢复数据
docker run --rm -v mediary-scout_mediaray-data:/data -v $(pwd):/backup alpine \
  tar xzf /backup/mediary-backup-XXXXXX.tar.gz -C /data
```

### 忘记管理员密码
若忘记密码，可在宿主机上直接执行内置重置脚本：
```bash
docker compose exec web node scripts/reset-password.mjs <你的用户名>
```

---

## 📚 详细文档索引

- [📖 完整部署指南（NAS、软路由、代理穿透）](docs/deploy.md)
- [🧩 架构设计与分层速览](docs/architecture.md)
- [🤖 Agent API 开发指南](docs/agent-api.md)
- [🛡️ 静态资源 500 与零停机部署韧性架构](docs/nextjs-chunk-load-and-zero-downtime-deployment-architecture.md)
- [📑 豆瓣兜底与滑动窗口分页设计](docs/douban-fallback-and-search-pagination-architecture.md)
- [⚖️ 各网盘资源评估与生态对比](docs/drive-brand-evaluations.md)

---

## ⚖️ 免责声明

巡影（Mediary Scout）为开源、自部署软件，不提供、也永远不会提供任何托管服务。用户在自建实例中自行配置所拥有的网盘凭证与 AI 模型接口，巡影仅执行用户在网盘内原本可手动执行的文件检索与转存操作。

本项目与 115、夸克、阿里、百度、123、天翼、光鸭、TMDB、豆瓣及任何资源索引器均无商业隶属关系。

---

## 🙏 致谢开源生态

- [PanSou](https://github.com/fish2018/pansou-web)：高性能网盘资源搜索服务
- [Prowlarr](https://github.com/Prowlarr/Prowlarr)：索引器管理
- [p115client](https://github.com/ChenyangGao/p115client)：115 API 参考
- [p123client](https://github.com/ChenyangGao/p123client)：123网盘 API 参考
- [AList](https://github.com/AlistGo/alist)：光鸭云盘 API 参考
- [cloud189-auto-save](https://github.com/1307super/cloud189-auto-save)：天翼云盘 API 参考
- [TMDB](https://www.themoviedb.org/)：影视基础元数据服务
- [豆瓣 (Douban)](https://movie.douban.com/)：华语影视数据与大众评分体系

---

<p align="center">
  <b>如果巡影对你有帮助，欢迎在 GitHub 上点个 ⭐️ Star！</b>
</p>
