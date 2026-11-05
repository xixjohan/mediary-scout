# STRM 目录选择器 ENOENT 调研（2026-11-05）

## 现象

选择器显示当前位置 `data/strm/movies`，随后服务端报错：

```text
ENOENT: no such file or directory, stat '/app/data/strm/movies'
```

## 根因定位

当前新路径解析器 `resolveStrmOutputPath()` 将 `data/strm/movies` 固定解析为程序根 `/app` 下的 `/app/data/strm/movies`。开发容器将持久化 Docker 命名卷挂载在 `/app/data`，所以目标属于正确的数据卷范围。

但 `GET /api/system/fs-browse` 在解析后直接调用 `fs.stat(resolved)`。路径选择器的“Docker 电影/剧集”预设只调用 `onSelect(preset)` 并关闭弹窗，不请求目录浏览、不创建目录，也没有先验证路径存在。首次使用时卷里尚无 `strm/movies` 目录，于是 `stat` 对不存在路径抛出 ENOENT。这里不是安全白名单拒绝，也不是 Docker mount 丢失，而是把“可创建的目标路径”当作“已存在的可浏览目录”。

任务创建 API 已会 `mkdir(..., { recursive: true })`，但用户当前是在目录选择器中请求浏览这个不存在路径，任务尚未提交到该 API，因此创建逻辑没有机会运行。若已有任务创建成功但弹窗仍报错，则需检查该容器中 `/app/data/strm/movies` 是否后来被删除，以及 web/worker 是否处于同一容器卷视图。

## 问题本质

目录选择器混合了两个不同用例：

1. **浏览现有目录**：目标必须存在，执行 `stat` 和 `readdir`。
2. **选择/创建输出目录**：目标可以暂不存在，但必须确认其最近存在的父目录可访问、可写，且规范化后仍位于授权根内；最终创建应由明确的创建动作完成。

预设是“选择输出目标”，界面却按“浏览现有目录”处理。状态机缺少 `target-missing-but-creatable` 状态，导致正常首次初始化被呈现为文件系统错误。

## 现有基础设施与库复用

- 已有 `/api/system/fs-browse`：鉴权、可浏览根、路径安全检查、目录读取、写权限探测、POST 新建子目录。
- 已有 `resolveStrmOutputPath`：固定程序根相对语义、`data/` 范围限制和 symlink 越界检查；任务创建时已递归创建目标目录。
- 已有 Docker `mediary-dev-data:/app/data` 持久卷，支持容器重建后保留该目录树。
- 已有 Node `fs/promises`、`path`，没有需要增加的文件浏览专用第三方依赖。glob 库只搜索文件，不能表达“可创建目录”、鉴权范围或 Docker 挂载语义，不能解决本问题。
- 可借鉴现有 POST mkdir API，但应让路径解析与授权逻辑成为 GET/POST/任务 API 共用的服务端能力，避免多个入口采用不同边界。

## 主流方案对比

| 方案 | 不存在目标的处理 | 安全与用户体验 | 适用启示 |
|---|---|---|---|
| Docker volume/bind mount | 挂载目标可存在但其子目录通常需应用创建 | 容器应用只认识容器路径；数据由卷持久化 | `/app/data` 挂载正确不代表任意子目录已预建 |
| Nextcloud 文件浏览 | 浏览已存在的存储节点；存储挂载需管理员先配置 | 存储配置和权限先于文件列表 | 区分存储根配置与目录浏览 |
| File Browser | 对现有路径执行列表；创建目录是独立操作 | 操作限制在配置 root 内 | 复用浏览/创建分离的操作模型 |
| 本项目 STRM 选择器（建议） | 输出预设允许不存在，进入待创建状态；用户确认或创建后再保存 | 先校验允许根、父路径和写权限，不把 ENOENT 当成越权 | 对“输出目标”提供专门的 prepare/ensure 流程 |

参考：

- Docker bind mounts：<https://docs.docker.com/engine/storage/bind-mounts/>
- Docker run mounts：<https://docs.docker.com/engine/containers/run/>
- Nextcloud 本地外部存储：<https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage/local.html>
- File Browser 配置：<https://filebrowser.org/configuration.html>

## 具体解决方案

### 推荐：输出目录准备 API + 明确 UI 状态

新增一个仅服务 STRM 输出目标的 prepare/ensure 操作，或扩展现有 API 为明确的 `mode=output`：

