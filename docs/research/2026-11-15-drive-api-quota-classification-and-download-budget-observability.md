# 网盘 API 分类计量、云下载配额查询与字幕上传改造：可行性调研与方案（v3）

日期：2026-11-15（Asia/Hong_Kong）。本地基线：`1f325444`（mediary 分支）。
修订记录：v2 收敛分类与展示口径；v3 按用户反馈「字幕改为上传，上传不消耗额度」重写，并依据 115 开放平台官方文档修正两个关键前提。

> 本文是新增研究稿，不授权实施、生产变更或新增上传／下载行为，不覆盖用户正在修改的业务文件及其他研究文档。

## 1. 需求与本次修订

用户三点反馈（v2）与新增反馈（v3）：

1. **字幕改为上传，上传不消耗额度**（v3 新增，本次核心）
2. 离线任务管理有月限额，与直链下载共享（v2）
3. 不用显示月限额，显示任务中调用次数即可（v2）

### 1.1 本次修订改变了两个此前的关键前提

调研中取得了 115 开放平台官方 API 文档（语雀镜像，经 GitHub 第三方仓库 `ddc-111/115quick` 全文核对），据此修正：

| 此前提（v1/v2） | 事实（v3） |
| --- | --- |
| 「115 无上传 API，字幕改上传不可行」 | **错误**。开放平台有完整上传链路：`/open/upload/get_token` + `/open/upload/init` + `/open/upload/resume` + 对象存储。我们代码只是没实现 |
| 「平台侧额度未知，只能做本地近似计数」 | **部分错误**。云下载配额可查：`/open/offline/get_quota_info` 返回 `count`/`used`/`surplus`（总配额／已用／剩余） |

这两个修正直接决定了方案形态：**字幕上传从「不可行」变为「可行但工作量不小」**，而**配额从「只能猜」变为「可精确查询」**。

## 2. 115 开放平台 API 事实基线（官方文档）

### 2.1 上传链路（字幕改造的依据）

官方上传流程（文档原文归纳）：

1. `POST /open/upload/init` — 初始化上传。返回 `status`：**2 = 秒传成功，上传结束**；1 = 需实际上传
2. 需要二次认证时按 `sign_key`/`sign_check`/`sign_val` 流程处理
3. 非秒传时，用 init 返回的 `callback` + `GET /open/upload/get_token` 返回的上传凭证，调**对象存储**上传文件
4. `POST /open/upload/resume` — 断点续传
5. 对象存储返回成功即上传完成

`init` 关键参数：

| 参数 | 必须 | 说明 |
| --- | --- | --- |
| `file_name` | 是 | 文件名 |
| `file_size` | 是 | 文件大小（字节） |
| `target` | 是 | 上传目标，格式 `U_1_0`，`0` 为根目录，其他数字为文件夹 ID |
| `fileid` | 是 | **文件 SHA1 值**（秒传判定依据） |
| `preid` | 否 | 文件前 128K 的 SHA1 |
| `pick_code` | 否 | 上传任务 key（续传用） |

`get_token` 返回：`endpoint`（上传域名）、`AccessKeyId`、`AccessKeySecrett`、`SecurityToken`、`Expiration`。

**对字幕场景的关键意义**：字幕是几十 KB 的文本文件，`init` 时若平台上已存在同 SHA1 文件，直接**秒传成功**（status=2），一次调用即完成，无需走对象存储。这是最小代价路径。

### 2.2 云下载配额（可精确查询）

`GET /open/offline/get_quota_info` 返回：

| 字段 | 含义 |
| --- | --- |
| `package[]` | 配额类型分组 |
| `package[].name` | 配额名称 |
| `package[].count` / `used` / `surplus` | 该类型总配额／已用／剩余 |
| `package[].expire_info[]` | 明细项过期信息（`surplus`、`expire_time`） |
| `count` / `surplus` / `used` | 用户总配额／总剩余／总已用 |

官方能力描述原文：「云下载服务：获取云下载任务列表、**配额信息**，下载任务添加、删除等」。

### 2.3 平台侧额限的官方措辞

官方对超额场景的措辞（文档原文）：「用户云下载配额不足时，引导用户升级至更高的 VIP 类型或单独购买云下载配额」——**配额不足是平台级业务状态，不是技术错误**。这影响我们的错误分类设计（见 §6.2）。

