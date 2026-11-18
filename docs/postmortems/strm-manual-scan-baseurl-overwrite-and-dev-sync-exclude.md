# STRM 全量失效复盘：手动扫描改写播放基址 + Dev 直推剔除 run 路由

- 日期：2026-11-17
- 环境：Dev 实例 `mediary-dev`（3020），生产 `mediary`（3000）未受影响
- 现象：站长「关键字投放」落盘成功后，STRM 侧 `.strm` 文件在播放器里播不了；点「立即扫描」也「修不好」

---

## 1. 现象与证据链

| 观测 | 实测值 |
| :--- | :--- |
| owner-ingest 投放结果 | `POST /api/owner/ingest/submit` 200；`status` 轮询 `succeeded / landedFileCount: 8` |
| 投放后新生成的 `.strm` | `http://localhost:3000/api/strm/play/...` |
| 容器 env `APP_BASE_URL` | `http://192.168.1.100:3020` |
| `GET /api/strm/replace-base-url` | `configuredUrl: null`, `effectiveUrl: http://192.168.1.100:3020` |
| 点击「立即扫描」（movies 任务） | 200，`updatedCount: 22`，**文件被改写成 localhost** |
| 容器内实际路由源文件 | `apps/web/app/api/strm/tasks/[id]/run/route.ts` 仍是 11-13 的旧版本 |

---

## 2. 根因一：手动扫描把容器回环 origin 当作显式基址

`apps/web/app/api/strm/tasks/[id]/run/route.ts` 旧代码：

```ts
const origin = request.nextUrl.origin || "http://localhost:3000";
executeStrmTaskScan(id, accountId, { triggerSource: "manual", baseUrl: origin });
```

`resolveEffectiveStrmBaseUrl` 的优先级是 **显式参数 > DB `strm_base_url` > `APP_BASE_URL`/`MEDIARY_URL` > 回环兜底**。
容器里 `nextUrl.origin` 永远是 `http://localhost:3000`，于是它作为「显式参数」**压过**了正确的 DB/env 值。
而 `incremental_missing` 模式本轮新增的「内容自愈」判定一旦发现 base 不同（`different_content`）就会重写——
一次点击把全库 `.strm` 逐个改成 localhost。外部播放器（Emby/Infuse/电视）解析 localhost 必然失败。

**修复**：路由不再传 `baseUrl`，基址只认 SSOT。

```ts
const result = await executeStrmTaskScan(id, accountId, { triggerSource: "manual" });
```

---

## 3. 根因二：Dev 直推的 tar 排除规则剔掉了 `[id]/run` 路由

`scripts/deploy-remote.ps1` Direct 同步使用：

```powershell
& tar.exe -czf $localBundle --exclude=run --exclude=data --exclude=env ...
```

bsdtar 的 `--exclude=run` **匹配任意层级**的同名目录，于是
`apps/web/app/api/strm/tasks/[id]/run/` 整条目录没有进 bundle。
远端容器里的该路由停留在 11-13 版本——**本地改完代码、部署显示成功、行为却完全没变**，
排查时极易误判为「代码没生效 / 镜像缓存」。

实测验证：

```bash
tar.exe -tzf bundle.tar.gz | grep "strm/tasks/\[id\]/run/"   # 旧参数：空
tar.exe -tzf bundle.tar.gz | grep "strm/tasks/\[id\]/run/"   # 锚定后：hit
```

**修复**：本地状态目录的排除锚定到仓库根（`/run`、`/data`、`/env`）；
`node_modules`、`.next` 保持任意层级排除（`apps/web` 下也有）。

---

## 4. 修复后的验收（Dev 3020）

| 项 | 结果 |
| :--- | :--- |
| `node tools/gates/check-strm-playback.mjs` | 通过（新增 2 项检查） |
| 手动扫描 movies 任务 | 200，`updatedCount: 22`，写入后首行为 `http://192.168.1.100:3020/...` |
| 手动扫描 tv 任务 | 178 个文件全部改写为 `192.168.1.100:3020` |
| 全库陈旧基址统计 | `localhost` 0 / `127.0.0.1` 0 / 正确基址 1138 / 总数 1138 |
| 真实 token 播放（Range 请求） | `206 Partial Content`，`size=524288`，`content-type: video/x-matroska` |
| 伪造 token 播放 | `401 {"error":"STRM 播放签名鉴权失败: 签名无效"}` |
| owner-ingest 落盘 | `succeeded / 8 个文件`，随后 STRM 扫描新增 9 个可用 `.strm` |

> 遗留：`kk_anime/` 下的 41 个 `.strm` 属于已验证删除的任务 id（`strm_task_1794119929625_g2hd2m`），
> 没有任何活动的 STRM 任务会再扫描该目录。已用「快速修改播放基址」批量改为正确前缀；
> 该目录属于孤儿输出，如需清理应在删除任务时勾选 purge。

---

## 5. 同类门禁（已加入 `tools/gates/check-strm-playback.mjs`）

1. **`checkManualScanBaseUrlSso`**：手动扫描路由禁止出现 `nextUrl.origin` 或 `baseUrl: origin`——
   基址只能来自 `resolveEffectiveStrmBaseUrl` 的 SSOT 链。
2. **`checkDevSyncExcludes`**：`deploy-remote.ps1` 中 `/run`、`/data`、`/env` 必须锚定；
   `node_modules`、`.next` 必须保留任意层级排除。任何一侧改动都会让门禁变红。

这两条门禁的共同模式：**「优先级最高的入口」和「部署产物完整性」都是沉默失效点**——
它们不会报错，只会让结果悄悄变成错的。
