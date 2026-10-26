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
| 仓库 / `.next` / `node_modules` / `data/` | `/root/mediary-scout`（同卷） | ✅ 保留 |

**结论：重建后只需跑一次 `./scripts/setup-builtin-browser.sh`**（它会补上容器层缺失的
系统库并重启 Xvfb，二进制和包装器不动）。②的 ldd 驱动检测正是为这种「下次缺的可能
是别的库」准备的。

## 4. 已知遗留：客户端交互未通

浏览器能打开页面、能读 DOM、能 `execute`（JS 在执行），但**点击不触发 React 事件**
（点「关闭通知」横幅不消失；点「获取」不产生 workflow run）。`window.onerror` 无报错。
怀疑方向：该 Electron 宿管的 webPreferences / hydration 链路。**待查**，与本文的安装
方案无关——安装本身是通的（自检会真实创建 BrowserWindow）。

## 5. 快速自检

```bash
./scripts/setup-builtin-browser.sh     # 四步全 ✅ 即可用
```
