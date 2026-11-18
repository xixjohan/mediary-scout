/**
 * POSIX-shell 与文件权限类测试的跨平台适配（仅测试用）。
 *
 * 为什么需要它：`apps/updater` 的测试要跑真实的 `run-update.sh`。Windows 上有
 * 四处与 POSIX **不等价**的东西，此前各测试文件各写一份、各踩一次：
 *
 *  1. **PATH 形态**。`${bin}:${process.env.PATH}` 里的 `bin` 是 `E:\...`；shell
 *     按 `:` 切分后得到 `E`、`\Work...` 碎片，桩目录不可见。修法：桩目录转
 *     `/e/...` 形态再前置（实测可行）。
 *  2. **shell 可执行文件的选择**。**绝不能**用 `C:\Program Files\Git\bin\sh.exe`
 *     的绝对路径：它启动时把 `/mingw64/bin` 插到 PATH 最前面（实测
 *     `PATH_HEAD=/mingw64/bin`），真实的 `git` 会压过桩目录里的 `git` 桩 ——
 *     「打桩的测试」又跑回宿主机真命令，这是最隐蔽的一半。走 PATH 上的 `sh`
 *     则保留我们前置的目录（实测 `PATH_HEAD=<stub>`）。
 *  3. **直接执行脚本**。`spawnSync("/path/x.sh", [])` 在 Windows 报 `EFTYPE`
 *     （无 shebang 执行关联），必须显式 `spawnSync(SH_BIN, [script])`。
 *  4. **argv 里的换行**。`v2026.10.02\nx` 作为参数传给 shell 时，Windows 的
 *     参数编码会在 `\n` 处截断（实测 shell 里只收到 `v2026.10.02`）。这是 OS
 *     层限制，测试侧构造不出，只能跳过该枚举项；脚本自身的换行拒绝分支由
 *     CI（ubuntu）覆盖。
 *
 * 刻意**不**做的：不把整个套件在 Windows 上跳过。1–3 修好后，`run-update.sh`
 * 的绝大部分行为（标签校验、备份、锁、回滚顺序、更新源推导）都能在 Windows 上
 * 真实验证；只有 POSIX 权限位与 argv 换行属于**不可验证**，由谓词单独裁决。
 */
import { platform } from "node:os";

const IS_WIN = platform() === "win32";

/**
 * 启动 shell 用的命令名。**故意只给 `"sh"`**（即便 Windows 上 Git 自带 bash）：
 * 绝对路径的 `sh.exe` 会重置 PATH 头部，让桩失效（见文件头第 2 条）。
 */
export const SH_BIN = "sh";

/** 该平台是否真的能断言 POSIX 权限位（Windows 上 chmod 被忽略，实测落 0666）。 */
export function posixModeAssertable() {
  return !IS_WIN;
}

/** 该平台能否把带换行的参数原样交给子进程（Windows 会在换行处截断）。 */
export function argvCarriesNewlines() {
  return !IS_WIN;
}

/** `E:\a\b` → `/e/a/b`；已是 POSIX 形态则原样返回。 */
export function toPosixPath(winPath) {
  return String(winPath)
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .split("\\")
    .join("/");
}

/**
 * 把桩目录前置进 PATH。桩目录在 Windows 上必须是 POSIX 形态；**基础 PATH
 * 保持原样**——shell 自己会把窗口的 `;` 分隔串翻成它需要的形式，我们不插手。
 */
export function pathWithStubs(stubBin, basePath = process.env.PATH ?? "") {
  const prefix = IS_WIN ? toPosixPath(stubBin) : stubBin;
  return `${prefix}:${basePath}`;
}

/**
 * 跑 shell 套件的超时。Windows 的进程派生比 Linux 贵一到两个数量级：
 * 「180 次健康轮询」那类用例在 Linux 上几秒，在 Windows 上实测 100–165 秒
 * （每次派生 ~35ms，一轮有 compose/cat/git 多个派生）。超时按平台给，
 * **不是**放宽断言语义——每个用例的期望值一个都没动。
 */
export const SHELL_SUITE_TIMEOUT_MS = IS_WIN ? 300_000 : 60_000;

export const POSIX_MODE_SKIP_REASON =
  "Windows 无 POSIX 权限位（chmod 被忽略，实测 0600/0640 都落 0666）；CI 跑 ubuntu-latest，覆盖不丢";

export const ARGV_NEWLINE_SKIP_REASON =
  "Windows 参数编码在换行处截断，构造不出该输入；脚本的换行拒绝分支由 ubuntu CI 覆盖";
