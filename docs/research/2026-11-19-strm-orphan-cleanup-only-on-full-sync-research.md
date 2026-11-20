# 网盘里删掉的片子，本地 `.strm` 却留着：孤儿清理被绑在 `full_sync` 上

- 日期：2026-11-19
- 状态：调研完成（含门禁设计），方案待实施
- 触发现象：115 网盘上删除影片后，执行 STRM 扫描（含手动「立即扫描」），本地 `.strm` 文件仍在；媒体服务器里那部片还在，点开报 404
- 数据来源：生产容器 `mediary` 的 `data/mediary.db` + 磁盘文件计数（只读）

---

## 1. 结论先行

**孤儿清理的调用被硬编码绑定在 `full_sync` 模式上，而线上三个任务全是默认的 `incremental_missing`。**

[strm-scanner.ts:389](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/strm/strm-scanner.ts#L389)：

```ts
if (task.scanMode === "full_sync") {
  await onProgress?.({ phase: "cleaning_orphans", ... });
  await this.cleanOrphanFiles(localStrmMap, expectedLocalRels, result);
}
```

也就是说：**「删掉的片子要清掉」这件事，只在用户主动把任务改成「全量镜像」时才会发生**。

### 1.1 生产实锤

三个任务的模式与本地文件数：

| 任务 | 模式 | 上次扫描远端有效文件 | 本地 `.strm` 实际数 | 差 |
| --- | --- | --- | --- | --- |
| `115_anime` | `incremental_missing` | 38 | **955** | **+917** |
| `115_movies` | `incremental_missing` | 9 | **20** | **+11** |
| `115_tv` | `incremental_missing` | 178 | **225** | **+47** |

最近 12 次扫描记录的 `removed_count` **全部为 0**——不是因为「没有孤儿」，而是这条路径根本没执行。

> 注意 `lastScanAt` 最新的是 `12:29`（手动扫描），`removed_count: 0`、`updated_count: 9`。手动扫描同样受这个模式门限制。

### 1.2 为什么「增量补缺」不含删除

三种模式在 UI 里的文案（[create-strm-task-modal.tsx:206](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/components/create-strm-task-modal.tsx#L206)）已经暗示了这个语义：

| 模式 | UI 文案 | 实际行为 |
| --- | --- | --- |
| `incremental_missing` | 增量补缺（仅补全新增） | 只生成缺失 + 内容失效自愈；**从不删除** |
| `incremental_update` | 增量更新（覆盖修改） | 生成 + 覆盖已存在；**从不删除** |
| `full_sync` | 全量同步（含空盘保护清空） | 生成 + 覆盖 + **清理孤儿** |

而 `incremental_missing` 是**所有创建入口的默认值**（[repository.ts:2505](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/persistence/repository.ts#L2505)、两个 modal 的初始 state），所以绝大多数部署永远走不到清理分支。

**这不是遗漏，是一个被默认值放大的设计缺陷**：删除只在「用户主动选择最激进模式」时发生，而「远端删了、本地该跟着删」是**常规同步语义**，不是激进选项。

---

## 2. 根因分层

| 层 | 缺陷 | 后果 |
| --- | --- | --- |
| **调度** | 清理绑定 `full_sync`，与「增量」互斥 | 默认模式下孤儿永不清 |
| **语义** | 「增量」被理解成「只增不删」，但用户期待的是「同步」（增删都跟） | UI 文案与实际预期不符 |
| **安全** | 唯一的保护是 `full_sync` + 空盘保护（`validRemoteCount === 0`） | 增量模式下若**远端返回 0 个文件**（网络抖动 / 令牌过期 / 目录被改名），一旦放开删除就会**清空整个本地库** |
| **可见性** | 扫描记录只有 `removed_count`，从不解释「为什么 0」 | 用户无法区分「没有孤儿」与「没跑清理」 |
| **媒体服务器** | `notifyFilesChanged` 只在 `generatedPaths.length > 0` 时调用（[strm-runner-service.ts:72](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/application/strm-runner-service.ts#L72)） | 即使删了 `.strm`，Emby/Jellyfin 也不会被通知刷新，条目要等下次全库扫描才消失 |

最后一条独立存在：**删除路径没有「通知媒体服务器」这一环**。

---

## 3. 现有可复用的基础设施（不需要新库）

| 能力 | 现有实现 | 本方案怎么用 |
| --- | --- | --- |
| 孤儿清理算法 | `cleanOrphanFiles()`（[strm-scanner.ts:243](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/strm/strm-scanner.ts#L243)）+ `removeStrmFile(path, cleanupEmptyDir)` 递归删空目录 | **原样复用**，只改调用条件 |
| 空盘保护 | `checkEmptyProtect()`（[strm-scanner.ts:260](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/strm/strm-scanner.ts#L260)） | 复用并**扩展到所有模式**（现在是 `full_sync` 专属） |
| 「证据可用」判据 | `isMergedSourceEvidenceUsable()`（[resource-source-health.ts:143](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/domain/resource-source-health.ts#L143)） | 删除前的**第二道闸**：远端遍历失败/返回可疑时拒绝删除 |
| 扫描记录 | `strm_execution_records.removed_count` + `current_step_message` | 记录「为什么没删」，让 0 可解释 |
| 媒体服务器联动 | `notifyFilesChanged(accountId, paths)` | 删除后同样调用，路径换成被删的 `.strm` |
| 进度阶段 | `StrmScanProgress.phase = "cleaning_orphans"` | 已存在，无需新增 |

结论：**不需要引入任何新依赖**。核心改动是一处条件判断 + 三处防御。

---

## 4. 业界主流做法对比

| 系统 | 如何处理「远端删了、本地还在」 | 对本项目的启示 |
| --- | --- | --- |
| **MoviePilot 云盘 Strm 插件** | 早期版本**同样只在全量模式清理**，用户提了明确 issue：*「发现如果云盘删除文件，本地目的地 Strm 文件还存在，这边目录监控同步至媒体库有影响，烦请新增删除失效 Strm 文件」*（[#2666](https://github.com/jxxghp/MoviePilot/issues/2666)）→ 后续补了「删除失效 strm」 | **这是同类产品的同款缺陷**，说明默认不删是常见起点，但用户一定需要 |
| **cloud-media-sync (CMS)** | 增量同步走 **115 生活事件**（一次接口拿到全部变动），因此天然知道「哪些删了」，可以精确删除；不靠全盘 diff | 事件驱动最优，但需要品牌级 API 能力（见 §5.3） |
| **rsync / rclone sync** | `sync` 默认**双向意图**：目的地比源多的文件会被删除；`--delete` 才开启，且配套 `--max-delete` 上限 | 「同步」语义应含删除；但必须有**删除上限**防止灾难 |
| **Jellyfin / Emby 库扫描** | 扫描会移除「文件已不存在」的条目——但它们**只信文件系统**，不发起删除 | 我们是产生方：`.strm` 不删，媒体服务器就永远不会知道 |
| **Unraid / Syncthing** | Syncthing 用「版本向量 + tombstone」区分「真的删了」与「暂时看不到」 | 「暂时看不到」必须有独立状态，不能混进「已删除」 |

**共同结论**：成熟同步工具都遵循三条原则——
1. **删除是同步的默认组成部分**（但可关闭）；
2. **必须有删除上限 / 空盘保护**（`--max-delete`）；
3. **必须能区分「源真的删了」与「这次没看到」**（tombstone / 事件 / 状态判据）。

本项目目前**三条都缺**：删除不是默认、上限只有「全 0 才拦」、没有「这次到底看没看到目录」的判据。

---

## 5. 具体方案

### 5.1 P0：把清理从 `full_sync` 解绑，改为「增量也清，但有条件」

**核心改动**（[strm-scanner.ts:389](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/strm/strm-scanner.ts#L389)）：

```ts
// 旧：if (task.scanMode === "full_sync") { … cleanOrphanFiles … }
// 新：除全量外，增量模式也清孤儿——这正是用户对「同步」的预期。
//     安全由 checkEmptyProtect（扩展到所有模式）+ 远端遍历完整性判定共同保证。
const shouldCleanOrphans =
  task.scanMode === "full_sync" || (task.scanMode === "incremental_update" || task.scanMode === "incremental_missing");
```

**但不是无条件放开**。新增三段前置判定，任一不满足就**跳过删除并在记录里写明原因**：

```ts
function cleaningRefusal(input: {
  remoteTraversalOk: boolean;   // 远端遍历是否真的走完（见 §5.2）
  validRemoteCount: number;
  localStrmCount: number;
  forceAllowEmptyCleanup: boolean;
}): string | null {
  if (!input.remoteTraversalOk) {
    return "远端目录遍历未完成（请求失败或被中断），本轮跳过孤儿清理——避免把「没看到」当成「已删除」。";
  }
  if (input.validRemoteCount === 0 && input.localStrmCount > 0 && !input.forceAllowEmptyCleanup) {
    return `远端返回 0 个有效媒体，但本地有 ${input.localStrmCount} 个 STRM——空盘保护已拦截清理。确认是真空盘后可强制清理。`;
  }
  // 删除上限：一次删掉的比例超过阈值时要求确认（rclone --max-delete 的同款思路）
  const ratio = input.localStrmCount === 0 ? 0 : (input.localStrmCount - input.validRemoteCount) / input.localStrmCount;
  if (ratio > 0.5) {
    return `本轮预计删除 ${Math.round(ratio * 100)}% 的本地 STRM——超过单次清理上限，已跳过。请确认远端确实大幅删减后再手动执行。`;
  }
  return null;
}
```

### 5.2 关键前提：区分「远端删了」与「这次没看到」

这是本方案**最重要的一条**，否则「放开增量删除」会变成数据丢失事故。

现有 `fetchRemoteFiles` 有三条路径，**失败时都静默返回空数组或部分结果**：

```ts
// strm-scanner.ts:73-100
if (typeof storage.listTree === "function") {
  try { … } catch { /* non-blocking fallback */ }     // ← 吞掉
}
try {
  const files = await storage.listVideoFiles(folderId);
  return files.map(…);
} catch {
  return [];                                           // ← 空数组 = 「远端什么都没有」
}
```

**`return []` 与「这个目录确实是空的」在当前实现里不可区分**。此时若放开删除，一次令牌过期就能清空整个本地库。

改法：让 `fetchRemoteFiles` 返回**带完整性标记**的结果，而不是裸数组。

```ts
type RemoteTraversal =
  | { ok: true; files: VerifiedFile[] }
  | { ok: false; reason: "list_failed" | "partial_failure"; error: string };

private async fetchRemoteFiles(...): Promise<RemoteTraversal>
```

判据（与 `classifySearchSourceFault` 同一条教义——**不猜**）：
- `listDirectory` 路径：任一子目录抛错 ⇒ `ok: false`（部分结果不可作为删除依据）；
- `listTree` / `listVideoFiles` 抛错 ⇒ `ok: false`，**不再回落成空数组**；
- 成功但返回 `[]` ⇒ `ok: true` + 空列表，此时才允许走空盘保护分支。

> 这是把「静默空数组」改成「显式失败」，属于**修正错误的默认值**，不是加防御。

### 5.3 可选增强：事件驱动（115 生活事件）

cloud-media-sync 的做法是走 115 的**生活事件**接口，一次拿到全部增删改。本项目目前**没有**这条路径（`packages/workflow/src/storage` 下无任何 `life_event` / `files/history` 调用）。

评估：
- **收益**：删除判定变成精确事件，不需要全盘 diff；扫描成本从 O(全库) 降到 O(变更量)。
- **成本**：强依赖品牌；且需要维护游标（上次读到的事件 id），跨重启要持久化。
- **结论**：**本轮不做**。§5.1 + §5.2 已经能正确解决当前问题，且对所有品牌一致。事件驱动作为后续优化单独立项（届时它的价值主要在「扫描成本」，而不是「能否清理」）。

### 5.4 P1：删除后通知媒体服务器

当前只有生成时通知（[strm-runner-service.ts:72](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/application/strm-runner-service.ts#L72)）：

```ts
if (scanResult.generatedPaths.length > 0) {
  getMediaServerCoordinator().notifyFilesChanged(accountId, scanResult.generatedPaths);
}
```

改为同时传被删除的路径——否则 Emby/Jellyfin 的条目要等下一次全库扫描才消失（期间点开是 404，正是用户看到的现象）。

实现上：`StrmScanResult` 增加 `removedPaths: string[]`，`cleanOrphanFiles` 收集；runner 里合并两批一起通知。

### 5.5 P2：让「0 个」可解释

扫描记录目前只有 `removed_count: 0`。增加 `current_step_message` 的清理说明：
- 真删了：`清理 12 个孤儿文件`
- 拒绝清理：`跳过孤儿清理：远端目录遍历未完成…`（§5.1 的 refusal reason 原样落库）

这样「为什么没删」不再需要翻源码才能回答。

### 5.6 UI 文案同步

三个模式的选项文案要说出删除语义（当前 `incremental_missing` 写「仅补全新增」，放开后会误导）：

| 模式 | 新文案 |
| --- | --- |
| `incremental_missing` | 增量同步（补全新增，清理已删除，含空盘保护） |
| `incremental_update` | 增量同步 + 覆盖（同时清理已删除） |
| `full_sync` | 全量镜像（强制对齐，含空盘保护） |

---

## 6. 门禁与回归测试

### 6.1 单元测试（`packages/workflow/tests/strm/strm-orphan-cleanup.test.ts`）

| 用例 | 断言 |
| --- | --- |
| `incremental_missing` + 远端少了一个文件 | `removedCount === 1`，磁盘上那个 `.strm` 消失，空目录一并删除 |
| `incremental_update` + 同上 | 同上 |
| `full_sync` + 同上 | 同上（既有行为不回归） |
| **远端遍历失败**（storage 抛错） | `removedCount === 0`，**文件全部保留**，`currentStepMessage` 含「遍历未完成」 |
| **远端返回 0 个文件** 且本地非空 | `removedCount === 0`，空盘保护生效 |
| 远端返回 0 个 + `forceAllowEmptyCleanup: true` | 全部删除（显式强制才放行） |
| 预计删除比例 > 50% | `removedCount === 0`，message 含「超过单次清理上限」 |
| 本地为空 | 不报错，`removedCount === 0` |

**最关键的两条**：遍历失败必须**保留文件**、空盘必须**拦截**。这两条坏掉就是数据丢失。

### 6.2 端到端（可选，`tests/e2e/`）

fake 存储：先跑一次生成 N 个，再删掉远端 1 个，再扫一次 → 本地少 1 个且 `removedPaths` 非空。

### 6.3 门禁 `tools/gates/check-strm-orphan-cleanup.mjs`

现有 `check-strm-generation.mjs` 只断言了「`cleanOrphanFiles` 用了 `removeStrmFile`」，**没有断言它被调用**。新增四项：

1. **清理不得被模式门独占**：`strm-scanner.ts` 里 `cleanOrphanFiles(` 的调用**不能**位于 `scanMode === "full_sync"` 的条件块内（静态检测：调用点前 400 字符内不得出现 `scanMode === "full_sync"` 且无 `incremental` 分支）。
2. **遍历结果必须带完整性标记**：`fetchRemoteFiles` 的返回类型不得是裸数组；`catch { return [] }` 这种「失败即空」的写法禁止出现（正则扫 `catch` 块内 `return []`）。
3. **空盘保护必须覆盖所有模式**：`checkEmptyProtect` 内的模式判据不得只有 `full_sync`。
4. **删除必须通知媒体服务器**：`StrmScanResult` 含 `removedPaths`，且 `strm-runner-service.ts` 的 `notifyFilesChanged` 调用同时消费它。

> 判据是「**有没有可能再次把删除绑在某个模式下**」。只要调用点回到 `full_sync` 之内，门禁就红。

---

## 7. 明确不做

- **不做「远端目录不可达也照删」**：宁可留着孤儿等下一次，也不能删错。这是 Jellyfin/Emby「断连导致库被清空」事故的同一教训（[jellyfin#8097](https://github.com/jellyfin/jellyfin/issues/8097)）。
- **不加 tombstone 表**：`.strm` 本身就是可再生文件（扫描即可重建），不需要为它维护「已删除」状态——那会让恢复多一步。
- **不在本轮做 115 生活事件**：见 §5.3。
- **不改 `full_sync` 的空盘保护默认值**：用户主动选最激进模式时仍要拦一次，这是最后一道闸。

---

## 8. 参考

- 本仓同族教训：`docs/research/2026-11-18-no-coverage-model-error-blame-free-reporting-research.md`（「静默失败被当成事实」的同一形态）、`docs/postmortems/strm-generation-empty-and-false-paused-state.md`
- 同类产品的同款缺陷与修复：
  [MoviePilot #2666 删除失效 strm](https://github.com/jxxghp/MoviePilot/issues/2666)、
  [cloud-media-sync（115 生活事件增量）](https://hub.docker.com/r/imaliang/cloud-media-sync)
- 「删错了」的真实事故：
  [Jellyfin 库被计划扫描删空](https://github.com/jellyfin/jellyfin/issues/8097)、
  [断连导致文件被移除的讨论](https://www.reddit.com/r/JellyfinCommunity/comments/1sryf52/files_deleting_automatically/)、
  [Jellyfin 计划任务文档](https://jellyfin.org/docs/general/server/tasks/)

---

## 9. 实施记录（2026-11-19）

### 9.1 落地清单

| 阶段 | 交付 | 位置 |
| --- | --- | --- |
| 遍历完整性 | `fetchRemoteFiles` 改为返回 `RemoteTraversal`（`ok: true/files` 或 `ok: false/reason/error`）；三条列举路径的 `catch` 不再回落成空数组 | [strm-scanner.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/strm/strm-scanner.ts) |
| 清理解绑 | `cleanOrphanFiles` 从 `if (scanMode === "full_sync")` 内移出，改为**所有模式都执行** | 同上 |
| 空盘保护 | `checkEmptyProtect` 去掉 `full_sync` 判定，覆盖所有模式；触发时整轮跳过（不生成、不删除） | 同上 |
| 大额删除审计 | `largeDeletionNotice()`：单次删除 > 50% 时写一条说明进记录（**不拦截**） | 同上 |
| 删除路径收集 | `StrmScanResult` 新增 `removedPaths` / `traversalError` / `cleanupSkippedReason`；`cleanOrphanFiles` 收集被删路径 | 同上 |
| 媒体服务器联动 | `notifyFilesChanged` 改为消费 `generatedPaths + removedPaths` | [strm-runner-service.ts](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/application/strm-runner-service.ts) |
| 可解释性 | 执行记录的 `currentStepMessage` 优先写 `cleanupSkippedReason`（跳过原因 / 大额删除说明） | 同上 |
| UI 文案 | 三个模式的选项与任务卡标签改为「增量同步 / 增量同步 + 覆盖 / 全量镜像」，明确含删除语义 | [create-strm-task-modal.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/components/create-strm-task-modal.tsx)、[edit-strm-task-modal.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/components/edit-strm-task-modal.tsx)、[strm-task-card.tsx](file:///E:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/components/strm-task-card.tsx) |
| 门禁 | `check-strm-orphan-cleanup.mjs` 五项检查 + 注册 `gate:strm-orphan` | [tools/gates/](file:///E:/WorkProject/Node/_Project/mediary-scout/tools/gates/check-strm-orphan-cleanup.mjs) |

### 9.2 与方案的一处偏离（实施时纠正）

方案 §5.1 原本设想「单次删除比例 > 50% 就跳过」。Dev 实机第一次跑出来立刻暴露问题：

```
skipped: "本轮预计删除 12/21 个 STRM（57%），超过单次清理上限——已跳过"
```

**而「远端真的删了 57%」正是本缺陷要修的场景本身。** 加这条阈值等于：

- 正常的大幅删减永远修不好（每次都跳过）；
- 真正的保护也不在这里——遍历失败与空盘已经各自拦掉了「没看到」与「全空」。

因此实施时把「跳过」降级为**只记说明、照常删除**（`largeDeletionNotice`）。
硬闸保留两道：**遍历失败不删**、**空盘不删（除非显式强制）**。这与 rclone 的
`--max-delete` 也有区别：那个是可配置的运维保护，而本项目在「按源镜像」语义下
不应有不可逾越的隐形上限。

### 9.3 Dev 3020 实机验收

修复前后同一批任务（`incremental_missing`）：

| 任务 | 修复前 本地/远端 | 修复后 一次扫描 | 结果 |
| --- | --- | --- | --- |
| `115_movies` | 21 / 9 | `removedCount: 12` | 本地降到 **9**，与远端一致 |
| `115_tv` | 285 / 160 | `removedCount: 125` | 本地降到 **160**，与远端一致 |
| `115_anime` | 792 / 352 | `removedCount: 444` | 本地降到 **348**（扫描进行中又补了新区块） |

扫描记录里的说明可读：

```
本轮将删除 440/792 个 STRM（56%，属大幅变动）。
若远端只是暂时不可见，请立即用备份或「立即扫描」复核。
```

（`115_tv` 那次 125/285 = 44%，低于阈值，message 保持「扫描同步完成」——
说明只在大幅变动时出现。）

### 9.4 质量门禁

- `lint` / `typecheck` 全绿
- `packages/workflow/tests/strm` **10 文件 / 61 用例**通过（新增 `strm-orphan-cleanup.test.ts` 9 条）
- `gate:strm-orphan`（新增）通过；`gate` 其余项通过，仅 `gate:limits` 因**工作区里另一批
  agent-model 相关未提交改动**（`agent-loop.ts` +112 行等）变红，与本方案无关——本次触碰的
  文件都不在违规清单里。

### 9.5 未做

- **115 生活事件**：仍是「扫描成本优化」而非「能否清理」，单独立项。
- **tombstone 表**：`.strm` 可再生，扫描即可重建，不为它维护删除状态。
- **存量孤儿清理脚本**：本次改动部署后**下一次扫描即自动清理**，不需要单独脚本。
