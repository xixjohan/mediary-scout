# MCP 影视规范化整理执行超时与 Staging 临时目录泄漏根因调研与解决方案架构规范

> **文档版本**：v1.0.0  
> **归档日期**：2026-11-22  
> **涉及模块**：`apps/web/app/api/mcp/`、`packages/workflow/src/execution/`、`packages/workflow/src/storage/`、`apps/web/app/api/titles/organize/`  
> **关联议题**：MCP `executeOrganizeMedia` 连续 5 次超时 (`tool_execution_timeout` 30s 截断)、网盘 `staging-<uuid>` 目录泄漏滞留、115 API 文件被误识为文件夹 (`isFolder: true`)。

---

## 一、执行摘要与现场复盘 (Executive Summary)

### 1. 故障现场还原
在智能体与 MCP 服务的协作中，对个人网盘中已下载/转存完成的 8 部影视作品（包括 TMDB 285993《暗黑灯火》、256721《咔嚓咔嚓》、312949《尼古喵喵》、323824《咒术回战 小剧场》、106449《凡人修仙传》等）执行规范化影视整理：
1. **计划阶段 (`planOrganizeMedia`) 100% 成功**：
   - 携带 `directoryId` 参数调用时，能够精确识别出各作品的视频文件数、待清理的 `staging-*` 临时目录列表、多版本重复集，并全部输出 `canExecute: true`。
2. **执行阶段 (`executeOrganizeMedia`) 连续 5 次全部超时**：
   - 并发 4 部执行时：全部直接返回 `tool_execution_timeout`，`retryable: false`。
   - 降级为最小单条重试（仅整理《暗黑灯火》：12 个视频文件、2 个 staging 目录、6.15GB 纯冗余）：**依然触发 `tool_execution_timeout`**。
3. **实盘状态比对**：
   - 执行前后网盘目录与文件**零变化**，没有任何文件被成功移位、重命名或归档，且所有 `staging-*` 目录原封不动保留。
   - 网盘中遗留大量历史 `staging-*` 目录无法回收，典型如 TV 类目下的《遭流放的重骑士》累积了高达 15 个 `staging-<hex>` 孤儿目录。
   - 115 目录列举呈现严重异化：部分 staging 内的 `.mp4` 文件条目返回 `isFolder: true` 且 `sizeBytes: 0`。

```
[MCP Client (AITool / Claude Desktop)] ──(30s 硬超时截断)──> 🔴 tool_execution_timeout
                  │ 
                  ▼ (阻塞式 HTTP 串行往返: 40~90s+)
[Mediary Scout: executeOrganizeMedia]
      ├── 1. 缺失 directoryId 参数 ➔ 降级扫描全盘 Anime/TV 父目录 (数十次 API)
      ├── 2. 115 漏桶限速器 (LeakyBucketPacer) ➔ 每次 HTTPS 往返强制休眠 500~1000ms
      ├── 3. 递归树遍历 + 多集移动 + 重命名 + 归档创建 (共计 40~70 次 API)
      └── 4. 115 .mp4 文件被误识为文件夹 ➔ isSafeToRemoveStaging 触发防御阻断删除
```

---

## 二、五层深度根因分析 (Deep 5-Layer Root Cause Analysis)

经过全链路代码审计与底层执行流排查，确认本次故障由以下 5 个维度的架构缺陷耦合导致：

### 第 1 层：MCP 同步调用模型与客户端 30s 硬超时的根本失配
- **客户端硬超时约束**：
  在 MCP 宿主端（如 `AITool.AgentRuntime`），工具执行流水线对每次调用设置了不可协商的硬性时限：
  ```csharp
  // AITool: AgentToolExecutionPipeline.cs
  private readonly TimeSpan timeout = timeout ?? TimeSpan.FromSeconds(30);
  ```
  任何工具如果单次 HTTP 响应未能于 30 秒内完整交付，宿主底层立即抛弃并向模型返回 `tool_execution_timeout`。
- **服务端重型 I/O 阻塞**：
  `executeOrganizeMedia` 是一个**全同步阻塞式单体流程**。处理单个影视作品整理需顺序执行：
  `listChildDirectories` ➔ `listTree` ➔ `ensureSeasonDirectory` ➔ `moveFile` (×N) ➔ `renameFile` (×N) ➔ `createArchiveFolder` ➔ `archiveItems` ➔ `removeDirectory` (×M) ➔ `dedupeSeasons` ➔ `reconcileState`。