### 2.4 一个必须记录的风险

115 开放平台在 2026-08 曾**单方面暂停服务**（官方公告「恢复时间及后续安排，需以后续官方公告为准」）。因此：

> 任何依赖开放平台的能力都必须有降级路径，且不得把平台能力当作恒定可用。字幕上传若作为唯一路径，必须在平台不可用时回退到离线任务（现有行为）。

## 3. 字幕改上传：方案设计

### 3.1 当前链路 vs 目标链路

```
当前（消耗云下载配额）：
  assrt search → detail(filelist 直链)
    → sandbox.transferSubtitleUrls
      → 115 离线任务 add_task_url（服务端从 assrt 拉取）
        → listTree 轮询落地（每次 poll 一次 listItems）
          → rename 匹配视频名

目标（不消耗配额）：
  assrt search → detail(filelist 直链)
    → 新增：本地 HTTP GET 下载字幕内容（assrt 直链，不消耗 115 额度）
      → 115 上传：upload/init（带 SHA1）
        → status=2 秒传完成（多数情形，一次调用）
        → status=1 才需 get_token + 对象存储 PUT
          → listTree 确认落地（与现状相同的轮询）
            → rename 匹配视频名（不变）
```

### 3.2 为什么这个改造的收益是实的

| 维度 | 离线任务（现状） | 上传（目标） |
| --- | --- | --- |
| 云下载配额 | **消耗**（每次字幕包一次任务） | **不消耗**（用户确认） |
| API 调用次数 | N 次提交 + p 轮询 + 取消 | N 次 init（秒传时仅此一次）+ 少量确认 |
| 落地延迟 | 20–60s（服务端队列，代码注释实测） | 秒传时近即时；需上传时取决于本地上传带宽 |
| 依赖的平台能力 | 云下载服务 | 文件上传服务 |
| 新增本地依赖 | 无 | **本机需能访问 assrt 直链** |

**延迟收益可能比配额收益更明显**：现状字幕落地要等 20–60s 且占用轮询；秒传路径可大幅缩短。

### 3.3 关键风险与设计约束

**风险 1：本机需能访问 assrt 直链。** 这是新增的本地网络依赖。当前架构里 115 服务端拉取，本机不接触字幕内容；改上传后，本机（Web 容器）必须能出网访问 `api.assrt.net` 的文件域名。若部署环境出网受限（只放了 115/TMDB 白名单），上传路径会失败。

**设计约束**：必须做**双路径 + 自动降级**。上传失败（网络不通／平台不可用／配额类错误）时回退到现有离线任务路径，保证字幕软目标的行为不回退。这同时满足 §2.4 的平台风险要求。

**风险 2：SHA1 计算。** `init` 的 `fileid` 是文件 SHA1，`preid` 是前 128K SHA1。需在本地对下载内容算哈希。字幕文件小，计算成本可忽略；但要引入哈希实现（Node 内置 `crypto` 即可，无需新依赖）。

**风险 3：上传凭证与对象存储的复杂度。** `get_token` 返回的是 STS 临时凭证（`AccessKeyId`/`AccessKeySecrett`/`SecurityToken`/`Expiration`），随后要按对象存储协议 PUT。**这部分官方文档指向「详见对象存储 API 文档」，我们未取得该文档**，因此对象存储 PUT 的确切协议（header 签名方式、分片规则）是**未验证的未知**。

**设计约束**：**优先走秒传路径，把对象存储 PUT 作为可选优化**。字幕文件小，且同一字幕包在重试／多集场景下 SHA1 可能已存在（秒传命中率不低）。即使秒传失败时只能回退离线任务，也已省下大部分配额。这样可在**不实现对象存储 PUT 的前提下**拿到主要收益，把未验证部分隔离在外。

**风险 4：上传是否真的不消耗额度。** 用户明确「上传不消耗额度」，但官方文档未见「上传不计入云下载配额」的明文。合理推断（上传走的是文件管理能力，非云下载服务），但**未经平台确认**。

**设计约束**：实现时先用 `get_quota_info` 实测验证——上传前后各查一次配额，确认 surplus 不变。这是低成本的一次性验证，且 `get_quota_info` 本来就要实现（§5）。

### 3.4 建议的实现范围（P2，需授权）

分两步，第一步即可拿到主要收益：

