# 内置浏览器（Electron）在容器里的安装与恢复方案

> 2026-10-27 实测记录。环境：DSH 容器（Debian 12 / arm64 / 以 root 运行 / 无显示器）。

## 1. 问题链

`dsh_browser_*` 工具报错：

```
browser provider(s) electron are registered but report themselves unavailable —
for dsh-builtin-browser this means no spawnable Electron binary was found
```

按提示 `npx install-electron` 是**没用的**（该 bin 包不存在，`could not determine executable to run`）。
真正的原因要读插件源码（`/root/.dsh/profiles/web/node_modules/dsh-builtin-browser/`）：

1. **它只在自己的 profile 里找 Electron**（`resolveElectronPath`：先 `ELECTRON_PATH` 覆盖，
   再插件自带的 electron 包，再 DSH 安装锚点）。profile 里
   `/root/.dsh/profiles/web/node_modules/electron`（v44.7.0）**只有包壳、没有二进制**
   ——npm 装的时候跳过了下载。仓库自带的 `node_modules/electron`（33.4.11，桌面端用）
   它看都不看。
2. 补上二进制后，撞上容器特有的两道墙：
   - **root 身份**：Chromium 拒绝以 root 启动且无 `--no-sandbox`
     （`Running as root without --no-sandbox is not supported`）。
   - **无显示器**：host-main 建 `BrowserWindow` 需要 X；容器里 `DISPLAY` 未设置。

## 2. 方案（四步，全部已实现为一条命令）

```bash
./scripts/setup-builtin-browser.sh        # 幂等，可反复跑
```

| 步骤 | 做法 | 为什么这么做 |
|---|---|---|
| ① Electron 二进制 | 在 profile 的 electron 包里跑 `node install.js`（约 220MB） | 下载到插件真正会找的位置 |
| ② 运行时依赖 | `ldd <electron.real>` 找 `not found` 的 `.so`，映射到 Debian 包装（libgtk-3-0 / libgbm1 / libasound2 …），外加 `xvfb` | 不写死清单——重建后基础镜像变了，缺的可能不止一两个 |
| ③ root + 无显示器 | 把 `dist/electron` 改名 `electron.real`，原位置放一个 shell 包装器：`exec electron.real --no-sandbox "$@"` 并 `export DISPLAY=:99` | 插件的探测只看「路径存在且 basename 含 electron」，包装器能过检； sanity 自检会真起一个窗口再退出 |
| ④ 虚拟显示器 | `Xvfb :99 -screen 0 1400x900x24` 常驻，就绪判断用 X socket 存在性（**不用 `xdpyinfo`**——它属于另一个包 x11-utils） | Electron 的 BrowserWindow 需要真 X server |

> 撤销方法：删掉 `dist/electron` 包装器，把 `electron.real` 改名回 `electron` 即可，
> 对 DSH 无任何持久影响。

## 3. 重建容器后会怎样（2026-10-27 实测结论）

当天真的发生了一次容器重建（hostname 从 `4c7857799cd7` 变成 `6abf79b28ec3`），
据此得到确切的持久性分级：

| 组件 | 位置 | 重建后 |
|---|---|---|
| Electron 二进制（211M） | `/root/.dsh/...`（`/root` 是宿主卷 `/dev/sda1`） | ✅ **保留** |
| 包装器脚本 | 同上 | ✅ **保留** |
| apt 装的系统库（gtk3/gbm/asound/xvfb） | 容器层 `/usr` | ❌ **丢失，必须重装** |
| Xvfb 进程 | 进程表 | ❌ **丢失，必须重启** |
| `gh` CLI 二进制 | 容器层 `/usr/local` | ❌ **丢失**；但 `/root/.config/gh/hosts.yml` 登录态保留，重装后免登录 |
| 仓库 / `.next` / `node_modules` / `data/` | `/root/mediary-scout`（同卷） | ✅ 保留 |

**结论：重建后跑一条命令即可**：

```bash
./scripts/setup-after-rebuild.sh      # = setup-gh-cli.sh + setup-builtin-browser.sh
```

它补齐容器层丢失的部分（gh CLI、系统库、Xvfb），`/root` 卷上的东西原样保留。
②的 ldd 驱动检测正是为这种「下次缺的可能是别的库」准备的。

**gh CLI 特别说明**：`gh` 二进制在容器层会丢，但登录态
`/root/.config/gh/hosts.yml` 在 `/root` 卷上**不丢**——所以 `setup-gh-cli.sh`
装完就是**已登录**状态，不需要重走设备码授权（本次重建后实测确认：
装完 `gh auth status` 直接显示 xixjohan）。

但光装上还不够，**凭据 helper 有两处会坏**（本次重建后两个都踩到了，
表现为 `git push` 报 `could not read Username for 'https://github.com'`）：

1. `~/.gitconfig` 里 helper 写的是**绝对路径**（gh 自己安装时写死的），
   gh 重装后路径可能变（`/usr/local/bin/gh` → `/usr/bin/gh`）→ helper 指向
   不存在的文件。解法：`gh auth setup-git` 重写为当前路径。
2. **仓库本地** `.git/config` 里的空 `credential.helper=` 会**重置 helper
   列表**，把全局的 gh helper 吃掉——这是最隐蔽的一个。解法：见到就
   `git config --local --unset-all credential.helper`。

`setup-gh-cli.sh` 现在两件都自动处理，并用 `git credential fill` 级别的
端到端验证兜底。

## 4. 已知遗留：客户端交互未通

浏览器能打开页面、能读 DOM、能 `execute`（JS 在执行），但**点击不触发 React 事件**
（点「关闭通知」横幅不消失；点「获取」不产生 workflow run）。`window.onerror` 无报错。
怀疑方向：该 Electron 宿管的 webPreferences / hydration 链路。**待查**，与本文的安装
方案无关——安装本身是通的（自检会真实创建 BrowserWindow）。

## 5. 快速自检

```bash
./scripts/setup-after-rebuild.sh       # 重建后：一条命令恢复 gh + 内置浏览器
./scripts/setup-gh-cli.sh              # 只恢复 gh
./scripts/setup-builtin-browser.sh     # 只恢复内置浏览器
```
