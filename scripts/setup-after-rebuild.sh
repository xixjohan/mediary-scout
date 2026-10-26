#!/bin/sh
# 容器重建后的一条命令恢复：容器层的东西全丢（apt 装的系统库、Xvfb 进程、
# gh CLI 本身），/root 宿主卷上的东西都在（Electron 二进制、包装器、仓库、
# gh 登录态）。本脚本把丢的部分补齐。
#
# 用法：./scripts/setup-after-rebuild.sh
set -eu
cd "$(dirname "$0")/.."

echo "### 1/2 gh CLI";   ./scripts/setup-gh-cli.sh
echo; echo "### 2/2 内置浏览器"; ./scripts/setup-builtin-browser.sh
echo
echo "==> 恢复完成。"