**步骤 A（推荐先做）：秒传优先 + 降级**
1. `Pan115OpenClient` 增加 `getUploadToken()` 与 `initUpload(input)` 两个方法（按 §2.1 规格）
2. `Storage115Executor` 增加 `uploadSubtitle(input)`：本地下载 → 算 SHA1 → `initUpload` → `status=2` 即成功；否则返回「需对象存储」信号
3. sandbox 的字幕工具改为：先试 `uploadSubtitle`，秒传失败或抛错则回退现有 `transferSubtitleUrls`
4. 单元测试用 fake API 覆盖：秒传成功、需上传（回退）、上传接口报错（回退）、assrt 下载失败（回退）

**步骤 B（可选，依赖未取得的对象存储文档）：实现对象存储 PUT**
- 需先取得对象存储 API 文档并实测，再评估

## 4. 分类计量：保留但简化

v2 的分类设计（`download`/`free` 两类 + 按 url 协议分流 + 旁路 Meter）**继续有效且必要**，因为配额消耗的观测需求不因字幕改上传而消失——磁力转存、直链播放仍在消耗。

字幕改上传后，分类映射的变化：

| 操作 | v2 类别 | v3 类别 | 原因 |
| --- | --- | --- | --- |
| `addOfflineTask` + `magnet:`/`ed2k:` | `free` | `free` | 秒传，不变 |
| `addOfflineTask` + `http(s):` 字幕 | `download` | `download` | 降级路径仍存在，仍可能消耗 |
| 上传 `initUpload`（秒传命中） | — | `free` | 不消耗配额 |
| 上传 `initUpload`（需对象存储） | — | `download` | 需实测确认；保守归 `download` |
| `getDownloadUrl` | `download` | `download` | 直链解析，不变 |
| `listOfflineTasks`/`removeOfflineTask` | `download` | `download` | 用户反馈 2，不变 |

「需对象存储的上传归 `download`」是**保守默认**：在未实测确认其是否计额前，按消耗计。这符合「宁可多报不可漏报」的观测原则。

## 5. 配额查询：新增能力，且它改变了展示口径

既然 `get_quota_info` 可精确查询，就应实现。但它与用户反馈 3「不用显示月限额」需要协调：

- **用户说不显示月限额** → UI 不展示 `count`/`used`/`surplus` 数字
- **但配额查询仍有高价值**，用于**内部决策而非展示**：
  - **配额不足时的错误分类**：离线任务提交若因配额不足被拒，应识别为「配额不足」而非「转存失败」，给 agent 和用户准确的原因（呼应 §2.3 官方措辞）
  - **字幕路径决策**：配额充裕时用离线任务（现路径，无需本机出网），配额紧张时优先上传路径——这正好与 §3.4 的降级逻辑互补
  - **告警**：本地可选配阈值，超了发通知（用户未要求，列为可选）

**结论**：实现 `getQuotaInfo()`，但**仅用于内部决策与错误分类，不进 UI 计数展示**。UI 仍按用户要求只显示本次任务内的调用次数。这同时满足反馈 3 与「准确命名错误」的既有原则。

## 6. 可行性评估

### 6.1 分项结论

| 项 | 可行性 | 工作量 | 依赖 |
| --- | --- | --- | --- |
| 分类计量 + UI 双 badge（v2 方案） | **高** | 小 | 无新增 |
| `getQuotaInfo()` + 配额不足错误分类 | **高** | 小 | Open API 已有 token |
| 字幕上传·秒传路径（步骤 A） | **高** | 中 | 本机可访问 assrt 直链；需 SHA1 |
| 字幕上传·对象存储 PUT（步骤 B） | **未验证** | 大 | 对象存储 API 文档未取得 |
| 直链缓存扩展至电影库播放 | 高 | 小 | 无 |

### 6.2 逻辑风险

| 风险 | 缓解 |
| --- | --- |
| 本机无法访问 assrt 直链 | 双路径自动降级到离线任务；失败原因如实上报 |
| 上传实际也计配额（用户口径未经平台确认） | 实现后用 `get_quota_info` 前后对比实测；未确认前「需对象存储的上传」保守归 `download` |
| 对象存储协议未知 | 步骤 A 不依赖它；秒传失败即降级，不阻塞 |
| 平台暂停服务（2026-08 先例） | 上传路径失败即降级到现有路径，字幕软目标行为不变 |
| 秒传命中率低导致收益有限 | 用 `get_quota_info` 与调用计数实测后评估是否值得投入步骤 B |
| 本地下载字幕占用 worker 时间 | 字幕文件小（几十 KB），可接受；加大小上限保护（如 >5MB 走降级） |

