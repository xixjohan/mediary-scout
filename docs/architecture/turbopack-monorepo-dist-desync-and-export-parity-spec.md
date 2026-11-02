# Turbopack Monorepo 跨包导出脱节与运行时 `is not a function` 根因调研与治理规范

## 1. 报错现象与现场还原

用户在发起批量替换 STRM 播放基址请求时：
```bash
curl --url 'http://127.0.0.1:3001/api/strm/replace-base-url' \
  -H 'Content-Type: application/json' \
  -b 'mt_session=...; mt_page_guarded=1' \
  --data-raw '{"newBaseUrl":"http://127.0.0.1:3001"}'
```
接口返回 HTTP 500 并在 JSON 中抛出典型运行时未定义函数错误：
```json
{
  "ok": false,
  "error": "(0 , __TURBOPACK__imported__module__$5b$project$5d2f$packages$2f$workflow$2f$dist$2f$strm$2f$base$2d$url$2d$replacer$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__.replaceBaseUrlInDirectories) is not a function"
}
```

---

## 2. 深入调研：问题根因排查与链路剖析

经系统排查进程树、编译构建流水线与 Turbopack 模块图谱，该报错的根本原因是**“双层间接编译脱节”与“长运行 Next.js 进程内存模块缓存滞后”**引发的冲突：

```mermaid
flowchart TD
    SUBGRAPH_DEV["开发与运行环境"]
        DEV_SERVER["dev-server 进程 (02:37 启动)"]
        TURBO_CACHE["Turbopack 内存模块图谱<br/>(缓存了 02:37 的 dist/base-url-replacer.js)"]
    end

    SUBGRAPH_SRC["源码与构建变更"]
        SRC_CODE["packages/workflow/src/strm/base-url-replacer.ts<br/>(新增 replaceBaseUrlInDirectories)"]
        WEB_ROUTE["apps/web/app/api/strm/replace-base-url/route.ts<br/>(import { replaceBaseUrlInDirectories })"]
        DIST_CODE["packages/workflow/dist/...<br/>(未及时自动热编译或内存未刷新)"]
    end

    DEV_SERVER --> TURBO_CACHE
    SRC_CODE -->|"修改源码"| WEB_ROUTE
    WEB_ROUTE -->|"通过 workspace 依赖导入"| TURBO_CACHE
    TURBO_CACHE -- "❌ 内存中持有的旧模块导出了 undefined" --> CALL["调用 replaceBaseUrlInDirectories(...)"]
    CALL -- "❌ TypeError: ... is not a function" --> CLIENT["HTTP 500 报错"]
```

### 2.1 根因一：长运行 Node.js 进程持有的 Turbopack 模块缓存
- 现场排查显示，侦听在 3001 端口的 `node.exe` 进程启动于 **2026年11月2日 02:37:15**；
- 此时 `packages/workflow/src/strm/base-url-replacer.ts` 中尚未实现 `replaceBaseUrlInDirectories`；
- 后续在源码中新增了该函数并在 `apps/web/app/api/strm/replace-base-url/route.ts` 中引入，虽然 Next.js 触发了 `apps/web` 单路由的热编译，但对于来自外部包 `dist/strm/base-url-replacer.js` 的模块，Turbopack 仍然沿用了进程初次启动时载入内存的旧模块对象；
- 在该旧对象中，`replaceBaseUrlInDirectories` 为 `undefined`，当被作为函数调用时即报 `(0, ...replaceBaseUrlInDirectories) is not a function`。

### 2.2 根因二：Monorepo 构建分层与直接消费源码缺失 (Double-Hop Indirection)
- 在 `apps/web/package.json` 中配置了 `"@media-track/workflow": "*"`，在 `apps/web/next.config.ts` 中配置了 `transpilePackages: ["@media-track/workflow"]`；
- 但 `packages/workflow/package.json` 的 `main` 与 `exports` 均指向 `./dist/index.js`，且 `apps/web/tsconfig.json` 未配置 `paths` 源码别名；
- **后果**：Next.js 在开发模式下不是直接读取 TypeScript 源码，而是强制经由 `dist/` 编译产物进行中转。每当底层 `workflow` 包增加导出或修改实现时，开发者若未手动执行 `npm run build:workflow` 并重启服务，Next.js 就会读取到陈旧的 `dist` 产物，甚至因 Turbopack 内存缓存导致不一致。

---

## 3. 开源生态与业界主流方案调研对比

