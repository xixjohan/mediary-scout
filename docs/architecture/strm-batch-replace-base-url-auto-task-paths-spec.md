# STRM 极速批量修改播放基址自动汇聚全任务路径架构规范

> **规范状态**：已落地并验证通过  
> **涉及模块**：`@media-track/workflow`（`base-url-replacer.ts`），`apps/web`（`api/strm/replace-base-url/route.ts`, `strm-schedule-view.tsx`）  
> **验证用例**：`packages/workflow/src/strm/base-url-replacer.test.ts`, `apps/web/app/api/strm/strm-api.test.ts` (100% Passed)  
> **防回归门禁**：`tools/gates/check-strm-generation.mjs`（`npm run gate:strm` 纳入 CI）  

---

## 1. 业务背景与改造诉求

### 1.1 原始设计痛点
在上一版“极速批量修改播放基址”功能中：
1. **人工录入繁琐**：模态框强制要求用户手动输入“本地 STRM 根目录”（且默认初始值为硬编码的 `/data/strm/movies`）；
2. **多任务割裂维护**：当用户同时拥有多个 STRM 任务（例如动漫存放在 `E:\LinuxWork\Test`、电影存放在 `D:\Media\Movies`）时，每次更换播放基址（如 NAS 局域网 IP 变更 `192.168.1.100` $\rightarrow$ `192.168.1.200`，或换用公网域名/FRP 穿透），用户必须逐个路径手动复制粘贴分批替换，体验断层；
3. **高误操作率**：手动输入物理盘符或路径极易由于斜杠方向、拼写遗漏导致扫描 0 个文件或报错。

### 1.2 用户核心诉求
> **能否去除「本地 STRM 根目录」手动选择/输入，自动支持使用全部任务中的输出路径？**

---

## 2. 业界主流方案对比与架构选型

| 方案 | 路径获取机制 | 多目录支持 | 用户交互成本 | 评价与采纳 |
| :--- | :--- | :--- | :--- | :--- |
| **MoviePilot / Nastool** | 读取全局媒体库配置，修改外网基址时自动遍历全部库目录 | 自动多目录并发/串行重写 | 0 路径输入，仅需确认新域名/IP | **高度借鉴**：任务表已有 `localOutputDir`，应作为权威数据源直接复用 |
| **AList** | 驱动层集中中继转发，通过修改挂载点域名透明转发 | 集中式虚拟挂载点 | 仅修改挂载驱动 URL | 与本地磁盘 `.strm` 文件重写原理不同，但理念一致 |
| **Mediary Scout (改造前)** | 强制用户单目录输入，硬编码默认值 | ❌ 仅支持单一目录 | 高（每次需手动复制粘贴路径） | 存在严重交互割裂与操作负担 |
| **Mediary Scout (改造后)** | ✔ 自动汇聚当前账户下全部已配置 STRM 任务的本地输出路径并自动去重 | ✔ 聚合引擎自动跨多目录毫秒级流式重写并汇总统计 | 0 路径输入（默认自动关联，仅需确认新基址，亦保留可选高级自定义） | 体验与效率最佳 |

---

## 3. 详细架构设计与实施细节

### 3.1 核心引擎层：多目录聚合秒级重写引擎
在 [base-url-replacer.ts](file:///e:/WorkProject/Node/_Project/mediary-scout/packages/workflow/src/strm/base-url-replacer.ts) 中新增 `replaceBaseUrlInDirectories`：
```typescript
export async function replaceBaseUrlInDirectories(
  directories: string[],
  newBaseUrl: string,
): Promise<ReplaceBaseUrlResult & { directories: string[] }> {
  const normalizedBase = normalizeBaseUrl(newBaseUrl);
  // 1. 自动去重并剔除空目录
  const uniqueDirs = Array.from(
    new Set(directories.map((d) => d.trim()).filter(Boolean)),
  );

  const aggregateResult: ReplaceBaseUrlResult & { directories: string[] } = {
    total: 0,
    updated: 0,
    errors: [],
    directories: uniqueDirs,
  };

  // 2. 逐一遍历各有效目录，聚合统计指标
  for (const dir of uniqueDirs) {
    if (!fs.existsSync(dir)) continue;
    const res = await replaceBaseUrlInFiles(dir, normalizedBase);
    aggregateResult.total += res.total;
    aggregateResult.updated += res.updated;
    aggregateResult.errors.push(...res.errors);
  }

  return aggregateResult;
}
```

### 3.2 服务接口层：智能自动解析账户任务路径
在 [route.ts](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/app/api/strm/replace-base-url/route.ts) 中：
1. 请求体验证仅要求 `newBaseUrl` 为必填项；
2. 当调用方未传递 `directoryPath` 或 `directoryPaths` 时：
   - 自动调用 `repo.listStrmTasks(accountId)` 获取当前账户下全部任务；
   - 提取所有非空的 `task.localOutputDir` 并去重；
3. 执行 `replaceBaseUrlInDirectories` 并返回详细汇总与扫描的目录列表：
   `{ ok: true, total, updated, errors, directories }`。

### 3.3 前端交互层：零路径输入与可视化目录呈现
在 [strm-schedule-view.tsx](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/features/strm/components/strm-schedule-view.tsx) 的 `StrmReplaceBaseUrlModal` 中：
1. **自动提取任务目录**：直接接收已加载的 `tasks`，自动计算去重后的 `taskDirs`；
2. **默认智能回填**：新播放基址默认回填 `window.location.origin`（当前访问地址），大部分场景下一键即可直接提交；
3. **移除强制输入框**：用优雅的可视化卡片展示当前已自动关联的任务目录药丸（如 `📁 E:\LinuxWork\Test`）；
4. **保留可选高级能力**：保留右上角“自定义特定目录”轻量折叠切换按钮，兼顾极少数特殊外链目录的临时修改需求。

---

## 4. 验证与门禁标准

### 4.1 自动化测试覆盖
1. `packages/workflow/src/strm/base-url-replacer.test.ts`：验证跨多目录批量替换与目录去重聚合；
2. `apps/web/app/api/strm/strm-api.test.ts`：验证在不传递 `directoryPath` 时，API 自动查找当前账户名下全部任务输出目录并正确替换全部文件。

### 4.2 质量门禁规则
在 `tools/gates/check-strm-generation.mjs` 中固化以下门禁规则：
- `replace-base-url` 路由必须支持无 `directoryPath` 时自动使用 `listStrmTasks` 提取任务路径；
- `base-url-replacer.ts` 必须导出 `replaceBaseUrlInDirectories`；
- 前端模态框不得将 `directoryPath` 作为单一必填项。