### 6.3 一个应当说明的边界

「上传不消耗额度」目前**只有用户口径**，无官方明文。因此本方案的所有收益测算都带这一假设。建议在实施步骤 A 时，把「上传前后 `get_quota_info` 对比」作为**验收项之一**——若假设不成立，收益模型需要重算，但双路径设计保证功能本身不回退。

## 7. 分阶段实施建议

需用户授权后才实施。各阶段独立可交付。

### P0：分类计量与独立显示（纯观测，零行为变更）

即 v2 方案：`DriveApiQuotaClass` 两类 + 115 分类函数（含 url 协议分流）+ 旁路 `DriveApiMeter` + guard 与 stream-resolver 上报 + `AgentStep`/`AgentStepView` 加 `downloadApiCalls` + UI 双 badge。零新表、零 schema 迁移。

**验收**：UI 同时显示「网盘 API 累计 N 次」与「下载类 M 次」，`M ≤ N`；纯磁力秒传运行 `M = 0`；`apiCalls` 与改动前一致；`npm run gate` 通过。

### P1：配额查询与错误分类

`Pan115OpenClient.getQuotaInfo()` + 配额不足的专门错误类型 + agent/用户可见的准确原因。**不进 UI 展示**（对齐反馈 3）。

**验收**：配额不足时错误信息为配额类而非转存失败类；`get_quota_info` 失败不影响主流程（查询失败仅放弃内部决策）。

### P2：字幕上传（秒传路径 + 降级）

步骤 A 全部内容 + 双路径自动降级 + 测试矩阵。

**验收**：
- 秒传命中的字幕包：不走离线任务，`get_quota_info` 前后 surplus 不变（**验证上传不计额假设**）
- 上传失败（网络／平台／协议）：自动回退离线任务，字幕仍能落地
- 磁力转存不受影响
- 字幕落地后 rename 流程与现状一致

### P3（可选，依赖外部文档）

对象存储 PUT、直链缓存扩展至电影库播放、下载类软阈值告警。

## 8. 测试矩阵

### P0 分类计量

| 场景 | 必须验证 |
| --- | --- |
| 磁力/ed2k 秒传转存 | 计 `free`，`download` 为 0 |
| http(s)/ftp 字幕离线任务 | 计 `download`（同一 `addOfflineTask` 按 url 协议分流） |
| `listOfflineTasks`/`removeOfflineTask` | 计 `download` |
| 直链解析（Open 与 Cookie 两条路径） | 都计 `download`，不经 guard 也不被 guard 硬限拦截 |
| 目录列举/移动/删除/改名/建目录 | 计 `free` |
| `receiveShare` | 计 `free` |
| meter 抛错或不可用 | 不影响调用结果 |
| fakes/sim 执行器 | 无 meter，字段不出现 |
| UI | 双 badge 准确；tooltip 不含「已用/剩余额度」措辞 |
| 脱敏 | `record()` 不存储 url；trace/UI 只有数字 |
| guard 回归 | `apiCalls` 数值与改动前一致 |

### P1 配额查询

| 场景 | 必须验证 |
| --- | --- |
| `get_quota_info` 正常返回 | 解析出 count/used/surplus |
| 配额不足的离线任务提交 | 错误归类为配额类，非转存失败 |
| 查询接口失败 | 不阻断主流程，静默放弃内部决策 |
| token 失效 | 走既有刷新逻辑，不重复刷新 |

### P2 字幕上传

| 场景 | 必须验证 |
| --- | --- |
| 秒传命中（status=2） | 一次 init 即完成；不走离线任务；`get_quota_info` surplus 不变 |
| 需上传（status=1） | 按设计降级到离线任务（步骤 A 范围） |
| 上传接口报错 | 降级到离线任务 |
| assrt 直链下载失败 | 降级到离线任务 |
| 字幕文件过大（>上限） | 降级到离线任务 |
| 多集字幕包 | 逐文件 init；部分秒传部分降级的混合情形正确 |
| 磁力视频转存 | 完全不受影响 |
| 落地确认与 rename | 与现状一致 |
| 平台服务暂停 | 上传路径失败即降级，字幕软目标行为不变 |

