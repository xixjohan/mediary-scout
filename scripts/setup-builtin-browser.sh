#!/bin/sh
# 一键配置 DSH 内置浏览器（Electron）——幂等，可重复运行。
#
# 背景：dsh-builtin-browser 只在它自己的 profile 里找 Electron 二进制；本容器的
# profile（/root/.dsh/profiles/web/node_modules/electron，v44.7.0）最初只有包壳。
# 补上二进制后还撞了两个容器特有两道墙：以 root 运行被 Chromium 拒绝、无显示器。
#
# 持久性（2026-10-27 实测）：
#   /root 是宿主卷（/dev/sda1 on /root）→ Electron 二进制与本脚本写的包装器
#   **跨容器重建保留**；apt 装的 libgtk-3-0 与 Xvfb 进程在容器层 → 重建后必须
#   重跑本脚本（它会把缺的部分补齐，已在的部分不动）。
#
# 用法：./scripts/setup-builtin-browser.sh
set -eu

PROFILE="${DSH_PROFILE_DIR:-/root/.dsh/profiles/web}"
ELECTRON_PKG="$PROFILE/node_modules/electron"
DIST="$ELECTRON_PKG/dist"
REAL="$DIST/electron.real"
WRAPPER="$DIST/electron"
XVFB_DISPLAY="${DSH_XVFB_DISPLAY:-:99}"

say() { printf '  %s\n' "$1"; }
ok()  { printf '  ✅ %s\n' "$1"; }

echo "==> [1/4] Electron 二进制（profile: $ELECTRON_PKG）"
if [ ! -d "$ELECTRON_PKG" ]; then
  echo "  ✗ 未找到 profile 的 electron 包——先在 web profile 里装 dsh-builtin-browser 插件"; exit 1
fi
if [ -x "$REAL" ]; then
  ok "真二进制已在（$(du -h "$REAL" | cut -f1)）"
elif [ -x "$WRAPPER" ]; then
  # 还没有包装化：把现有二进制改名成 .real
  mv "$WRAPPER" "$REAL"; ok "现有二进制已改名 electron.real"
else
  say "下载中（node install.js，约 220MB）…"
  (cd "$ELECTRON_PKG" && node install.js)
  ok "已下载并安装"
fi

echo "==> [2/4] 运行时依赖（ldd 驱动：缺哪个.so 装哪个包；容器层，重建后必补）"
# .so → Debian 包名。用 ldd 实测而非写死清单——重建后基础镜像变了，缺的可能
# 不止一两个（2026-10-27 重建后就少了 libgbm/libasound，上一次只有 libgtk-3）。
lib_to_pkg() {
  case "$1" in
    libgtk-3.so.0)        echo "libgtk-3-0" ;;
    libgbm.so.1)          echo "libgbm1" ;;
    libasound.so.2)       echo "libasound2" ;;
    libnss3.so)           echo "libnss3" ;;
    libatk-1.0.so.0)      echo "libatk1.0-0" ;;
    libatk-bridge-2.0.so.0) echo "libatk-bridge2.0-0" ;;
    libatspi.so.0)        echo "libatspi2.0-0" ;;
    libcups.so.2)         echo "libcups2" ;;
    libxkbcommon.so.0)    echo "libxkbcommon0" ;;
    libpango-1.0.so.0)    echo "libpango-1.0-0" ;;
    libcairo.so.2)        echo "libcairo2" ;;
    libdrm.so.2)          echo "libdrm2" ;;
    libXcomposite.so.1)   echo "libxcomposite1" ;;
    libXdamage.so.1)      echo "libxdamage1" ;;
    libXfixes.so.3)       echo "libxfixes3" ;;
    libXrandr.so.2)       echo "libxrandr2" ;;
    *)                    echo "" ;;
  esac
}
NEED_APT=""
for so in $(ldd "$REAL" 2>/dev/null | grep "not found" | awk '{print $1}' | sort -u); do
  pkg=$(lib_to_pkg "$so")
  [ -n "$pkg" ] && case " $NEED_APT " in *" $pkg "*) ;; *) NEED_APT="$NEED_APT $pkg" ;; esac
done
command -v Xvfb >/dev/null 2>&1 || NEED_APT="$NEED_APT xvfb"
if [ -z "$(echo $NEED_APT)" ]; then
  ok "运行时依赖齐全（ldd 无缺失，Xvfb 在位）"
else
  say "apt-get install -y$NEED_APT …"
  apt-get install -y $NEED_APT >/dev/null 2>&1 || {
    say "首次安装失败，先 apt-get update 再重试…"
    apt-get update >/dev/null 2>&1 || true
    apt-get install -y $NEED_APT >/dev/null 2>&1 || {
      echo "  ✗ apt 安装失败（需要 root 与网络）"; exit 1; }
  }
  ok "已安装：$NEED_APT"
fi

echo "==> [3/4] root/无显示器包装器（--no-sandbox + DISPLAY）"
NEED_WRAP=1
if [ -f "$WRAPPER" ] && head -1 "$WRAPPER" | grep -q '^#!'; then
  grep -q "no-sandbox" "$WRAPPER" && NEED_WRAP=0
fi
if [ "$NEED_WRAP" = "1" ]; then
  cat > "$WRAPPER" <<EOF
#!/bin/sh
# 由 scripts/setup-builtin-browser.sh 生成（2026-10-27）。
# 容器内以 root 运行：Chromium 拒绝无 --no-sandbox 启动；且无显示器，
# 故指向本机 Xvfb $XVFB_DISPLAY。删掉本文件、把 electron.real 改名回 electron
# 即可还原。
export DISPLAY="${DSH_XVFB_DISPLAY:-:99}"
exec "\$(dirname "\$0")/electron.real" --no-sandbox "\$@"
EOF
  chmod +x "$WRAPPER"
  ok "已写入 $WRAPPER"
else
  ok "已存在且正确"
fi

echo "==> [4/4] Xvfb 虚拟显示器 $XVFB_DISPLAY"
XVFB_SOCK="/tmp/.X11-unix/X${XVFB_DISPLAY#:}"
if pgrep -x Xvfb >/dev/null 2>&1 && [ -S "$XVFB_SOCK" ]; then
  ok "Xvfb 已在运行"
else
  say "启动 Xvfb …"
  # 清掉可能残留的锁（上次异常退出留下的），否则 Xvfb 以 "already active" 拒绝启动
  rm -f "/tmp/.X${XVFB_DISPLAY#:}-lock" "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" 2>/dev/null || true
  Xvfb "$XVFB_DISPLAY" -screen 0 1400x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  sleep 2
  [ -S "$XVFB_SOCK" ] && ok "已启动（socket $XVFB_SOCK）" || { echo "  ✗ Xvfb 启动失败"; tail -3 /tmp/xvfb.log 2>/dev/null; exit 1; }
fi

echo "==> 自检：真实启动一个 Electron 窗口并退出"
cat > /tmp/dsh-browser-selftest.js <<'EOF'
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 800, height: 600, show: false });
  w.loadURL('data:text/html,<h1>ok</h1>');
  setTimeout(() => { console.log('ELECTRON_BOOT_OK'); app.exit(0); }, 1200);
});
EOF
if DISPLAY="$XVFB_DISPLAY" timeout 40 "$WRAPPER" /tmp/dsh-browser-selftest.js 2>/dev/null | grep -q ELECTRON_BOOT_OK; then
  ok "Electron 可启动并可创建窗口"
else
  echo "  ✗ 自检未通过"; exit 1
fi
rm -f /tmp/dsh-browser-selftest.js
echo "==> 全部就绪：内置浏览器可用。"
