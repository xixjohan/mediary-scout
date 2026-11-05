# STRM 相对输出路径与快速部署可行性调研（2026-11-05）

## 目标与范围

目标设想是让 STRM 电影/剧集目录预设指向程序目录下的 `data/strm/movies` 与 `data/strm/tv`，避免固定写入 Linux `/data/...`，同时通过 `scripts/deploy-remote.ps1 -Mode Dev` 快速部署验证。无需兼容旧路径，不迁移旧任务；本文评估新路径语义、安全、性能、可复用能力与部署约束，不是实现或部署记录。

## 当前系统实际行为

1. `LocalFolderPickerModal` 直接把预设字符串传给 `onSelect`；当前预设已在工作区改为相对字符串 `data/strm/movies`、`data/strm/tv`，但目录浏览 API 接受服务端文件系统路径，客户端没有解析相对路径的规则。相对值请求时会由服务端 `path.resolve` 按进程 `cwd` 解析，但白名单检查和 UI 返回值仍存在隐式语义，不能认为相对路径功能已经完成。
2. `fs-browse` 的根之一是应用 `process.cwd()`，在 Linux 下通常可覆盖程序工作区；目录浏览 GET 和 mkdir POST 都基于同一文件系统 API。当前根判断是词法包含检查，尚未解析 symlink 的真实路径。
3. 新建任务表单默认值仍为 `/data/strm/movies`。创建/更新 API 将 `localOutputDir` 原样持久化；`strm-writer`、`strm-scanner` 和任务调度后续直接用它写文件、扫描文件。故路径基准不是纯 UI 概念，必须在任务保存前规范化，或由统一运行时适配器解析。
4. 仓库已有 Node `path`/`fs`、鉴权、目录浏览/创建 API、任务持久化、STRM writer/scanner 和 Vitest 测试。没有专用本地目录选择/路径解析库。通用 glob 库只适合文件匹配，不处理容器路径语义和授权边界。
5. 快速部署脚本的 Dev `Direct` 打包明确排除仓库根 `data/`（以及 `run`、`env` 等运行数据）。这意味着仓库根 `data` 不会经代码包同步；容器中若需要此目录，必须通过 Docker volume/bind mount 或容器启动时创建。要持久化 STRM 文件，优先采用独立命名卷或宿主目录 bind mount，而不是依赖镜像层。

## 问题本质

路径字符串同时承担了三种不同语义：用户可读的相对配置、Web 容器里的绝对物理路径、媒体服务器看到的挂载路径。若不区分这三者，会出现“弹窗选中成功但 worker 写入另一处”“部署更新后目录消失”“媒体服务器无法读取 STRM 文件”等问题。

路径选择器也只浏览 Web 服务所在容器可见的文件系统。`data/strm` 必须存在于容器内，并且持久化卷/媒体服务器要映射到相同数据；宿主机路径与容器路径不可混用。

## 业界方案比较

| 方案 | 路径基准 | 边界与容器语义 | 对本项目的启示 |
|---|---|---|---|
| Docker bind mount / volume | 容器内目标路径是应用运行时路径 | 由部署声明宿主到容器的映射；容器内应用只访问挂载目标 | STRM 输出持久化应由部署负责；清晰区分宿主源和容器 target |
| Nextcloud Local External Storage | 管理员配置的服务器本地绝对目录 | 存储先配置并校验，再由文件界面展示 | 采用显式的受控存储根，不把任意相对路径解释成全局路径 |
| File Browser root/scope | 实例配置的根目录 | 所有文件操作限定在 root 下 | 浏览与创建都应经过同一根目录策略 |
| 本项目拟议相对路径 | `data/strm/movies` | 服务端固定以程序工作目录为基准解析并限制在该根下 | 保存稳定的相对配置，避免客户端路径与容器宿主路径混淆 |

参考：

- Docker bind mounts：<https://docs.docker.com/engine/storage/bind-mounts/>（bind mount 明确 source 与容器 target，target 应为绝对路径）
- Docker run mounts：<https://docs.docker.com/engine/containers/run/>（容器内 target 路径约束）
- Nextcloud 本地外部存储：<https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage/local.html>
- File Browser 配置：<https://filebrowser.org/configuration.html>

## 设计模式建议

### 1. 路径解析适配器 + 策略注册表

定义 `OutputPathResolver` 接口，并用小型策略注册表选择语义：

- `ProgramRelativePathStrategy`：将 `data/...` 固定解析到服务端定义的程序根（启动时确定的 `process.cwd()` 或显式 `APP_ROOT`），而不是依赖调用点 cwd；规范化后限制在程序根内。
- `AbsolutePathStrategy`：若界面仍允许用户输入绝对路径，则单独按配置的允许根验证；若产品最终只允许程序目录下路径，可移除此策略，收窄输入面。

解析结果建议携带 `configuredPath`、`resolvedPath`、`storageRootId` 与 `strategy`，日志中不包含敏感用户路径之外的凭据。浏览器只提交逻辑路径/根 ID，服务端重新解析并授权；不要信任浏览器传来的绝对化结果。

