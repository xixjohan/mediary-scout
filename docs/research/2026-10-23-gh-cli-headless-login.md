# gh CLI 无头登录实现简报（2026-10-23）

> 目标：在没有 TTY、没有浏览器的 agent 环境里完成 `gh auth login`（OAuth 设备码流），
> 拿到可推送的 GitHub 凭据，并让 `git push` 后续免密。
> 流程已在 mediary-scout 仓库克隆（`/root/mediary-scout`，fork `xixjohan/mediary-scout`）
> 实测通过：账号 `xixjohan` 登录成功，`git push --dry-run origin main` 通，工作区零改动。

## 背景：为什么不能直接跑 `gh auth login`

agent 的 bash 是非交互 shell，`gh auth login` 的交互 TUI 跑不起来：

1. **光标查询无人应答**。gh 用 survey/promptui 渲染选项，启动即向终端发光标位置查询
   `ESC[6n`，等待终端回 `ESC[<row>;<col>R`。裸管道（`printf '\n' | gh ...`）或
   `script -qec` 包伪终端都会卡在这一步——**这是本方案要解决的核心问题**。
2. **无头环境缺配件**。没有 xclip/xsel/wl-clipboard（复制设备码失败，仅 warn）；
   没有 xdg-open（打开浏览器失败，仅 warn）。两者都不阻塞流程，可以忽略。

## 核心脚本

pty 驱动 + 三个自动应答，跑完即拿到设备码并等待授权：

```python
#!/usr/bin/env python3
"""Drive `gh auth login --web` through a pty: answer the cursor-position
query and prompts, surface the one-time device code, then wait for the
user to authorize in the browser."""
import os, pty, re, select, subprocess, sys, time

LOG = open("/root/gh_drive.log", "wb")
cmd = ["gh", "auth", "login", "--hostname", "github.com",
       "--git-protocol", "https", "--scopes", "repo", "--web"]

master, slave = pty.openpty()
p = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)

buf = b""
answered_auth = False
sent_enter = False
code_file = "/root/gh_device_code.txt"
deadline = time.time() + 600  # 10 min for user to authorize

while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 1.0)
    if not r:
        continue
    try:
        data = os.read(master, 4096)
    except OSError:
        break
    if not data:
        break
    buf += data
    LOG.write(data)
    LOG.flush()

    # survey/promptui cursor-position query -> respond with row 1, col 1
    if b"\x1b[6n" in data:
        os.write(master, b"\x1b[1;1R")

    # "Authenticate Git with your GitHub credentials? (Y/n)"
    if not answered_auth and b"Authenticate Git with your GitHub credentials?" in buf:
        time.sleep(0.3)
        os.write(master, b"Y\n")
        answered_auth = True

    # surface the one-time code
    m = re.search(rb"one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})", buf)
    if m and not os.path.exists(code_file):
        with open(code_file, "w") as f:
            f.write(m.group(1).decode())
        sys.stderr.write("DEVICE_CODE=%s\n" % m.group(1).decode())
        sys.stderr.flush()

    # "Press Enter to open github.com in your browser..."
    if not sent_enter and b"Press Enter to open" in buf:
        time.sleep(0.3)
        os.write(master, b"\n")
        sent_enter = True

    if b"Logged in as" in buf or b"authentication complete" in buf.lower():
        break

try:
    p.wait(timeout=5)
except Exception:
    p.kill()
LOG.close()
sys.stderr.write("EXIT=%s\n" % p.returncode)
```

可调参数：`LOG` / `code_file` 路径、`deadline`（授权等待上限，设备码本身约 15 分钟过期）、
`--scopes`（推送只需 `repo`）。

## 流程分解

| 步 | 脚本行为 | 对应 gh 界面 |
|---|---|---|
| 1 | `pty.openpty()` + `Popen` 起 `gh auth login --web --scopes repo` | 进入设备码流 |
| 2 | 见 `ESC[6n` 就回 `ESC[1;1R` | **不答就挂起的那一步** |
| 3 | 匹配到 "Authenticate Git with your GitHub credentials?" 送 `Y\n` | 让 gh 自动写 `~/.gitconfig` 的 credential helper（否则 push 仍要手输） |
| 4 | 正则抓 `one-time code: XXXX-XXXX`，落盘 + stderr | 设备码（剪贴板不可用仅 warn） |
| 5 | 见 "Press Enter to open..." 送 `\n` | 尝试开浏览器，无头仅 warn |
| 6 | 循环读到 "Logged in as" 或超时退出 | gh 后台轮询授权状态 |

