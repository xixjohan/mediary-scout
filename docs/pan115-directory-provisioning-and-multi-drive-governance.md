# 115 网盘目录待建根因调研、业界方案对比与多盘架构治理报告

## 1. 问题背景与现场现象

在 Mediary Scout（巡影）控制台「设置」页面（`/settings`），用户绑定 115 网盘账号（UID `3204551`）后，存储卡片状态始终显示黄色告警标识与 **“目录待建”**，无法进入绿色 **“就绪”** 状态。

同时出现以下衍生次生现象：
1. **测试连接无法恢复**：用户在卡片上点击「测试连接」按钮，系统弹出“连接正常”，但页面刷新或重新读取后，网盘状态依然卡在“目录待建”。
2. **重新扫码无法恢复**：用户重新使用 115 App 扫码登录同一账号，系统提示登录成功，但卡片状态依然保持为“目录待建”。
3. **后台 Worker 无法执行任务**：由于分类目录（Movies、TV、Anime）未就绪，文件转存和刮削流转被阻断。

---

## 2. 根本原因剖析（Root Cause Analysis）

通过全链路断点审查 `apps/web/lib/workflow-runtime.ts`、`packages/workflow/src/account-credentials.ts` 及 `packages/workflow/src/pan115-cookie-client.ts`，定位到该问题由多盘架构演进过程中的**历史单体环境变量残留（Legacy Single-Adapter Flag）与自愈路径缺失**共同导致：

### 2.1 遗留环境变量门禁导致建树逻辑被静默跳过

在 `apps/web/lib/workflow-runtime.ts` 的 `bindPan115ConnectedStorage`（第 3629-3630 行）：
```typescript
const hasEnvCids = Boolean(cids.tvCid && cids.moviesCid && cids.animeCid);
if (!hasEnvCids && process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115") {
  // 真正调用 115 API 创建 Mediary Scout/{Movies,TV,Anime} 目录并获取 CID
  const executor = createBootstrapPan115CookieStorageExecutor({ cookie: input.cookie });
  const provisioned = await provisionCategoryDirs(...);
  cids = { ...provisioned };
}
```

- **问题本质**：
  Mediary Scout 早期版本是单盘单用户架构，通过 `.env` 中的 `MEDIA_TRACK_STORAGE_ADAPTER=115` 显式开启 115 驱动。
  后来系统升级为多网盘架构（`connected_storages` 数据表模型，支持夸克、UC、天翼、123云盘、光鸭以及多账号 115 并存）。
  用户使用单容器 `docker run`（例如从 GHCR 拉取镜像运行）时，通常仅配置数据卷、数据库路径与代理等必要参数，**不会也不会主动传入 `-e MEDIA_TRACK_STORAGE_ADAPTER=115`**。
- **导致的直接后果**：
  `process.env.MEDIA_TRACK_STORAGE_ADAPTER` 为 `undefined`。
  上述条件判断 `process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115"` 评估为 `false`！
  **115 的目录初始化建树逻辑（`provisionCategoryDirs`）被直接、静默地跳过！**
  网盘凭证以 `rootCid: null, moviesCid: null, tvCid: null, animeCid: null` 写入 SQLite。

### 2.2 前端渲染与状态判定规则

在 `apps/web/lib/workflow-runtime.ts` 第 3456 行及 `apps/web/app/settings/page.tsx` 第 767-794 行：
```typescript
// workflow-runtime.ts
provisioned: Boolean(row.tvCid && row.moviesCid && row.animeCid)

// settings/page.tsx
const ready = !frozen && drive.provisioned;
...
: !drive.provisioned ? (
  <span className="tone-amber-text">目录待建</span>
) : ...
```
只要 `tvCid`、`moviesCid`、`animeCid` 中有任何一个为 `null`，`provisioned` 即为 `false`，界面统一展示为 **“目录待建”**。

### 2.3 扫码重绑（Re-bind）逻辑存在空 CID 盲区

在 `bindPan115ConnectedStorage` 第 3603-3619 行：
```typescript
if (decision.action === "refresh" && existing) {
  // Keep the already-resolved directory CIDs; only refresh the cookie.
  await refreshConnectedStorage(repository, existing, {
    ...
    rootCid: existing.rootCid,
    moviesCid: existing.moviesCid,
    tvCid: existing.tvCid,
    animeCid: existing.animeCid,
  });
  return;
}
```
当账号 `3204551` 再次扫码绑定时，系统判定为 `refresh`（刷新凭证），其设计假设是“已绑定的网盘必然已经建好目录，因此只需保留原有 CID”。但当网盘因上述原因初次绑定就缺失 CID 时，重绑直接把已有的 `null` 原封不动保留并返回，陷入死循环。