避免“为模式而模式”：当前只需程序相对路径时，单一 resolver 足够；只有仍需支持绝对路径输入时，才保留策略注册表。

### 2. 创建表单状态机（轻量）

路径 UI 可明确表达 `loading-roots → ready → browsing → selected → submitting / error`。预设只在根已发现且目标已存在/可创建时可选；API 错误时保留用户输入并给出恢复操作。无需引入 XState 等状态机依赖，React reducer 或有限状态联合类型足够。

后台任务状态机与路径解析不是同一问题，不建议耦合。任务运行时可在执行前增加路径可用性校验状态（`path-checking/path-unavailable`），记录明确错误，避免因路径缺失进入模糊的写入失败。

## 推荐方案（不兼容旧路径）

1. 唯一语义定为程序根相对路径：表单/API/数据库统一保存 `data/strm/movies`、`data/strm/tv`；服务端以启动时确定的程序根解析，禁止按请求目录或各模块自己的 cwd 解析。
2. 相对路径解析后必须规范化并保持在程序根内；拒绝绝对路径、空路径、`..` 逃逸和 symlink 越界。若用户需要其他磁盘位置，应通过部署把卷挂载到程序根之下，而不是输入任意绝对宿主路径。
3. 创建任务时校验路径并创建目录；浏览 GET、mkdir POST、任务写入、扫描、base URL 替换和删除清理全部调用同一 resolver，保证写入与读取语义一致。
4. 不读取、不转换、不自动修复旧数据库路径。上线后旧格式任务按新规则校验，不能解析的任务应标记为路径无效并要求用户重建任务；这符合无需兼容的范围，但需在发布说明中提示旧任务需重建。
5. Dev 部署要确认 `data/` 是否在容器文件系统内并具备持久化。脚本排除仓库根 `data/`，因此若数据应保留，部署容器需把 volume/bind mount 挂到程序根的 `data/`；Direct/GitArchive 代码同步不应覆盖卷数据。

## 性能与运维考量

- `path.resolve` 属于微小本地计算，不构成性能风险。`realpath` 是本机元数据操作；可在请求/任务边界解析一次并传递解析结果，不要每个 STRM 文件都重新解析根目录。
- 大目录枚举 `readdir` 才是主要成本；本功能仅列子目录，避免递归扫描。不要为相对路径再引入 glob 遍历。
- 不应长期缓存 symlink 解析结果；挂载可能重连或改变。可缓存静态配置根，但每次敏感写操作仍验证真实目标。
- Worker 与 Web 若在不同容器/主机，必须保证相同卷映射和同一逻辑根配置，否则保存成功不等于文件对 worker 可见。
- 目录无权限、根未挂载、磁盘只读或空间不足应分别报出可操作错误；不要将它们折叠成“路径越界”。

## 防回归测试与门禁

- Resolver 单测：POSIX/Windows 绝对路径、逻辑别名、相对路径规范化、`..` 拒绝、空值/盘符/分隔符语义、未知别名拒绝。
- 根边界测试：根目录自身、根内目录、相似前缀（`/app/data2`）、symlink 指向根外、目标不存在但父目录存在。
- 路由集成测试：GET 浏览、POST 创建分别覆盖根内成功、越界拒绝、缺失 mount、只读/演示模式、鉴权。
- STRM 行为测试：任务保存逻辑路径后 writer 在预期根写入；scanner 扫描同一 resolved path；重复调度重启后路径语义不变。
- 新契约测试：数据库只保存相对路径；绝对路径及旧格式值拒绝执行并给出要求重建任务的错误；清理接口不能解析到程序根外。
- 部署验收：执行 `-Mode Dev -SyncMethod Direct` 后，容器内检查根路径存在、可写、卷挂载类型正确；重建开发容器后验证 STRM 文件保留；worker 与媒体服务读取同一个文件。
- 轻量静态门禁：禁止 STRM 业务层直接 `path.resolve(localOutputDir)` 或直接 `mkdir/writeFile(localOutputDir)` 绕过 resolver；默认预设集中定义并与 API 返回的根能力一致。

## 可行性结论

程序根相对路径解析可行，项目已有文件系统、路由、任务执行和测试基础设施，不需要新增第三方库。核心工作不在字符串拼接，而在统一解析基准、贯通 writer/scanner/清理/媒体服务器映射与部署卷。按用户范围不保留旧路径兼容：新建任务只保存相对路径，旧任务不迁移且需重建。建议采用单一路径解析器；只有绝对路径与相对路径需并行时才使用策略注册表。UI 使用轻量状态机表达加载、可选、错误和提交状态。

快速部署可用于验证代码，但若要验证数据持久化，需要先在 Dev 容器配置独立 STRM 卷/挂载。脚本的 Direct 同步忽略仓库 `data/`，因此推送源码不会自动携带该目录的数据；这实际上是正确的数据隔离行为。实施前需把挂载目标与现有开发容器定义核实并纳入部署契约。