- **网盘限流风控累加**：
  为防止触发 115 网盘的风控与 429 封禁，系统底层引入了 `LeakyBucketPacer`，对所有 115 WebAPI 调用施加了 500ms~1000ms 的串行等待。
  即使一部只有 12 集的轻量作品，处理完整生命周期至少产生 **45 次以上远程 API 往返**：
  $$\text{耗时} = 45 \times (\text{网络 RTT } 200\text{ms} + \text{网盘处理 } 300\text{ms} + \text{限速等待 } 600\text{ms}) \approx 49.5\text{ 秒}$$
  该耗时天然突破 30 秒上限，无论重试多少次，**在数学上必定 100% 超时**。

---

### 第 2 层：MCP 工具入参定义遗漏导致“全盘父目录扫描”被动放大
对比 `planOrganizeMedia` 与 `executeOrganizeMedia` 的定义与实现，发现严重的接口参数不对齐 Bug：

| 工具名称 | `apps/web/app/api/mcp/tools.ts` 参数定义 | `drive-media-executor.ts` 解析逻辑 |
| :--- | :--- | :--- |
| `planOrganizeMedia` | 包含 `tmdbId`, `seasonNumber`, `storageId`, **`directoryId`** | 正常解析 `args.directoryId` 并传入目标解析器 |
| `executeOrganizeMedia` | 仅包含 `tmdbId`, `seasonNumber`, `storageId`, `cleanStaging`, `dedupeVersions`（**缺失 `directoryId`**） | **完全未提取 `args.directoryId`**，强制回退 |

- **连锁恶化反应**：
  1. `executeExecuteOrganizeMedia` 无法获得作品真实目录 ID，回退逻辑降级为：
     `const effectiveDirectoryId = input.directoryId ?? tracked.season.storageDirectoryId;`
  2. 对于剧集与动漫，`tracked.season.storageDirectoryId` 存储的是具体的季目录（如 `Anime/暗黑灯火/Season 01`），**而非作品主目录**！
  3. `handleTvOrganize` 拿到 `Season 01` 作为 `sourceDirectoryId`，其子目录没有任何 `staging-*`。
  4. 系统进而误判为“非标准目录结构”，强行调用 `resolveCanonicalTvDirectory`：
     ```ts
     const canonicalShowDirId = await resolveCanonicalTvDirectory(
       input.storage,
       input.tvParentDirectoryId, // 宿主的大类根目录：Anime/ 或 TV/
       input.title,
       input.sourceDirectoryId,
     );
     ```
  5. 这导致 115 驱动反向去全盘遍历该分类下的**所有作品文件夹**，发起数十次额外 API 检索，将整体耗时瞬间翻倍，雪上加霜。

---

### 第 3 层：一体化重型单体管线 (Monolith) 缺乏轻量原子操作
当前系统对外只提供了一个庞大的一体化执行接口：
- **全流程强制绑定**：视频识别、重命名、季集规范移动、软归档多版本、残留文件审计、删除 staging、季目录去重、数据库状态对账全部揉在一个事务中。
- **缺乏局部治理能力**：
  当用户或 Agent 发现目录中已整理完毕，仅仅滞留了几个空的 `staging-*` 临时目录时，系统**没有**提供任何类似于 `cleanStagingDirectories`、`dedupeSeasonVersions` 或 `organizeSingleStaging` 的轻量原子工具。
  为了清理 2 个空壳目录，必须强行调度整个重型管线，导致“大炮打蚊子”，频繁因周边环节超时而导致最基础的清理动作也无法落地。

---

### 第 4 层：115 API 字段异化与适配层误判 (`isFolder: true` 与 `sizeBytes: 0`)
现场观察到 115 staging 内的 `.mp4` 文件返回了 `isFolder: true` 且体积为 0。排查 `packages/workflow/src/storage/drive-file-manager.ts` 与 `storage-115-executor.ts`：

```ts
// packages/workflow/src/storage/drive-file-manager.ts (164-170行)
const hasFileId = Boolean(r.fid ?? r.file_id);
const isFolder =
  !hasFileId &&
  (r.fc === 0 ||
    r.fc === "0" ||
    (r as { ico?: string }).ico === "folder" ||
    (r.cid !== undefined && !hasFileId)); // ⚠️ 致命误判点
```