### 2.4 「测试连接」（`testConnection`）缺乏自愈补建机制

在 `apps/web/lib/workflow-runtime.ts` 第 2849 行的 `testConnection`：
```typescript
await probeStorageConnection(
  creds.provider,
  creds.cookie,
  creds.rootCid,
  creds.credential,
  makeTokenPersister(accountId, creds.id, creds.provider),
);
await getWorkflowRepository().setConnectedStorageStatus(creds.id, "active", null, null);
return { ok: true, status: "active", message: "连接正常。" };
```
- `probeStorageConnection` 对 115 网盘仅仅执行了一次 `getDirectoryInfo("0")`（探活根目录）。
- 探活成功证明当前 Cookie 具备读写 115 的有效权限。
- 但在确认网盘活性的同时，代码**完全没有检查网盘的分类 CID 是否处于缺失状态**，直接返回“连接正常”，错失了绝佳的原地自愈（In-situ Self-Healing）时机。

### 2.5 后台任务与执行器层面的连环阻断

- **后台自愈受阻**：在 `resolveLiveWorkflowContext`（第 2730 行）：
  ```typescript
  const liveMode = process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115";
  if (liveMode && drive.status === "active" && !(rootCid && moviesCid && tvCid && animeCid)) {
    // 自动补建
  }
  ```
  同样受制于 `liveMode` 判定，因未配置环境变量而永远不执行。
- **执行器回退 Fake 风险**：在 `getWorkerStorageExecutor`（第 3008 行）：
  ```typescript
  const adapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake";
  if (adapter === "115") { ... }
  ```
  未显式配置 `115` 时，默认回退至 `fakeStorageExecutor`，导致后台任务在真实数据库有盘的情况下依然跑 Mock。

---

## 3. 业界主流方案调研与对比

| 系统 / 方案 | 存储挂载模式 | 目录初始化时机 | 环境变量依赖 | 异常状态自愈设计 |
| :--- | :--- | :--- | :--- | :--- |
| **AList** | 虚拟挂载点自治（Mount Decoupling） | 挂载即探活，按需延迟或挂载时确认根目录 | **零环境变量**，一切从存储驱动配置表动态获取 | 驱动状态持久化，配置页提供一键“刷新 / 重载挂载” |
| **CloudDrive2** | 虚拟文件系统（VFS）映射 | 挂载时探活根目录，初次读写时自动按需映射层级 | **零环境变量**，挂载点独立隔离 | 控制台提供“重新连接 / 修复挂载”按钮 |
| **MoviePilot / Nastools** | 下载器 / 网盘工作目录管理 | 绑定网盘或保存下载目录时即时校验并自动 `mkdir` | **零环境变量**，以表单 / 数据库为准 | 任务消费或系统自检时校验目录是否存在，不存在则重试创建 |
| **Mediary Scout 其它网盘**（夸克 / UC / 天翼 / 123 / 光鸭） | 多盘工作区模型（`connected_storages`） | 绑定时直接调用 `provisionCategoryDirs` | **零环境变量**，绑定即建树 | 各网盘在 `connect*` 中均已直接建树 |
| **Mediary Scout 115 历史实现（待优化）** | 混杂单体与多盘模型 | 绑定时强制依赖 `MEDIA_TRACK_STORAGE_ADAPTER===115` | **强依赖遗留环境变量**，未配则跳过建树 | 无主动原地自愈，重绑保留 null，测试连接不补建 |

### 关键架构启示
1. **去全局环境变量（Decouple Global Env Flags）**：在现代 Web UI 驱动的多网盘系统里，用户在「设置」中完成扫码绑定，就已经以最高优先级明确表达了“使用该网盘”的用户意图。系统不应再要求宿主机或容器启动命令传入特定的驱动环境变量。
2. **测试连接即自愈入口（Test Connection as Healing Trigger）**：用户在发现“目录待建”或状态异常时，第一反应一定是点击卡片上的「测试连接」。将“校验凭证 + 缺失目录检测与自动初始化补建”闭环到该操作中，能提供最自然的无感自愈体验。
3. **幂等性保障（Idempotent Provisioning）**：系统底层 `provisionCategoryDirs` 本身已具备高可靠的“查重-若无则建”（Find-or-Create）幂等语义，重复执行绝不会造成文件破坏或目录重复生成。

---

## 4. 落地解决方案与架构设计

### 4.1 解除环境变量强依赖（真实驱动以网盘连接为准）

