# 容器内自更新、资源直链查看与网盘离线下载系统架构设计

本文档深入对标开源项目 **Sub2Api**（单容器内原地自更新）与 **LitePan**（多网盘离线下载与种子解析），结合巡影（Mediary Scout）现有技术栈与架构基础设施，针对三大核心课题进行系统性可行性分析、设计模式建模与工程落地规范制定。

---

## 一、 课题一：借鉴 Sub2Api 实现单容器 / 无 Docker Socket 内更新

### 1.1 Sub2Api 单容器更新机制剖析

在 `E:\WorkProject\Go\【第三方项目】\Sub2Api\sub2api-main` 中，Sub2Api 采用 Go 语言单一静态二进制文件交付，其自更新逻辑（`backend/internal/service/update_service.go`）核心步骤如下：

```
GitHub Releases ──> 下载 sub2api_linux_amd64.tar.gz + checksums.txt
                              │
                              ▼
           校验 SHA256 签名，解压得到新二进制
                              │
                              ▼
  【POSIX 原子 Inode 替换】
  os.Rename("/app/sub2api", "/app/sub2api.backup")  (旧进程持有旧 inode 继续服务)
  os.Rename(newBinaryPath, "/app/sub2api")          (新二进制原子落盘)
                              │
                              ▼
  返回 need_restart: true ──> 进程退出 (exit 0) ──> Docker daemon (restart: unless-stopped) 重启生效
```

- **核心精髓**：
  1. **免宿主 Docker Socket 依赖**：不挂载 `/var/run/docker.sock`，不依赖宿主机是否有 Docker CLI，容器内部自给自足。
  2. **原子文件替换 (Atomic Swap)**：在同一文件系统挂载点内进行 `rename`，即便主进程正在运行，Linux 系统的 inode 机制也允许重命名正在执行的文件；
  3. **双向防灾与回滚机制**：保留 `.backup` 文件，若新版本启动失败或用户手动回滚，执行逆向 `rename` 即可秒级复原；
  4. **操作锁与超时解耦**：使用 `SystemOperationLockService` 确保更新互斥，使用 `context.WithoutCancel` 确保 HTTP 客户端断开连接后更新仍能安全落盘。

### 1.2 巡影（Mediary Scout）现状与痛点

- **现状**：巡影目前采用 `apps/updater` 独立容器方案（`apps/updater/run-update.sh`），必须挂载宿主机的 `/var/run/docker.sock`，由 updater 容器调用 Docker Engine API 拉取新镜像并重新编排 `docker compose up -d web worker`。
- **痛点**：
  1. **NAS / 轻量云原生环境受限**：大量用户在群晖 (Synology Container Manager)、威联通 (QNAP)、极空间、绿联、飞牛 (fnOS) 或 PaaS 平台（Fly.io、Zeabur、Sealos、K8s）上部署，**受限于平台权限策略，无法挂载 Docker Socket**；
  2. **单容器整合部署诉求**：用户希望 `docker run -d -p 3001:3001 xixjohan/mediary-scout` 单容器极速启动，双容器 + Socket 挂载大幅拉高了门槛；
  3. **Node.js 运行时特性的差异**：巡影基于 Node.js/Next.js，而非单个静态 Go 二进制文件。应用由 `server.js`、`.next` 构建产物、`node_modules` 和静态资产构成，无法简单通过重命名一个 binary 完成。

### 1.3 巡影的适配方案与设计模式

我们为巡影设计基于**策略模式 (Strategy Pattern)** 的版本更新引擎 `UpdateStrategy`：

```
                      ┌────────────────────────────┐
                      │    UpdateManagerFacade     │
                      └─────────────┬──────────────┘
                                    │
          ┌─────────────────────────┴────────────────────────┐
          ▼                                                  ▼
┌───────────────────────────────┐          ┌──────────────────────────────────┐
│   DockerSocketStrategy        │          │   InContainerArtifactStrategy    │
│   (现有环境：检测到套接字)     │          │   (轻量/单容器：无 Docker 套接字) │
│   - 调用 updater 容器         │          │   - 拉取 Standalone 发布包       │
│   - 滚动替换容器镜像          │          │   - 解压至 /app/release_next     │
│                               │          │   - 原子软链/目录替换            │
│                               │          │   - 触发 Node.js 优雅退出与重启  │
└───────────────────────────────┘          └──────────────────────────────────┘
```