```ts
// packages/workflow/src/storage/storage-115-executor.ts (1808-1813行)
function isDirectory(item: Pan115Item): boolean {
  if (item.isDirectory !== undefined) return item.isDirectory;
  if (Boolean(item.fid ?? item.file_id)) return false;
  if (item.fc === "0" || item.fc === 0) return true;
  return item.cid !== undefined; // ⚠️ 致命误判点
}
```

- **缺陷机理**：
  115 WebAPI `/files` 返回的项中，**任何存在于文件夹内部的文件都附带 `cid` 字段**（代表其父目录分类 ID）。
  当 115 在离线转存完成初期、或部分特殊列表响应中未返回显式的 `fid`/`file_id`（仅返回 `id`、`pc` 或尚未同步文件元数据时），`hasFileId` 为 `false`。
  此时表达式 `(r.cid !== undefined && !hasFileId)` 被无条件评估为 `true`！
  **一个真正的 `.mp4` 视频文件被错误地标记为了文件夹**，其 `sizeBytes` 被归零，且无法被 `isVideoFile()` 识别。

---

### 第 5 层：Staging 目录安全防护的“锁死效应”与 Janitor 泄漏
在 `packages/workflow/src/execution/media-organizer.ts` 中，为防止误删用户正片，设计了极严苛的白名单安全检查：

```ts
function isSafeToRemoveStaging(tree: PackageTreeFile[]): boolean {
  if (tree.length === 0) return true;
  const allJunk = tree.every((file) => {
    const name = file.path.split("/").filter(Boolean).pop() ?? "";
    return isJunkFile(name);
  });
  if (!allJunk) return false;
  const totalBytes = tree.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  return totalBytes < 50 * 1024 * 1024;
}
```

- **锁死闭环**：
  1. 因上述第 4 层的类型误判，或者整理流程在超时前未能将冗余视频彻底移入 Archive 目录；
  2. staging 目录内依然保留有被识别为“未知对象”或视频的文件；
  3. `isSafeToRemoveStaging` 判定 `allJunk === false`，严正拒绝删除（`remaining.push(dir.name)`）；
  4. 后台常驻的 `StagingJanitor` 每日巡检时，发现该 staging 内存在未入库的视频，判定其非纯垃圾，转而试图创建 `staging_recovery` 任务；
  5. 但由于 `RECOVERY_CAP = 5` 上限限制，以及重试整理依然因超时失败，这些 staging 目录陷入“**不能删 ➔ 整理又超时 ➔ 再次跳过 ➔ 长期滞留**”的永久死锁，最终形成如《遭流放的重骑士》累积 15 个 staging 目录的严重泄漏。

---

## 三、业界主流方案调研与对比 (Industry Benchmarks)

针对自动化影视整理（MediaOps）领域的“长 I/O 操作超时”、“文件系统碎片清理”与“网盘频控适配”，调研了业界主流系统与规范：

| 维度 / 系统 | **Sonarr / Radarr** (欧美主流媒体自动化) | **MoviePilot / NASTool** (国内 NAS/网盘 MediaOps) | **Rclone** (云存储同步标准) | **Mediary Scout (现状 vs 目标)** |
| :--- | :--- | :--- | :--- | :--- |
| **执行模式** | **完全异步事件驱动**<br>(Event-Driven Job Queue) | **异步工作流 + 调度器**<br>(Celery / BackgroundWorker) | **异步 RC API**<br>(Submit ➔ Job ID ➔ Status) | **现状**：同步阻塞 HTTP<br>**目标**：双模（轻量同步 + 重型异步 Job） |
| **超时对抗** | API 仅下发命令立即返回 `CommandId`，前台通过 WebSocket/SignalR 监听进度 | 前端轮询 `/api/v1/transfer/progress`，任务在独立后台线程执行 | 客户端发起请求后返回 `jobid`，轮询 `/job/status` | 改造 MCP 工具支持 `async: true` 立即返回 `taskId`，配合 `queryStatus` |
| **原子化拆分** | 拆分为：扫描、识别匹配、移动/硬链、旧版清理 4 个独立原子 Step | 拆分为：转移服务、重命名引擎、目录清理守护进程 (`Cleaner`) | 单独提供 `rmdirs`、`cleanup` 等专用指令 | 新增 `cleanStagingDirectories` 与 `dedupeSeasonVersions` 原子工具 |
| **网盘批量接口** | 主要针对本地 POSIX 文件系统，通过文件句柄与硬链接秒级完成 | 针对 115 采用批量删除接口 `/rb/delete`，单次传参数百个 FID | 内置 `--tpslimit` 与 `--fast-list`，聚合元数据请求 | 改造底层删除逻辑，引入批量删除，耗时降低 80% |
| **临时目录管理** | 导入完成后立即销毁对应下载客户端标签；源目录空壳自动触发清理 | 独立垃圾文件与空目录巡检守护线程，带重试退避机制 | `--delete-empty-src-dirs` 深度递归级联回收 | 修复 `isDirectory`，放宽无用元数据文件清理门槛 |

