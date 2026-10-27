#!/bin/sh
# Reliable, SELF-VERIFYING self-host redeploy (single-image mode): fetch tags, pin the
# newest release tag, pull its published image, restart the stack, then PROVE the running
# container actually serves that tag's commit.
#
# Why this exists (2026-07-04 #88–#98): five deploys in a row silently kept serving OLD
# code — the box ran a stale image for a whole day before anyone noticed. The failure
# was invisible because the usual signals lie: host `git rev-parse HEAD` shows the new
# commit even when the container runs an old image, and watching the image hash is noisy
# (a fresh `--no-cache` build changes the hash purely from build non-determinism). So the
# real fix isn't a cache trick — it's a check: this script compares the RUNNING
# container's stamped commit (BUILD_COMMIT) against the tag's commit and exits non-zero
# on mismatch, which catches a stale image, a no-op fetch, or a container that wasn't
# recreated.
#
# 单镜像模式（2026-10-26）：web/worker 不再本地构建，而是拉取 Release Docker 为发布
# 标签推送的 GHCR 镜像。部署因此跟「最新的发布标签」而不是 mediary 分支的尖端——想部署任意
# commit 请自行 `docker build` 并用 MEDIARY_IMAGE 指向本地镜像。
#
# Usage (on the host, in the repo dir):   ./scripts/deploy.sh [extra `up` args]
set -eu

# Repo root = the script's parent dir. Plain dirname (no `--`, no `cd --`) for
# portability across /bin/sh implementations (busybox ash, dash, bash).
cd "$(dirname "$0")/.."

# Take the same repository lock the updater's run-update.sh takes, so a one-click update and
# this manual deploy never pull/checkout/swap the same repo and compose project at once. The
# lock is a git/docker-ignored file at the repo root; the updater sees the same inode through
# its bind mount, and flock is an inode-level advisory lock the kernel shares across the two.
# The updater only holds it during a normal update, not during its own recovery, so a deploy
# meant to fix a broken state is never blocked. Held via fd 9 for this whole script.
# flock is on Linux hosts (util-linux) and the updater's Alpine image; absent on macOS, where
# `command -v flock` skips it (the deployment box is Linux). Non-blocking: refuse, don't hang.
if command -v flock >/dev/null 2>&1; then
  LOCK=".update.lock"
  [ -e "$LOCK" ] || (umask 000; : > "$LOCK") 2>/dev/null || true
  exec 9>>"$LOCK"
  if ! flock -n 9; then
    echo "==> 一键更新正在进行，请等它结束后再运行本脚本（或在设置→更新里查看进度）。"
    exit 1
  fi
fi

echo "==> git fetch --tags"
git fetch --tags --quiet

# 最新的发布标签（vYYYY.MM.DD[.N]，与 apps/web/lib/release-version.ts 同一规则）。
TAG="$(git tag --list 'v*' --sort=-creatordate | head -n 1)"
[ -n "$TAG" ] || { echo "==> 没有找到任何 v* 发布标签——先打一个标签并等 Release Docker 发布完成。"; exit 1; }

echo "==> Deploying release tag ${TAG}"
# 切到该标签（detached，与 updater 留下的状态一致）。已在同一 commit 上时跳过，
# 免得无谓地动工作区。
if [ "$(git rev-parse HEAD)" != "$(git rev-parse -q --verify "refs/tags/${TAG}^{commit}")" ]; then
  git -c advice.detachedHead=false checkout "refs/tags/${TAG}"
fi
GIT_SHA="$(git rev-parse HEAD)"
export GIT_SHA

# 把镜像引用钉进 .env：compose 的 ${MEDIARY_IMAGE} 读它，后续 up/pull 都停在这个版本，
# 而不是被 :latest 悄悄覆盖。以文件属主身份写，避免 root 拥有的 .env 让用户改不动。
# 镜像基址默认由更新源推导，与 updater/run-update.sh、网页 feed 三者同源：
# 都指向当前仓库（fork 拉自己的 ghcr 镜像）。曾硬编码上游，设置页引导用户跑的
# 就是这段，会把别家镜像钉进 .env（第三轮复核的 medium）。MEDIA_IMAGE_BASE /
# MEDIA_TRACK_UPDATE_REPO 仍可分别覆盖。
# 与应用侧（release-feed-server.ts 的 updateRepoSlug）同一口径：env 去掉首尾空白，
# 纯空白视为「没设」而回落默认；否则 "   " 会拼出 ghcr.io/   这种地址。
_UPDATE_REPO_RAW="${MEDIA_TRACK_UPDATE_REPO:-}"
# 只去首尾空白（与应用侧 .trim() 同一口径）：纯空白 → 空 → 回落默认；
# 内部含空白的畸形值**原样透传**，让应用侧的正则校验去抛错（fail-loud），
# 而不是被 tr -d 静默修成一个合法 slug（第五轮复核：内部空白曾四处四种行为）。
_UPDATE_REPO=$(printf '%s' "$_UPDATE_REPO_RAW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
UPDATE_REPO="${_UPDATE_REPO:-xixjohan/mediary-scout}"
IMAGE="${MEDIA_IMAGE_BASE:-ghcr.io/${UPDATE_REPO}}:${TAG}"
if [ -f .env ] && grep -q '^MEDIARY_IMAGE=' .env; then
  sed -i "s|^MEDIARY_IMAGE=.*|MEDIARY_IMAGE=${IMAGE}|" .env
elif [ -f .env ]; then
  printf '%s\n' "MEDIARY_IMAGE=${IMAGE}" >> .env
else
  printf '%s\n' "MEDIARY_IMAGE=${IMAGE}" > .env
fi

echo "==> Pulling ${IMAGE}"
# 拉发布镜像。updater 仍本地构建（它不随应用发布，改了 updater/ 才需要重建）。
docker compose pull web worker
docker compose build updater

echo "==> Starting stack"
docker compose up -d "$@"

# Verify: the running container reports the commit of the tag we just deployed. This is the
# check that host `git rev-parse HEAD` CANNOT give you (a stale image outlives a fetched tag).
echo "==> Verifying running container commit"
# Retry rather than a fixed sleep: `up -d` returns before the container is
# exec-able, and slow hosts need longer — a flat `sleep 2` gives false negatives.
RUNNING=""
i=0
while [ "$i" -lt 15 ]; do
  RUNNING="$(docker compose exec -T web cat BUILD_COMMIT 2>/dev/null || true)"
  [ -n "$RUNNING" ] && break
  i=$((i + 1))
  sleep 1
done
[ -n "$RUNNING" ] || RUNNING='<no BUILD_COMMIT — image predates this fix; deploy a newer tag>'
echo "    expected (${TAG}):        ${GIT_SHA}"
echo "    running container:      ${RUNNING}"
if [ "${RUNNING}" = "${GIT_SHA}" ]; then
  echo "==> Verifying application readiness"
  i=0
  READY=0
  while [ "$i" -lt 60 ]; do
    if docker compose exec -T web node -e "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      READY=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$READY" = "1" ]; then
    echo "==> OK: container serves the ${TAG} image and passes the DB-backed health probe."
  else
    echo "==> WARNING: container commit matches the tag but /api/health never became ready."
    docker compose logs --tail=100 web || true
    exit 1
  fi
else
  echo "==> WARNING: running container commit != ${TAG}. The image may not have been"
  echo "    published yet (check the Release Docker run), or the container did not"
  echo "    recreate. Investigate before trusting it."
  exit 1
fi