#### InContainerArtifactStrategy 原理：
1. **构建物形态**：CI 构建时产出 `mediary-scout-standalone-vX.Y.Z.tar.gz`，内含 Next.js standalone `server.js`、编译后的 `.next/standalone` 生产包与最小运行时；
2. **目录版本切换 (Symlink/Atomic Swap)**：
   - 容器内工作目录设为 `/app/current`（软链接到 `/app/releases/v2026.10.31`）；
   - 更新时下载并解压到 `/app/releases/v2026.11.01`；
   - 校验 SHA256 成功后，原子更新软链接：`ln -sfn /app/releases/v2026.11.01 /app/current_new && mv -Tf /app/current_new /app/current`；
   - 发送 `process.exit(0)`，容器在 Docker 的 `restart: unless-stopped` 策略下立即重新启动，加载全新版本！

---

## 二、 课题二：资源搜索结果访问地址查看、复制与直达跳转

### 2.1 现状与为什么此前不展示 URL

在 `packages/workflow/src/providers/resource-candidate-view.ts` 中，历史设计为了遵循防批量滥用门禁（"payload 绝不下前端"），只将标量元数据（`title`、`sizeBytes`、`seeders`、`postedAt`）投影到前端，未下发 `providerPayload.url` 与提取码。

**用户的痛点**：
- 巡影作为个人影视媒体 Agent，用户在搜索到资源候选后，常需要确认资源来源（是夸克、115，还是磁力链接？）；
- 用户有时需要手动将链接复制到外部下载工具（如迅雷、BitComet、网盘官方客户端）或分享给他人；
- 纯“盲盒入库”降低了透明度与排错效率。

### 2.2 解决方案与按需揭示架构 (On-Demand Link Reveal)

为兼顾**安全性（防止全量接口无门槛批量泄露分享码）**与**用户体验（清晰可查看、一键复制、外链直达）**，采用“**按需揭示模式 (On-Demand Reveal Pattern)**”：

1. **核心模型扩展**：
   在资源候选数据模型中增加可选的访问字段：
   - `accessUrl?: string`：资源的访问链接（网盘分享链接 `https://...` 或磁力链接 `magnet:?xt=...`）；
   - `accessCode?: string`：网盘提取码/访问密码；
   - `rawType?: string`：底层协议类型（`quark`、`115`、`magnet` 等）。
2. **按需获取与安全解密**：
   - 当用户在前端点击资源卡片上的「🔗 链接 / 复制」按钮时，前端按需调用安全接口或读取结构化访问信息；
   - 提供**一键复制到剪贴板**功能（自动拼接：`https://... 提取码: xxxx` 或复制纯磁力链接）；
   - 提供**外链直达图标**：HTTP/HTTPS 类型的网盘链接支持在新标签页一键打开预览。

---

## 三、 课题三：借鉴 LitePan 实现网盘离线下载与种子上传

### 3.1 LitePan 离线下载架构对标

在 `E:\WorkProject\Go\【第三方项目】\Litepan\LitePan-main` 中，LitePan 实现了极其成熟的多网盘离线下载与 BT 种子解析体系：
- **能力矩阵 (`OfflineDownloadCapabilities`)**：
  - 每个网盘驱动声明是否支持 URL 离线、支持的协议（`http`、`https`、`ftp`、`magnet`、`ed2k`）以及是否支持种子上传；
- **任务分发与状态流转 (`internal/offlinedownload/service.go`)**：
  - 维护离线任务状态机：`SUBMITTED` -> `DOWNLOADING` -> `COMPLETED` / `FAILED`；