1. 输入仅接受规范相对配置路径（如 `data/strm/movies`），经 `resolveStrmOutputPath` 解析并校验 `data/` 边界、绝对路径拒绝、`..` 和 symlink 逃逸。
2. 不存在目标时，从 `data` 根开始逐级检查最近存在祖先：必须为目录、可写、真实路径仍位于真实 data 根中。存在但不可写、父级缺失且无法创建、权限拒绝，分别返回可操作错误；不要吞成 ENOENT。
3. 对“使用此目录”操作，在用户明确选择后用 `mkdir(target, { recursive: true })` 建立目录，再用 `realpath/stat/access(W_OK)` 复核；成功后返回 `{ configPath, resolvedPath, exists, canWrite }`。重复调用幂等。
4. 纯浏览现有目录仍维持 GET 的 `stat/readdir` 契约。遇到 ENOENT 返回 404 和结构化错误码 `DIRECTORY_NOT_FOUND`，不要把 Node 原始错误直接展示；UI 可提示“目录尚不存在，可创建并选择”。
5. 快捷预设不应立即关闭并静默保存。点击后先检查/准备目标，显示加载中；准备成功后选择并返回规范相对路径，失败则留在弹窗并给出重试/返回根目录操作。
6. 普通目录浏览中的“新建子目录”继续调用受控 POST mkdir，创建成功后刷新目录并选中新建目录。GET 浏览和 POST 创建共用授权服务。
7. 任务 API 可继续在保存时确保目录存在，但应使用同一 ensure 服务，并在创建后复核真实路径；避免从任务 API 与选择器 API 实现两套不一致 mkdir 逻辑。

### 不建议

- 只在 GET 收到 ENOENT 时无条件递归 `mkdir`：浏览请求会产生隐式写入，误输路径也会在卷上创建目录。
- 让 UI 捕获 500 后直接保存预设：会隐藏权限、只读卷和挂载缺失问题。
- 安装文件浏览器组件库或 glob 库：问题出在服务端路径生命周期与 API 契约，不在列表 UI 控件。
- 自动创建任意输入路径：会把输入错误和路径穿越变成目录写入，应始终先做根约束与真实路径校验。

## 模式与状态机

适配器/策略模式不是本次主要复杂度来源。当前仅有程序根相对路径，一套 `StrmOutputPathService`（`resolve`、`inspect`、`ensure`）比多策略注册表更直接。若未来出现多个可配置存储根，再将根映射抽象为策略。

UI 建议用轻量 reducer/联合状态表达：

```text
idle → inspecting → existing-and-writable → selected
                  ↘ missing-but-creatable → creating → selected
                  ↘ unavailable/error
```

任务保存成功之后再进入 `saved`。不要把目录浏览的 `loading`、任务提交状态和 worker 运行状态混为同一个状态机。无需引入 XState；React 状态与 API 结构化错误码已足够。

## 性能与运维

- `stat`、`access`、`realpath` 和单层 `mkdir` 都是本地元数据操作；一次预设点击串行做少量校验，开销可忽略。
- `mkdir recursive` 天然适合首次初始化且幂等，但必须在授权校验之后执行，并在执行后核实真实路径。
- 列表仍只读取当前目录一层，不递归预扫描媒体库，避免大目录性能问题。
- 若 `data` 卷只读或磁盘权限不匹配，prepare API 应返回 `OUTPUT_ROOT_NOT_WRITABLE`；如果 `/app/data` 本身不存在或未挂载，返回 `OUTPUT_ROOT_UNAVAILABLE`。运维诊断可检查 mount，但不应把整个根文件系统开放为 fallback。
- 容器部署应保持 `mediary-dev-data:/app/data`。STRM 文件与 SQLite 同卷虽然能持久化，但若数据量或备份策略不同，后续可拆为专用 STRM 卷；本问题修复无需先拆卷。

## 同类门禁与回归测试

1. **预设初始化测试**：空临时 data 根上选择 `data/strm/movies`，第一次返回成功且目录创建；第二次重复执行成功且不破坏内容。
2. **浏览/准备职责测试**：GET 不存在目录返回结构化 404，且确认 GET 没有创建目录；prepare/ensure 才能创建。
3. **权限错误测试**：只读父目录、不可写 data 根分别返回明确错误码，不返回裸 ENOENT。
4. **边界测试**：`../outside`、绝对路径、`data/../../outside`、`data` 内指向根外的 symlink 在 inspect 与 ensure 下均拒绝。
5. **API 状态映射测试**：ENOENT -> 404、EACCES/EROFS -> 403 或 409/明确错误、路径非法 -> 400；不泄露栈或容器绝对路径给普通用户。
6. **端到端选择测试**：新容器空卷打开弹窗，点电影预设，能够创建并选择；提交 STRM 任务后 writer 生成文件，关闭并重开页面仍能浏览。
7. **持久化验收**：开发容器重建前后确认 `/app/data/strm/movies` 文件保留，且卷仍是 `mediary-dev-data`。
8. **静态门禁**：禁止预设按钮绕过 inspect/ensure 直接 `onSelect` 并关闭；所有 STRM 目录 mkdir 调用必须经统一服务。

## 结论

`ENOENT stat '/app/data/strm/movies'` 的直接原因是输出预设目标尚未创建，而当前 GET 浏览 API 立即对目标 `stat`；快捷按钮又绕过了目录准备流程。Docker `/app/data` 持久卷存在且可写时，这是首次使用时序缺陷，不是挂载路径选错。

建议复用 Node 文件系统与现有路径安全服务，增加显式 inspect/ensure 契约，并让 UI 展示“存在可选 / 不存在可创建 / 不可用”状态。不要让浏览 GET 隐式创建目录。通过空卷首次选择、权限失败、symlink 越界与容器重建持久化测试防止回归。