## 使用步骤（本次实测顺序）

1. **装 gh**（Debian 12 arm64，直接下 release 二进制，免配 apt 源）：

   ```bash
   curl -sL -o gh.tar.gz \
     "https://github.com/cli/cli/releases/download/v2.103.0/gh_2.103.0_linux_arm64.tar.gz"
   tar xzf gh.tar.gz && cp gh_2.103.0_linux_arm64/bin/gh /usr/local/bin/gh
   ```

2. **后台跑驱动脚本**：`python3 gh_drive.py &`（注意：外层包一层 `&` 的启动命令会立即
   "结束"，python 进程变孤儿继续跑，属预期）。
3. **取码授权**：从 `/root/gh_device_code.txt` 或 stderr 拿设备码，用户在**自己的浏览器**
   开 `https://github.com/login/device` 输入并 Authorize（DSH 内置浏览器不可用时同理）。
4. **哨兵检测完成**（后台任务，授权即返回）：

   ```bash
   timeout 600 bash -c 'while ! gh auth status >/dev/null 2>&1; do sleep 2; done'
   ```

5. **验收**（见下）。

## 验收命令

```bash
gh auth status                                    # 已登录 + scopes 含 repo
git config --list --show-origin | grep 'credential.https://github.com.helper=!'
printf "protocol=https\nhost=github.com\n\n" | git credential fill   # 返回 username+token
git push --dry-run origin main                    # Everything up-to-date
gh api repos/xixjohan/mediary-scout --jq '{push: .permissions.push, admin: .permissions.admin}'
git status --porcelain | wc -l                    # 0 = 工作区未动
```

## 坑

1. **光标查询不答就挂起**：`ESC[6n` → 必回 `ESC[1;1R`，这是整个方案成立的前提。
2. **要答两个确认点**，不止一个 Enter："Authenticate Git…(Y/n)" 答 `Y`（否则
   credential helper 不自动配置），"Press Enter to open…" 送 `\n`。只送一次 Enter 不够。
3. **查 helper 别查错键名**：gh 写的是 URL 作用域形式
   `credential.https://github.com.helper`（在 `~/.gitconfig`），不是通用 `credential.helper`；
   用 `git config --list --show-origin | grep credential` 查全。
4. **`git -c credential.helper=` 是坑不是测试**：空值会清掉整条 helper 链（含 URL 作用域
   那条），导致 `could not read Username`——别用它来"验证"。
5. **dry-run 通 ≠ 鉴权通**：公开仓库匿名 `ls-remote` 也能让 dry-run 报 up-to-date。
   验凭据要用 `git credential fill`（确实返回 token）+ `gh api … --jq .permissions`
   （确实有 push 权限）。
6. **token 存储**：gh 默认明文存 `/root/.config/gh/hosts.yml`（权限 600），属 gh 标准行为。
7. **scope**：`--scopes repo` 足够推送；gh 默认还会附带 `gist`、`read:org`、`workflow`。
8. **僵尸进程**：`kill` 外层 `script` 后可能留 `[script] <defunct>`，无害，勿反复追杀。
9. **协议选择**：agent 环境通常没有 SSH key，`--git-protocol https` + 设备码是最短路径；
   用户最初可能给的是 SSH 地址，公开仓库直接用 HTTPS 克隆即可，内容一致。

## 备选方案（本次未用）

- **PAT + `gh auth login --with-token`**：用户建 fine-grained token（对目标仓库
  `Contents: write`），省掉设备码交互；适合无法开浏览器的场景。
- **SSH key**：生成密钥对后需用户手动把公钥加到 GitHub 账号，之后 `git remote set-url`
  改回 SSH 地址。适合长期推送。

## 参考

- gh 官方文档：`gh auth login` / device code flow（cli/cli README 与 man page）
- GitHub Device Activation 文档：https://docs.github.com/en/authentication/securing-your-account/keeping-your-account-and-data-secure/about-device-activation