### 业界方案启示
1. **不要在 RPC/HTTP 同步链路中等待多文件 I/O**：对于涉及外部云存储的重型整理，耗时具有极大的不确定性，必须采用“提交任务 ➔ 返回任务标识 ➔ 轮询状态”的标准异步任务模式。
2. **读写分离与原子化**：允许客户端在不触发完整生命周期的情况下，执行单一目的的维护操作（如仅清空垃圾或空目录）。
3. **云存储必须拥抱批处理 (Batch Operations)**：通过单次 HTTP 传递批量文件 ID 列表，代替在循环中单条 `await deleteFile()`，将网络 RTT 损耗压缩一个数量级。

---

## 四、系统现有基础设施与资产复用评估

系统无需引入笨重的外部数据库或消息队列中间件，现有代码库中已具备极其健壮的基础设施可直接复用：

```
                    ┌── 1. 任务调度 ──> WorkflowRepository (SQLite WAL)
                    │                  支持持久化 WorkflowRun (status: queued/running/succeeded)
                    │
现有可复用资产架构 ──┼── 2. 执行引擎 ──> worker-runner-service.ts
                    │                  已有 inprocess / external Worker 调度循环与任务认领
                    │
                    ├── 3. 归档核心 ──> StorageArchiveAdapter (多版本冲突规范软归档)
                    │
                    └── 4. 巡检清理 ──> StagingJanitor (具备配额防爆与目录游标恢复机制)
```

1. **`WorkflowRepository` 与 `WorkflowRun`**：
   - 现已支持 `kind: "title_organize"` 类型的持久化任务，具备 `queued`、`running`、`succeeded`、`failed` 标准状态机与 JSON 数据快照存储。
2. **`worker-runner-service.ts`**：
   - 容器内无论处于开发态还是正式生产环境，均常驻有轻量 Worker 处理循环，具备天然的后台任务消费能力，零新增容器依赖。
3. **`apps/web/app/api/mcp/tools.ts` 与 `queryStatus`**：
   - MCP 当前已有 `queryStatus` 工具，能够无缝查询后台排队任务的执行详情，天然支持异步结果轮询。

---

## 五、具体解决方案与架构改造规范 (Concrete Solutions)

### 方案 1：修复 115 API 文件与文件夹判定 Bug (Defensive Typing Fix)
彻底纠正 `packages/workflow/src/storage/drive-file-manager.ts` 与 `storage-115-executor.ts` 中的目录误判逻辑：

```ts
// 改进后的严格判定规范：
function isPan115Folder(r: Record<string, unknown>): boolean {
  if (typeof r.isDirectory === "boolean") return r.isDirectory;
  // 1. 显式具有文件标识或扩展名，绝不是文件夹
  const hasFileId = Boolean(r.fid ?? r.file_id);
  const name = String(r.name ?? r.n ?? "");
  const hasVideoOrKnownExt = /\.(mp4|mkv|avi|mov|iso|ts|sub|srt|ass|nfo|txt|jpg|png)$/i.test(name);
  if (hasFileId || hasVideoOrKnownExt) return false;

  // 2. 文件夹特征：明确带有 folder 标、或者子文件计数/目录标记
  const isExplicitFolder =
    (r as { ico?: string }).ico === "folder" ||
    r.dir === 1 ||
    r.dir === "1";
  if (isExplicitFolder) return true;

  // 3. 仅在未匹配任何扩展名、无 fileId 且未标记非文件夹时才回退
  return Boolean(r.fc === 0 || r.fc === "0");
}
```

