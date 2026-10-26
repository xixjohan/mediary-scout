#!/bin/sh
# 安装 gh CLI（容器层：重建后丢失，但 /root/.config/gh/hosts.yml 的登录态保留，
# 所以重装后无需重新登录）。幂等：gh 已可用则直接跳过。
#
# 用法：./scripts/setup-gh-cli.sh
set -eu

say() { printf '  %s\n' "$1"; }
ok()  { printf '  ✅ %s\n' "$1"; }

echo "==> gh CLI"
if command -v gh >/dev/null 2>&1 && gh --version >/dev/null 2>&1; then
  ok "已安装（$(gh --version | head -1)）"
else
  # Debian 官方源没有 gh，从 GitHub Releases 取官方 .deb。
  case "$(uname -m)" in
    x86_64)  ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "  ✗ 不支持的架构: $(uname -m)"; exit 1 ;;
  esac
  say "查询最新版本…"
  VER="$(curl -fsSL --max-time 30 https://api.github.com/repos/cli/cli/releases/latest \
        | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$VER" ] || { echo "  ✗ 取不到版本号（网络？）"; exit 1; }
  DEB="gh_${VER}_linux_${ARCH}.deb"
  say "下载 $DEB…"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT INT TERM
  curl -fsSL --max-time 300 -o "$TMP/$DEB" \
    "https://github.com/cli/cli/releases/download/v${VER}/${DEB}" \
    || { echo "  ✗ 下载失败"; exit 1; }
  say "apt-get install ./$DEB …"
  apt-get install -y "$TMP/$DEB" >/dev/null 2>&1 || {
    say "首次安装失败，先 apt-get update 再重试…"
    apt-get update >/dev/null 2>&1 || true
    apt-get install -y "$TMP/$DEB" >/dev/null 2>&1 || {
      echo "  ✗ 安装失败（需要 root 与网络）"; exit 1; }
  }
  ok "已安装 $(gh --version | head -1)"
fi

# 登录态在 /root（宿主卷）里，重建不丢；丢了这里会明确说出来。
if gh auth status >/dev/null 2>&1; then
  ok "已登录：$(gh api user --jq .login 2>/dev/null || echo '?')"
else
  echo "  ⚠ 未登录（/root/.config/gh 里的登录态没跟上）——按 docs/research/2026-10-23-gh-cli-headless-login.md 重新授权"
fi