## 9. 设计模式与可复用设施

| 模式／设施 | 应用点 |
| --- | --- |
| **策略模式** | `DriveApiQuotaClass` 分类函数按平台注册（仿 [rate-limiter.ts](../../packages/shared/src/rate-limiter.ts) 的 `createBrandPacer`）；字幕落地策略（上传优先／离线任务降级）亦是策略选择 |
| **适配器模式** | 各网盘 client 提供自己的分类映射与上传能力；未登记平台默认 `free`，不错标 |
| **降级链（Fallback Chain）** | 字幕：上传秒传 → 上传对象存储（P3）→ 离线任务（现路径）。与既有 `resolvePan115OpenStream` → `resolvePan115CookieStream` 的降级先例同构 |
| **状态机** | 字幕落地状态：`pending → uploading/transferring → landed/failed`；配额状态：`sufficient/low/exhausted` 影响路径选择 |
| 既有可复用 | `callApi(operation, call)` 操作名已参数化；`Pacer` 策略族；`strm_link_cache` 直链缓存；agent trace 管线（`apiCalls` 已是逐步落库的累计值）；`asEvidence` guard-refusal 模式 |

## 10. 业界对照

| 方案 | 做法 | 可借鉴 |
| --- | --- | --- |
| **云厂商配额 API**（AWS Service Quotas、GCP Quota） | 提供查询配额与用量的独立 API，与业务调用分离 | `get_quota_info` 与业务调用分离；配额查询失败不阻断业务 |
| **rclone** | 多后端抽象，上传走各后端原生协议；失败有明确错误分类 | 后端能力差异用适配器隔离；字幕上传/降级即此模式 |
| **Sonarr/Radarr** | 下载客户端有队列与失败分类，不把「客户端配额不足」当「资源不存在」 | 配额不足必须是独立错误类，不能混入转存失败 |
| **OpenList/AList** | 115 驱动同时实现 Open API 与 Cookie 两条路径，互为降级 | 双路径降级的工程先例 |
| **Prometheus 指标设计** | 标签基数控制，按少数维度打标 | 分类只用 2 类而非按操作名打标，避免基数爆炸 |

## 11. 参考来源

检索与核对日期：2026-11-15。优先使用官方文档／维护者仓库；在线文档可能领先本地安装版本，采用前需核对本地类型及锁文件。