---

### 方案 2：MCP `executeOrganizeMedia` 参数补齐与双模架构 (Async/Sync Dual Mode)
1. **补齐 `directoryId` 声明与解析**：
   - 在 `apps/web/app/api/mcp/tools.ts` 的 `executeOrganizeMedia` 工具输入属性中增加 `directoryId: { type: "string", description: "待整理的作品或目录 ID（强烈建议传入，避免全盘回退扫描）" }`。
   - 在 `drive-media-executor.ts` 的 `executeExecuteOrganizeMedia` 中显式提取并传入 `resolveTrackedTarget`。
2. **引入 `asyncExecution` 异步任务化模式**：
   - 工具入参增加 `asyncExecution: { type: "boolean", description: "是否异步后台执行（默认 true，防止 MCP 客户端 30s 超时）" }`。
   - 当 `asyncExecution: true` 时：
     系统直接向 `WorkflowRepository` 创建一条 `kind: "title_organize"` 的 `WorkflowRun` 记录，并在 50ms 内直接向 MCP 客户端返回：
     ```json
     {
       "ok": true,
       "mode": "async",
       "taskId": "run_01934abc_def",
       "status": "queued",
       "tmdbId": 285993,
       "title": "暗黑灯火",
       "message": "影视整理任务已提交后台持久化队列，请通过 queryStatus 查询任务完成状态。"
     }
     ```
     彻底根绝客户端 30s `tool_execution_timeout` 截断！
   - 当 `asyncExecution: false` 时：
     保留给前端即时调试或极小批量测试，并设置内部 25s 熔断保护，超时前优雅返回部分整理进展与建议。

---

### 方案 3：新增细粒度原子 MCP 工具 (Fine-Grained Atomic Tools)
将大单体解耦，新增 2 个轻量化专项目标工具：

#### 1. `cleanStagingDirectories` (临时目录专项清理)
- **定位**：轻量级秒级运维，专门解决 staging 堆积。
- **签名**：
  ```json
  {
    "name": "cleanStagingDirectories",
    "description": "安全清理指定作品下已完成或残留的空 staging 临时目录（轻量秒级完成）",
    "inputSchema": {
      "type": "object",
      "required": ["tmdbId"],
      "properties": {
        "tmdbId": { "type": "number", "description": "TMDB 作品 ID" },
        "directoryId": { "type": "string", "description": "作品目录 ID" },
        "forcePurgeJunk": { "type": "boolean", "description": "是否强力清除仅含 .nfo/.txt/宣传网页等垃圾残留的目录（默认 true）" }
      }
    }
  }
  ```
- **耗时**：仅需 1~3 次 API 调用，耗时 < 2 秒，绝不超时。

#### 2. `dedupeSeasonVersions` (季目录多版本去重软归档)
- **定位**：针对季目录中的 `(1).mp4` 等同集多版本，转移至 Archive 归档。
- **签名**：
  ```json
  {
    "name": "dedupeSeasonVersions",
    "description": "对指定作品季目录执行多版本文件扫描与规范化归档，不触发 staging 重构",
    "inputSchema": {
      "type": "object",
      "required": ["tmdbId"],
      "properties": {
        "tmdbId": { "type": "number", "description": "TMDB 作品 ID" },
        "seasonNumber": { "type": "number", "description": "指定季号（可选，默认扫描全部季）" }
      }
    }
  }
  ```

---

### 方案 4：115 驱动批量删除与白名单放宽优化 (Batch I/O & Metadata Tolerance)
1. **放宽 `isSafeToRemoveStaging` 清理判定**：
   - 现实中转存目录常附带迅雷/BT 产生的 `readme.txt`、`扫码关注.url`、海报缩略图等残余文件。
   - 将“必须 100% 为空”优化为：**只要目录内不含有效视频文件（或视频文件总体积为 0），所有附带的元数据/宣传文件随 staging 目录一并自动安全物理清除**，防止因一个 1KB 的 `.url` 锁死整个 staging 目录。
2. **批量删除 API 聚合**：
   - 改造 `storage-115-executor.ts`，将循环单次调用 `/rb/delete` 聚合为单次请求传递 `fid[]` 数组，将原本 20 个目录/文件的删除耗时从 15 秒缩减至 400 毫秒。