将系统中所有阻断 115 真实建树的遗留检查：
```typescript
// 修改前
if (!hasEnvCids && process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115")
const liveMode = process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115";

// 修改后
if (!hasEnvCids && process.env.MEDIA_TRACK_STORAGE_ADAPTER !== "fake")
const liveMode = process.env.MEDIA_TRACK_STORAGE_ADAPTER !== "fake";
```
- **语义转换**：由“必须显式指定 115”转变为“除非处于 Vitest/E2E 指定的 fake 桩模式，否则只要绑定网盘一律走真实驱动建树”。
- **单容器友好**：用户直接运行 `docker run ghcr.io/...` 无需附加 `-e MEDIA_TRACK_STORAGE_ADAPTER=115` 也能完整开箱即用。

### 4.2 「测试连接」赋予原地自愈能力（In-situ Self-Healing）

在 `testConnection` 中，当 `probeStorageConnection` 成功后：
```typescript
await getWorkflowRepository().setConnectedStorageStatus(creds.id, "active", null, null);

// 原地自愈：若该网盘因历史原因缺失分类 CID（处于“目录待建”），立即补建并写回数据库
if (!(creds.rootCid && creds.moviesCid && creds.tvCid && creds.animeCid)) {
  try {
    const p = await provisionDriveCategoryDirs(creds.provider, creds.cookie, creds.credential);
    const drive = (await getWorkflowRepository().listConnectedStorages(accountId)).find((s) => s.id === creds.id);
    if (drive) {
      await getWorkflowRepository().upsertConnectedStorage({
        id: drive.id,
        accountId,
        provider: drive.provider,
        providerUid: drive.providerUid,
        label: drive.label,
        payload: drive.payload,
        rootCid: p.rootCid,
        moviesCid: p.moviesCid,
        tvCid: p.tvCid,
        animeCid: p.animeCid,
        createdAt: drive.createdAt,
      });
      return { ok: true, status: "active", message: "连接正常，目录已初始化就绪。" };
    }
  } catch (provErr) {
    console.error(`[media-track] testConnection auto-provision failed for ${creds.id}: ${String(provErr)}`);
  }
}
```
**立竿见影的效果**：对于用户现存 UID `3204551` 卡在“目录待建”的网盘，更新镜像后**只需点击一次「测试连接」**，系统就会自动在 115 中建立 `Mediary Scout/{Movies,TV,Anime}` 目录，将 CID 存入 DB，卡片立即转为“就绪”！

### 4.3 扫码重绑（`refresh`）自动补全缺失 CID

在 `bindPan115ConnectedStorage` 的 `refresh` 分支中，如果发现已绑定的记录 `existing` 缺少分类 CID，一并触发 `provisionCategoryDirs` 补建，彻底解决重绑死锁问题。

### 4.4 Worker 存储执行器支持动态多盘派发

在 `getWorkerStorageExecutor` 中：
当 `adapter !== "fake"` 时，若当前账号或指定存储在数据库中有记录（`creds` 存在），直接构建该网盘品牌的真实执行器（`Storage115Executor` / `QuarkStorageExecutor` 等），不再受环境变量阻断。

### 4.5 `Pan115CookieClient` 网络请求与 UA 健壮性加固

- 默认 User-Agent 由旧式 `media-track/0.1` 升级为现代标准桌面 Chrome UA：
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`
- 标配 `Referer: "https://115.com/"` 与 `Connection: "close"`，彻底规避 115 WebAPI 针对非浏览器头部的偶发断连或 502/RST。

---

## 5. 质量门禁与回归预防测试体系

为了确保本次修复稳固且未来不再回归，建立以下自动化测试矩阵：

1. **测试用例 1：`bindPan115ConnectedStorage` 无环境变量建树测试**
   - 验证在 `process.env.MEDIA_TRACK_STORAGE_ADAPTER` 未设置的前提下，首次绑定 115 网盘能够正确创建 `rootCid`、`moviesCid`、`tvCid`、`animeCid`。
2. **测试用例 2：`testConnection` 原地自愈测试**
   - 在数据库中注入一个 CIDs 全为 `null` 的 115 网盘（模拟“目录待建”状态），调用 `testConnection`。
   - 断言：返回信息包含“目录已初始化就绪”，数据库中该网盘记录的 `tvCid`、`moviesCid` 等字段被成功更新回填。
3. **测试用例 3：重绑自愈测试**
   - 针对一个 CIDs 缺失的网盘重新执行 QR 扫码换票，验证其不仅更新了 Cookie，还完成了目录补建。
4. **测试用例 4：Fake 模式保护**
   - 确保显式设置 `MEDIA_TRACK_STORAGE_ADAPTER=fake` 时，单元测试环境依然走内存虚拟驱动，不产生实际外部网络调用。