- **种子文件解析 (`PrepareTorrent`)**：
  - 接收用户上传的 `.torrent` 二进制文件，解析 Bencode 结构获取 info_hash、文件列表、各个子文件的大小，允许用户过滤不需要的文件后提交给网盘。

### 3.2 巡影现有系统基础设施复用分析

经过源码级审查，巡影在 `packages/workflow/src/storage/` 中**已经完整具备一流的网盘离线下载驱动底层**：
- `Pan115CookieClient`：
  - `addOfflineTask({ url, directoryId })`：完整支持 http/https/ftp/magnet/ed2k，具备 lixianssp 专用非对称加密通信通道！
  - `listOfflineTasks()`：查询离线下载进度、大小、速度与状态！
  - `removeOfflineTask({ infoHashes })`：清理与取消离线下载任务！
- `Pan123Client`：
  - `resolveOffline(url)` + `submitOffline({ url, targetDirId, ... })` + `listOffline()`；
- `GuangYaClient`：
  - `createOfflineTask(url)` + `listOfflineTasks()`；
- `StorageBrands` 能力注册表：
  - 已经准确标注了哪些网盘具备离线下载能力（115、123、光鸭支持；天翼、夸克无公开离线 API）。

**缺失的拼图**：
目前这些强大的离线下载能力仅被后台自动化流水线调用，**在前端「网盘」页面 (`/storage`) 缺少一个面向用户的交互界面与 API 路由**！

### 3.3 离线下载架构设计（适配器 + 策略模式）

```
                  ┌───────────────────────────────┐
                  │    POST /api/storage/offline  │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │   StorageOfflineAdapter       │
                  │   - 协议解析 (Magnet/HTTP/ED2K)│
                  │   - 种子元数据解析 (Torrent)   │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │   OfflineDownloadStrategy     │
                  ├───────────────────────────────┤
                  │ 115 驱动: addOfflineTask      │
                  │ 123 驱动: submitOffline       │
                  │ 光鸭驱动: createOfflineTask   │
                  │ 夸克/天翼: 返回不支持提示     │
                  └───────────────────────────────┘
```

#### 前端交互界面设计 (`/storage`)：
- 在网盘操作栏 (`StorageTopBar`) 增加 **「离线下载」** 按钮（图标：`DownloadCloud`）；
- 点击弹出 **「离线下载控制台」(`StorageOfflineModal`)**：
  1. **直链/磁力标签页**：支持单行或多行粘贴 `magnet:?xt=...`、`http(s)://...`、`ed2k://...`；
  2. **BT 种子标签页**：支持拖拽或上传 `.torrent` 种子文件，自动解析并提取磁力链接/哈希；
  3. **目标目录选择器**：复用现有的 `DestinationPicker`（支持根目录、电影目录、剧集目录、动漫目录或自定义目录）；
  4. **能力感知与校验**：若当前选中的网盘（如天翼/夸克）不支持离线下载，界面友好提示并引导切换到 115、123 或光鸭网盘。

---

## 四、 实施计划与步骤

1. **资源搜索链接查看与复制（课题二落地）**：
   - 优化 `ResourceCandidateView` 与 `toCandidateView`：在安全保护下透传 `accessUrl`、`accessCode`；
   - 更新 `title-resource-panel.tsx`：为每个资源卡片增加直链展示标签、一键复制按钮与外链打开按钮；
   - 补充样式与测试用例。
2. **网盘离线下载服务与交互（课题三落地）**：
   - 新增 API 路由 `apps/web/app/api/storage/offline/route.ts`：处理离线能力查询与任务提交；
   - 新增前端组件 `apps/web/features/storage-drives/components/storage/storage-offline-modal.tsx`；
   - 在 `storage-top-bar.tsx` 与 `storage-manager-view.tsx` 中集成离线下载入口；
   - 完善 Design Tokens 样式并保证通过 `check-styles.mjs`。
3. **单容器自更新技术沉淀（课题一落地）**：
   - 沉淀自更新策略文档与单容器部署适配脚本。
4. **全量门禁与测试验证**：
   - 运行单元测试、`npm run gate`、浏览器端端验收。