---

## 六、质量门禁与回归预防体系 (Quality Gates & Regression Prevention)

为杜绝未来代码迭代中再次引入长请求超时与临时目录泄漏，建立以下 3 级工程质量门禁：

```
[PR / 代码提交]
      │
      ├── 1. Gate: MCP 执行时限守护 (gate:mcp-timeouts)
      │      • 针对所有 MCP 工具，注入 Mock 延迟驱动，断言同步单次执行时间 <= 15s
      │      • 任何涉及网盘批量 I/O 的工具必须实现 asyncExecution 分支
      │
      ├── 2. Gate: 115 异化字段反序列化单测 (test:storage-115-typing)
      │      • 构造缺失 fid 仅含 cid/id 的 .mp4 文件夹杂返回样本
      │      • 断言 isFolder 必须严格为 false，不得发生类型倒置
      │
      └── 3. Gate: Staging 孤儿回收与安全删除单测 (test:staging-janitor-safety)
             • 测试覆盖：纯空目录、仅含垃圾 txt/url 的目录、含真实视频的目录
             • 断言：前两类 100% 成功清理，第三类安全保留并上报
```

### 1. `gate:mcp-timeouts` 门禁规则
- 凡是在 `apps/web/app/api/mcp/tools.ts` 中注册的工具，必须显式定义属于 `read`、`fast-write` 还是 `async-job`。
- 对于 `async-job` 类别的写操作，必须默认返回带 `taskId` 的轻量响应，并由契约测试验证其在 30 秒断开场景下的自愈与后台执行连续性。

### 2. 自动化回归测试用例清单
- `apps/web/app/api/mcp/drive-media-executor.test.ts`：
  - 测试用例：`executeExecuteOrganizeMedia` 显式透传 `directoryId`，不得触发 `resolveCanonicalTvDirectory`。
  - 测试用例：`cleanStagingDirectories` 能够在 2 次 Mock 调用内完成清理并返回删除清单。
- `packages/workflow/tests/storage/pan115-file-manager.test.ts`：
  - 测试用例：模拟 115 返回特殊格式条目 `{ id: "123", cid: "456", n: "video.mp4" }`，验证 `isFolder === false`。
- `packages/workflow/tests/execution/media-organizer.test.ts`：
  - 测试用例：staging 目录内包含 `.url` 和 `.txt` 时，`isSafeToRemoveStaging` 正常返回 `true`。

---

## 七、实施路线图与落地计划 (Implementation Roadmap)

| 阶段 | 实施任务 | 关键产出文件 | 预期耗时 |
| :--- | :--- | :--- | :--- |
| **Phase 1: 核心 Bug 修复** | 1. 修复 `drive-file-manager.ts` 与 `storage-115-executor.ts` 中的 `isFolder` 判定<br>2. 优化 `isSafeToRemoveStaging` 白名单规则，容忍非视频宣传杂质 | `packages/workflow/src/storage/drive-file-manager.ts`<br>`packages/workflow/src/execution/media-organizer.ts` | 0.5 天 |
| **Phase 2: MCP 参数与原子工具补全** | 1. `executeOrganizeMedia` 补充 `directoryId` 参数<br>2. 新增 `cleanStagingDirectories` 轻量原子工具（秒级清空 staging 泄漏）<br>3. 新增 `dedupeSeasonVersions` 原子工具 | `apps/web/app/api/mcp/tools.ts`<br>`apps/web/app/api/mcp/drive-media-executor.ts` | 1 天 |
| **Phase 3: 异步任务解耦与批处理** | 1. `executeOrganizeMedia` 支持 `asyncExecution: true`（生成 `WorkflowRun` 走后台 worker）<br>2. 115 驱动集成批量删除与批量移动 API | `apps/web/app/api/mcp/drive-media-executor.ts`<br>`packages/workflow/src/storage/storage-115-executor.ts` | 1 天 |
| **Phase 4: 门禁与端到端实机验收** | 1. 编写 115 数据反序列化单测与超时防御单测<br>2. 执行 `scripts/deploy-remote.ps1 -Mode Dev` 部署至开发容器 (3020 端口)<br>3. 在内置浏览器与 MCP 客户端完成实盘影视整理验证 | `tests/`<br>Playwright / DevTools MCP | 0.5 天 |