| 方案 | 原理与机制 | 优劣势评估 | 选型结论 |
| :--- | :--- | :--- | :--- |
| **方案 A：纯手工构建 (`npm run build:workflow`) + 手工重启** | 每次修改后由开发者记忆执行编译并重启 `dev-server` | 极度依赖人工记忆，极易遗忘；长运行服务器必定再次出现 `is not a function` | ❌ 坚决抛弃（反模式） |
| **方案 B：后台文件监听器 (`tsc --watch`)** | 在开发环境并行运行一个 watch 进程实时输出到 `dist` | 占用额外系统进程与文件句柄；`dist` 写入与 Next.js 读取存在竞争窗口，且 Next.js 需侦测 `dist` 变更再次编译，存在双重延迟 | 🟡 资源消耗高，易竞争 |
| **方案 C：TSConfig 源码直通映射 (`paths` 指向 `src`)** | 在 `apps/web/tsconfig.json` 中配置 `paths` 指向 `packages/workflow/src/index.ts` | **陷阱与局限**：`workflow` 包采用 TypeScript `NodeNext` ESM 规范，源码内 relative import 必须带 `.js` 后缀（如 `./auth/session.js`）。Next.js Turbopack 跨 Monorepo 包解析时无法自动将 `.js` specifier 映射回 `.ts`，导致 `verifySession not found` 编译中断！ | ⚠️ 本项目中不可行（因 NodeNext 规范限制） |
| **方案 D：产物时序门禁 + Dev-Server 启动预检 + 端口精确查杀 (终极方案)** | 1. `tools/runner/dev-server.mjs` 启动前自动比对 `src` 与 `dist` 的 mtime，过时自动触发 `npm run build:workflow`；<br/>2. 强化 Windows 双栈 IPv6 端口查杀，彻底杜绝孤儿进程持有旧内存模块；<br/>3. CI/门禁 (`check-api-contracts.mjs`) 动态求值校验所有导出符号，未编译或未导出即刻阻断。 | 1. **全自动化零心智负担**：开发者无需记住手动 build，启动 dev-server 时自愈编译；<br/>2. **规避 Turbopack 解析陷阱**：完全兼容 NodeNext ESM 规范；<br/>3. **真机孤儿进程根除**：精确查杀双栈端口占用，确保内存无过期旧模块；<br/>4. **CI 质量左移**：强力门禁拦截任何脱节提交。 | **✅ 最终采纳的最佳工程化架构** |

---

## 4. 系统既有基础设施复用与对齐

1. **`tools/runner/dev-server.mjs`**：
   - 现具备 `BuildCacheChecker` 增量感知与进程管理回收机制，复用并强化其端口查杀（修复 Windows 双栈 IPv6 侦听检测漏报问题）与健康检查。
2. **`tools/gates/check-api-contracts.mjs`**：
   - 现有契约检测管线，在其内部扩展 `checkMonorepoWorkspaceExports`，在 Node ESM 环境下动态执行 `await import(pathToFileURL(distIndexPath))` 实时比对导出符号。
3. **`packages/workflow/` 构建管线**：
   - 复用现有的 `npm run build:workflow`（`tsc -p tsconfig.json`），保持与生产构建产物标准完全一致。

---

## 5. 具体解决方案与落地实施

### 5.1 实施一：修复 `tools/runner/dev-server.mjs` 端口查杀漏洞
在 Windows 平台上，Next.js 经常双栈绑定 `[::]:3001` 与 `127.0.0.1:3001`。原 `isPortInUse` 仅通过 IPv4 监听试探，导致无法探测到已在 `[::]:3001` 侦听的孤儿 `node.exe` 进程。
**修复方案**：
```javascript
// tools/runner/dev-server.mjs
async isPortInUse(port) {
  if (process.platform === "win32") {
    const pids = this.findPidsOnPort(port);
    if (pids.length > 0) return true;
  }
  // fallback probe
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => resolve(err.code === "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}
```
结合 `--stop` 参数可一键查杀所有持有旧内存模块的 Node 孤儿进程。

### 5.2 实施二：构建产物全量对齐
执行 `npm run build:workflow`，将 `packages/workflow/src/strm/base-url-replacer.ts` 中新增的 `replaceBaseUrlInDirectories` 彻底编译至 `packages/workflow/dist/`，并在 `dist/index.js` 统一导出。

### 5.3 实施三：清理并重启开发服务
调用 `tools/runner/dev-server.mjs --stop` 彻底终止旧有滞后进程，并重启服务；重新执行 curl 测试验证，接口立即返回 `200 OK` 并成功处理全部目录。

---

## 6. 自动化门禁防护与回归测试

为从机制上防止同类跨包导出遗漏或源码与产物不同步，在 `tools/gates/check-api-contracts.mjs` 中增设两道防线：

1. **源码产物时序门禁 (`Workflow Freshness Gate`)**：
   - 遍历 `packages/workflow/src/` 获取最新的源码修改时间戳 `workflowSrcMtime`；
   - 对比 `packages/workflow/dist/index.js` 的 `distMtime`；
   - 若源码更新于产物，门禁直接报错中断，提示执行 `npm run build:workflow`。
2. **跨包导出运行时求值对齐门禁 (`Dynamic Export Evaluation Gate`)**：
   - 静态提取 `apps/web` 路由中从 `@media-track/workflow` 解构导入的所有标识符；
   - 通过 Node.js 动态 ESM 导入 `const distModule = await import(pathToFileURL(distIndexPath))`；
   - 断言每个被引用的标识符在 `distModule` 中都不为 `undefined`；若有符号未导出或为 undefined，门禁即刻红牌拦截！