- [S1 115 开放平台 API 文档（语雀镜像全文）](https://github.com/ddc-111/115quick/blob/main/115_api_docs.md)：本次主要依据。含上传流程（`/open/upload/get_token`、`/open/upload/init`、`/open/upload/resume`）、云下载配额（`/open/offline/get_quota_info`）、文件管理全量端点。原始出处为 `https://www.yuque.com/115yun/open`。
- [S2 115 开放平台官网](https://open.115.com/)：官方入口，SPA 渲染需登录。官方明确「超出本平台限制的特殊使用需求须申请并获得明确同意」。
- [S3 115 网盘 API 开放平台系统维护公告](https://115.com/115/T976421.html)：2026-08 平台单方面暂停服务，证明平台能力非恒定可用，必须有降级路径。
- [S4 115 网盘 API 开放平台即日起暂停服务（新浪科技）](https://finance.sina.com.cn/tech/digi/2026-08-09/doc-inimshax9165885.shtml)：同上事件外部报道。
- [S5 开发者如何入驻开放平台](https://115.com/115115/T853224.html)：应用创建需填报相关接口与覆盖用户，佐证平台按接口维度管控。
- [S6 OpenList 115 驱动文档](https://doc.oplist.org/guide/drivers/115_open)：第三方驱动实现参考，双路径（Open/Cookie）降级的工程先例。
- [S7 OpenList issue：115 上传 405 问题](https://github.com/OpenListTeam/OpenList/issues/2078)：`POST /open/upload/init` 的实际调用案例，佐证上传端点真实可用。
- [S8 Token Bucket Algorithm](https://medium.com/@0xTanzim/understanding-the-token-bucket-algorithm-for-rate-limiting-fccdf80e27ca)：限流基础，与本地 [rate-limiter.ts](../../packages/shared/src/rate-limiter.ts) 对照。
- [S9 Prometheus Metric Types](https://prometheus.io/docs/concepts/metric_types/)：计数器语义，本地计量与平台计数的口径区分参照。
- [S10 Prometheus Cardinality Best Practices](https://www.groundcover.com/learn/observability/prometheus-cardinality)：标签基数控制——本方案刻意只用 2 个分类。
- [S11 AWS Service Quotas](https://docs.aws.amazon.com/servicequotas/latest/userguide/intro.html)：配额查询 API 与业务调用分离的设计范式。

本地设施核对（2026-11-15，基线 `1f325444`）：[Pan115Operation 与 callApi](../../packages/workflow/src/storage/storage-115-executor.ts#L69)、[PAN115_TRANSFER_OPERATIONS](../../packages/workflow/src/storage/storage-115-executor.ts#L76)、[callsSpent](../../packages/workflow/src/storage/storage-115-executor.ts#L284)、[Open 直链解析](../../packages/workflow/src/storage/pan115-open-client.ts#L521)、[Open 端点清单（无上传）](../../packages/workflow/src/storage/pan115-open-client.ts#L122)、[Cookie 直链解析](../../packages/workflow/src/storage/pan115-cookie-client.ts#L377)、[lixianssp 端点](../../packages/workflow/src/storage/pan115-cookie-client.ts#L16)、[stream-resolver 双路径降级](../../packages/workflow/src/storage/stream-resolver.ts#L118)、[transferSubtitleUrls 及其成本注释](../../packages/workflow/src/storage/storage-115-executor.ts#L736)、[Pacer 策略族](../../packages/shared/src/rate-limiter.ts)、[strm_link_cache](../../packages/workflow/src/persistence/sqlite/sqlite-strm.ts#L279)、[agent-step-view 投影](../../packages/workflow/src/domain/agent-step-view.ts#L31)、[时间线 UI](../../apps/web/features/activity/components/agent-timeline.tsx#L30)、[字幕软失败语义](../../packages/workflow/src/acquisition-v2/agent-loop.ts#L298)、[123 上传（115 无对应实现）](../../packages/workflow/src/storage/pan123-client.ts#L389)。

## 12. 实施状态（2026-11-15）

P0／P1／P2 已全部落地并通过本地门禁；P3 未实施（需单独授权）。

### 12.1 已落地

| 阶段 | 实现 | 落点 |
| --- | --- | --- |
| P0 分类模型 | `download` / `free` 两类；转存与磁力／ed2k 离线任务为 `free`，直链解析、http 离线任务、离线任务管理（`listOfflineTasks` / `removeOfflineTask`）为 `download` | [drive-api-quota.ts:35](../../packages/workflow/src/storage/drive-api-quota.ts#L35)、[:74](../../packages/workflow/src/storage/drive-api-quota.ts#L74) |
| P0 旁路计量 | 不拦截、不改写、不抛错、不存 URL；**executor 自持一个实例**，生命周期即一次运行（与 `apiGuard.callsSpent()` 的 `apiCalls` 对称） | [drive-api-meter.ts:37](../../packages/workflow/src/storage/drive-api-meter.ts#L37)、[storage-115-executor.ts:562](../../packages/workflow/src/storage/storage-115-executor.ts#L562) |
| P0 埋点 | executor 单一出口 `callApi` 上报，经 `downloadApiCallCount()` → trace sink → 视图 → UI | [runner-v2.ts:280](../../packages/workflow/src/execution/runner-v2.ts#L280) |
| P0 展示 | `AgentStep.downloadApiCalls` → 视图投影 → 时间线第二枚徽标（仅任务内次数，**不显示月限额**） | [agent-timeline.tsx:35](../../apps/web/features/activity/components/agent-timeline.tsx#L35) |
| P1 配额查询 | `/open/offline/get_quota_info`，兼容 `data[]` 与 `{package:[]}` 两种形态；缺失字段保持 `undefined`，不拿 0 冒充 | [pan115-open-client.ts:757](../../packages/workflow/src/storage/pan115-open-client.ts#L757) |
| P1 错误分类 | 配额类拒绝包装成可操作说明并保留原始信息；**不进 UI 月限额展示** | [pan115-quota-exhausted.ts:39](../../packages/workflow/src/storage/pan115-quota-exhausted.ts#L39) |
| P2 上传秒传 | `/open/upload/init`，`status===2` 即落地；本地下载字幕算整文件与前 128K SHA1；5 MB 上限 | [pan115-open-client.ts:770](../../packages/workflow/src/storage/pan115-open-client.ts#L770)、[storage-115-executor.ts:779](../../packages/workflow/src/storage/storage-115-executor.ts#L779) |
| P2 上传优先 + 降级 | 逐文件上传，命中即落地；`needs_object_storage` / `unavailable` / **抛错**一律静默降级回离线任务，只把未命中的文件交给 `transferSubtitleUrls` | [subtitle-upload-landing.ts:15](../../packages/workflow/src/acquisition-v2/subtitle-upload-landing.ts#L15) |

能力门控沿用既有约定：`uploadSubtitle` 为可选方法，未实现的品牌（夸克／天翼）自动走原离线任务路径，零额外接线。

### 12.2 验证证据

- `npm run build:workflow`、`npm run typecheck`、`npm run gate`（24 子门禁 + lint + typecheck）均 **exit 0**。
- `packages/workflow` 全量回归：**309 文件 / 3829 测试全通过**。
- 新增测试：分类 15、计量 6、计量集成 4、配额错误分类 6、上传 10、open-client 配额与上传 8、trace／视图各 2、sandbox 上传优先与降级 5。
- 门禁处置遵循既定棘轮策略：绝对上限靠**抽取**达成（`agent-tool-wrap.ts`、`snapshot-presentation.ts`、`subtitle-upload-landing.ts`、`pan115-open-payloads.ts`），存量文件的授权增长才 re-baseline。sandbox.ts 由 2749 物理行降至 2629（上限 2640）。

### 12.3 尚未验证的验收项（需真实授权环境）

§7 P2 的「秒传命中的字幕包：`get_quota_info` 前后 surplus 不变」这条**只能在真实 115 账号上验证**——它要证明的是「上传不计额」这一平台侧假设，本地 mock 无法替代。当前已验证的是**调用路径**（秒传命中时一次离线任务都不发），而非平台侧额度实际未扣。上线后需跑一次真实字幕包并比对前后 surplus 才能结案。

同理，§2.4 记录的平台服务暂停风险意味着上传路径随时可能整体不可用；降级链已覆盖，但真实降级频率需线上观察。

### 12.4 未实施（P3，需单独决策）

对象存储 PUT（`status===1` 的实际上传）、直链缓存扩展到正片播放、下载类调用软阈值告警。当前 `status===1` 一律降级到离线任务。

### 12.5 对本文前期结论的两处更正

调研初期曾判断「115 无上传实现，字幕改上传不可行」与「配额不可查询」，均被用户推翻并已核实为**错误**：上传链路（`/open/upload/init` 秒传）与配额查询端点在官方文档中真实存在，本地缺实现不等于平台不支持。§11 末尾的本地设施核对清单中「Open 端点清单（无上传）」「123 上传（115 无对应实现）」两条描述的是**改造前**状态，现已失效。

### 12.6 验收期发现并修复的缺陷：下载计数跨任务累加

首次部署后做 /activity 验收时发现：`driveApiMeter` 原为**进程级单例且全代码库无任何 `reset()` 调用**，导致

1. 第二个任务显示的是「上一个任务 + 本任务」的累计值，违背用户要求的**任务内调用次数**口径；
2. STRM 播放侧的直链解析（`stream-resolver`）也向同一单例上报，把**与任务无关的播放流量**混进任务徽标。

对照既有设计：`apiCalls` 走 `apiGuard.callsSpent()`，guard 是 **per-executor 实例**，而每次采集运行经 factory 新建 executor，因此天然按任务隔离。下载计数破坏了这一对称性。

**修法**（用户 2026-11-15 决策）：计量器改为 executor 自持实例，新增 `downloadApiCallCount()`，`StorageExecutor` 端口加同名可选方法，runner-v2 改读 `storage.downloadApiCallCount?.()`；**移除全局单例与 stream-resolver 两处播放埋点**。

播放侧直链观测归入已延后的 P3：核实 `resolveStream` 只被 `/api/strm/play/[taskId]/[fileId]` 路由调用，采集链路从不走它，故播放调用没有任务上下文，本就不该进任务徽标；保留一个无消费方的全局计数器只是死代码。

**红绿验证**：临时把计量器改回共享实例后，新增的隔离测试报 `expected 14 to be +0`（另有 2 个测试因跨用例污染同时变红）；恢复 per-instance 后 5/5 通过。回归测试「计数按任务隔离：第二个 executor 不继承第一个的下载类次数」即此缺陷的长期守卫。

修复后复验：`build:workflow`／`typecheck`／`gate` 均 exit 0，`packages/workflow` 全量 **309 文件 / 3829 测试通过**。

### 12.7 Dev 实机验收（3020，修复后构建）

在隔离的 Dev 实例部署含 §12.6 修复的构建后，触发两次真实获取，于 `/activity` 目视 + 接口双通道验收：

| 运行 | 路径 | 总调用 / 下载类 | 结论 |
| :--- | :--- | :--- | :--- |
| 国产剧（凡人修仙传 第 1 季） | 分享转存，无离线任务 | 160 / **0** | 无额限操作不误报为下载类 |
| 非国产（葬送的芙莉莲 第 1 季） | 字幕上传不可用 → 静默降级 http 离线任务 | 87 / **25** | 下载类真实计数并渲染 |

- 非国产运行的 `transferSubtitle` 一步发出 34 次调用、其中 25 次下载类（http `addOfflineTask` 提交 + `listOfflineTasks` 轮询）；其后继 free-only 步骤徽标稳定停在 25，不再增长。该步最终报「offline task accepted but file did not materialize in window」——**调用已发生即计数**，与落地成败无关，口径正确。
- 任务隔离实机可见：前一运行累计到 160，后一运行仍从自己的 10 起算，互不继承。
- 双徽标渲染正确：新运行每步「网盘 API 累计 N 次」+ 独立玫瑰色描边的「下载类 M 次」；字段缺失的历史运行只显示单徽标（`downloadApiCalls !== undefined` 门控）。
- 控制台无 error、无水合崩溃；截图留存于会话临时目录（不入库）。

至此 §12.3 中「徽标是否正常显示」一项结案；仍待真实授权环境结案的只剩「上传秒传命中前后 `get_quota_info` surplus 不变」这一平台侧额度假设。

## 13. 后续增量：网盘/设置页显示当月剩余下载与离线额度（2026-11-15）

用户在活动页徽标验收通过后追加需求：**在设置页／网盘页／115 页面显示当月剩余下载与离线额度**。

这**不推翻** P0 的展示纪律，两者口径分工明确：

| 位置 | 显示内容 | 数据来源 |
| --- | --- | --- |
| 活动页任务徽标 | 本次任务内的**调用次数**（不分额度） | 本地计量器 |
| 网盘/设置页 115 诊断 | 平台侧**当月剩余 / 总额度** + 各配额类型明细 | `get_quota_info` |

### 13.1 实现

- 报告类型 `StorageDiagnosticsReport` 增加 `quota`：`available` / `error` / `total` / `packages`。
- `diagnoseStorageConnection` 在 Open OAuth 健康时调用 `probeQuotaInfo`；OAuth 不健康或 Cookie-only 时直接给 `available:false` + 原因，**不白跑注定失败的请求**。
- 诊断弹窗新增 `QuotaCard`，不可用时显示「暂不可用：<原因>」而不是显示 0——`surplus` 缺失保持 `undefined`，不拿 0 冒充「额度耗尽」。

### 13.2 为什么按需查询

用户选择「打开诊断/展开卡片时」才查：每次查询都消耗一次 115 Open API 调用，网盘列表页每次加载都查会造成无谓消耗。纯展示的列表不触发查询。

### 13.3 硬边界（必须如实呈现）

配额**只有 Open OAuth 链路可查**（Cookie 引擎没有配额端点）。因此：

- Cookie-only 部署、OAuth 失效（如 40140137）时，UI 显示「暂不可用」而非任何数字；
- 查询失败不阻断诊断报告本身——配额是附加信息，不是连接健康的判据。

验证：`apps/web` + `packages/workflow` 回归通过；`gate` exit 0；诊断 action 测试新增 Cookie-only 与 OAuth 失效两条不可用断言，并做过红绿验证（移除 Cookie-only 分支后该用例变红）。
