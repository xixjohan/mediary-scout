# 单 Docker 独立部署诊断与故障自愈方案

## 1. 错误背景与 Next.js 生产脱敏机制

当在单 Docker 容器模式下启动 Mediary Scout 并访问前端时，浏览器控制台可能会输出如下红色错误：

```text
2g05-lers809t.js:1 Error: An error occurred in the Server Components render.
The specific message is omitted in production builds to avoid leaking sensitive details.
A digest property is included on this error instance which may provide additional details about the nature of the error.
```

### 为什么浏览器看不到真实错误详情？
这是 **Next.js 生产环境构建（`NODE_ENV=production`）的标准安全机制（Error Masking）**：
- React Server Component（服务端组件）运行在 Docker 容器内部的 Node.js 进程中；
- 若渲染期间抛出未处理异常（例如 SQLite 权限被拒、环境变量缺失、网络超时等），为防止敏感信息（如数据库路径、内部 API 密钥、数据库连接串、服务器文件结构等）泄漏给公网客户端，Next.js 会强制脱敏，将原始错误信息替换为通用的脱敏文本，并生成一个 `digest` 哈希；
- **真实完整的错误堆栈仅记录在 Docker 容器的标准输出（stdout / stderr）中**。

---

## 2. 核心排查命令：如何 1 秒定位真实错误

在部署主机上执行以下命令，直接查看容器输出中的真实堆栈：

```bash
# 查看容器最近 100 行日志，搜寻与 digest 匹配的真实错误栈
docker logs <容器名或容器ID> --tail 100

# 或实时跟踪日志输出
docker logs -f <容器名或容器ID>
```

控制台会输出完整的原始错误堆栈，例如：
- **缺少原生依赖模块**：`SQLite mode is enabled but the optional native dependency 'better-sqlite3' could not be loaded. Original error: Cannot find module 'better-sqlite3'`
- **权限问题**：`Error: EACCES: permission denied, open '/app/data/credential.key'` 或 `SqliteError: unable to open database file`
- **网络连接超时**：`TypeError: fetch failed (cause: ConnectTimeoutError: Connect Timeout Error)`
- **配置冲突**：`MEDIA_TRACK_AGENT_ADAPTER_REQUIRED_FOR_LIVE_WORKFLOW`

---

## 3. 单 Docker (`docker run`) 相比于 Docker Compose 的高发诱因

Docker Compose 预置了完整的具名卷与环境变量编排，而使用裸 `docker run` 或特定镜像构建时容易遗漏关键配置：

| 诱因类别 | 典型表现 | 根本原因 | 解决方案 |
| :--- | :--- | :--- | :--- |
| **原生模块缺失 (better-sqlite3)** | `Cannot find module 'better-sqlite3'` | Next.js standalone tracing 采用静态分析，代码中为防止客户端 chunk 破坏使用动态 require 原生模块，导致构建产物漏掉了 `better-sqlite3` 及其 bindings | 在 `Dockerfile` runner 阶段显式复制 `/app/node_modules/better-sqlite3`、`bindings` 及 `file-uri-to-path`（已修复） |
| **数据目录与权限** | `unable to open database file` / `EACCES` | 挂载宿主机路径时宿主目录无写权限，或未挂载卷导致无法读写 `/app/data` | 使用 Docker 具名卷 `-v mediaray-data:/app/data`（最推荐），或执行 `chmod -R 777 ./data` |
| **网络代理缺失** | `fetch failed` / 渲染超过超时时间打崩 | 大陆服务器未配置出站代理，服务端请求 TMDB 元数据超时 | 传入代理变量 `-e HTTP_PROXY=... -e HTTPS_PROXY=...` |
| **基础环境变量缺失** | 队列不消费、组件配置降级 | 未注入 `MEDIA_TRACK_SQLITE_PATH` 或 worker 模式未指定 | 注入必要环境变量，并将 `MEDIA_TRACK_WORKER_MODE=inprocess` |

---

## 4. 推荐的单 Docker 生产级运行命令模板

### 方案 A：中国大陆服务器（带出站代理，推荐）

```bash
docker run -d \
  --name mediary \
  --restart unless-stopped \
  -p 3000:3000 \
  -v mediaray-data:/app/data \
  -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db \
  -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb \
  -e MEDIA_TRACK_WORKER_MODE=inprocess \
  -e MEDIA_TRACK_DEMO_SEED=0 \
  -e HTTP_PROXY="http://<宿主机局域网IP>:7890" \
  -e HTTPS_PROXY="http://<宿主机局域网IP>:7890" \
  ghcr.io/xixjohan/mediary-scout:latest
```

> [!TIP]
> 容器访问宿主机代理时，`<宿主机局域网IP>` 通常为 `172.17.0.1`（Docker 默认网桥网关）或宿主机内网 IP（如 `10.x.x.x` / `192.168.x.x`），请确保代理客户端开启了「允许局域网连接（Allow LAN）」。

### 方案 B：海外或无墙环境（直接出站）

```bash
docker run -d \
  --name mediary \
  --restart unless-stopped \
  -p 3000:3000 \
  -v mediaray-data:/app/data \
  -e MEDIA_TRACK_SQLITE_PATH=/app/data/mediary.db \
  -e MEDIA_TRACK_SEARCH_PROVIDER=tmdb \
  -e MEDIA_TRACK_WORKER_MODE=inprocess \
  -e MEDIA_TRACK_DEMO_SEED=0 \
  ghcr.io/xixjohan/mediary-scout:latest
```

---

## 5. 代码层防御与容灾加固

我们在代码层面实施了三道防御屏障：
1. **首页核心挂载点安全降级**（`apps/web/app/page.tsx`）：
   `getRegisteredDriveCount()` 追加 `.catch(() => 0)`，在数据库冷启动或轻微抖动时安全降级为 0，防止主骨架直接被异常击穿。
2. **侧边栏加载器防崩溃兜底**（`apps/web/components/workspace-switcher-loader.tsx`、`account-identity-loader.tsx`）：
   增加了异常捕获，确保非核心的多网盘与身份指示器出现偶发异常时，页面仍能完整呈现。
3. **友好错误引导界面**（`apps/web/app/error.tsx`）：
   对页面崩溃界面的提示文案进行重构，明确展示 `docker logs` 排查指令并列出数据卷权限与网络代理两类最高频场景，让运维定位零迷茫。
