#!/bin/sh
# 起一个「真实产品配置」的本地实例：真 TMDB 搜索、真 115/quark/guangya 存储、
# pansou 工作流、vercel-ai agent。与桌面端启动器同一组适配器默认值。
#
# 为什么存在（2026-10-27）：本地实例此前是手抄适配器值起的，而且抄错了——抄成
# dev/e2e 那套 fake + demo。搜索因此只在 3 条硬编码样本里匹配，用户搜「奥特曼」
# 得到「没有匹配结果」，看起来像功能坏了，其实是配置抄错；而 demo 模式连「搜不到」
# 和「没配搜索」都分不出来。真相其实一直在一个文件里：桌面端启动器
# apps/desktop/src/server-launch.ts 的 buildServerEnv（容器 docker-compose 同值）。
#
# 所以这里不自己声明「我用真实配置」——那样它说了算，迟早又漂移——而是让
# apps/desktop/tests/server-launch.test.ts 拿下面的默认值跟 buildServerEnv 逐项
# 比对。任何一侧改了另一侧没改，那条测试就红。
#
# 用法：
#   ./scripts/run-local-real.sh              # 起在 3001，库在 run/mediary.db
#   MEDIARY_PORT=3100 ./scripts/run-local-real.sh
#   MEDIARY_STORAGE_ADAPTER=fake ./scripts/run-local-real.sh   # 开发时强制假存储
#   ./scripts/run-local-real.sh --stop       # 停掉（按 PID 文件，不按端口猜）
#
# 覆盖单个适配器用环境变量即可，默认值会被 parity 测试钉住。注意 agent=vercel-ai
# 在 storage=115 或 workflow=pansou 时是 validateRuntimeConfig 的硬要求，改成
# fake 会直接拒启（那是有意的：fake 会让 worker 永远排不干队列，且是静默的）。
set -eu

# Repo root = 脚本的上级目录。用 dirname 而非 $(git rev-parse --show-toplevel)，
# 这样在非 git 的源码树里也能跑；与 scripts/deploy.sh 同一约定。
cd "$(dirname "$0")/.."
# 之后会 cd 进 apps/web 起 next，所以先把绝对根路径固定下来——否则 $LOG/$PID_FILE
# 这类相对路径会被解析成 apps/run/...（踩过：日志和 pid 文件写丢，而 next 的报错
# 还指向另一个目录，排查半天）。
ROOT="$(pwd)"

PORT="${MEDIARY_PORT:-3001}"
DATA_DIR="${MEDIARY_DATA_DIR:-run}"
DB="$ROOT/$DATA_DIR/mediary.db"
LOG="$ROOT/${MEDIARY_LOG:-$DATA_DIR/server.log}"
PID_FILE="$ROOT/$DATA_DIR/server.pid"

# ---- 适配器默认值（与 apps/desktop/src/server-launch.ts 保持一致，测试盯着）----
MEDIA_TRACK_SEARCH_PROVIDER="${MEDIA_TRACK_SEARCH_PROVIDER:-tmdb}"
MEDIA_TRACK_WORKFLOW_ADAPTER="${MEDIA_TRACK_WORKFLOW_ADAPTER:-pansou}"
MEDIA_TRACK_STORAGE_ADAPTER="${MEDIA_TRACK_STORAGE_ADAPTER:-115}"
MEDIA_TRACK_AGENT_ADAPTER="${MEDIA_TRACK_AGENT_ADAPTER:-vercel-ai}"
# -------------------------------------------------------------------------------

mkdir -p "$DATA_DIR"

# 端口上是否已有服务在响应。
port_is_serving() {
  curl --noproxy '*' -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null
}

stop_server() {
  # 按**进程组**杀，不按单个 PID。踩过的坑：`npx next start` 的 $! 是 npm/npx
  # 包装进程的 PID，真正的 next-server 是它的子进程、且在另一个进程组里。于是
  # ① 杀的是包装进程（往往已经是僵尸，空操作）；② `kill -0` 对僵尸照样返回成功，
  # 「进程已死」的检测永远不触发。结果 --stop 停不掉服务，端口一直被占。
  #
  # 也不用 `pkill -f` 带端口号：那条命令的模式会匹配到脚本自己（自杀过）。
  # 不用 `pkill -f next`：会把同机其它 Next 实例（dev server、别的端口）一起杀。
  if [ -f "$PID_FILE" ]; then
    pgid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${pgid:-}" ]; then
      # 负号 = 整个进程组。setsid 保证这个组里只有我们起的这一棵树。
      if kill -0 "-$pgid" 2>/dev/null; then
        echo "停止旧实例 (进程组 $pgid)…"
        kill -TERM "-$pgid" 2>/dev/null || true
        # 只等 2 秒：实测 next-server 不响应 SIGTERM（v16.2.9），等满 5 秒只是白等，
        # 而每次重启都要付这个代价。SQLite 走 WAL，SIGKILL 不会损坏库。
        i=0
        while kill -0 "-$pgid" 2>/dev/null && [ "$i" -lt 20 ]; do
          sleep 0.1
          i=$((i + 1))
        done
        if kill -0 "-$pgid" 2>/dev/null; then
          echo "进程组 $pgid 不响应 SIGTERM，改发 SIGKILL" >&2
          kill -9 "-$pgid" 2>/dev/null || true
        fi
      fi
    fi
    rm -f "$PID_FILE"
  fi
  # 停完之后必须确认端口真的空了。没停干净就往下走，下一个 next start 会
  # EADDRINUSE，而健康检查会打到**旧**实例上——那是最坏的情况：看起来成功了。
  i=0
  while port_is_serving && [ "$i" -lt 30 ]; do
    sleep 0.2
    i=$((i + 1))
  done
  if port_is_serving; then
    echo "端口 $PORT 上仍有服务在响应，但我没有它的 PID 记录。" >&2
    echo "可能是别的实例或手工起的 next。请先手工停掉，再跑本脚本。" >&2
    exit 1
  fi
}

if [ "${1:-}" = "--stop" ]; then
  stop_server
  echo "已停止。日志留在 $LOG"
  exit 0
fi

# ---- 构建产物检查 ----
# next start 需要 .next；lib 层需要 packages/{shared,workflow}/dist。缺哪一个都起
# 不来，而报错信息（"Could not find a production build"）离根因很远，所以在这里先
# 讲清楚。不自动构建：构建要几十秒，静默跑长命令比明确告知更糟。
if [ ! -f apps/web/.next/BUILD_ID ]; then
  echo "缺少 apps/web/.next/BUILD_ID —— 先跑：npm run build:web" >&2
  exit 1
fi
if [ ! -f packages/workflow/dist/runtime-policy.js ]; then
  echo "缺少 packages/workflow/dist —— 先跑：npm run build:workflow" >&2
  exit 1
fi

stop_server

echo "启动真实配置实例：port=$PORT db=$DB"
echo "  search=$MEDIA_TRACK_SEARCH_PROVIDER workflow=$MEDIA_TRACK_WORKFLOW_ADAPTER"
echo "  storage=$MEDIA_TRACK_STORAGE_ADAPTER agent=$MEDIA_TRACK_AGENT_ADAPTER"

# JWT secret 不设也会自动生成并落库（getJwtSecret），所以这里不强制；显式设一个
# 只是为了让「换库重来」时旧 token 立即失效的行为可预期。
MEDIA_TRACK_JWT_SECRET="${MEDIA_TRACK_JWT_SECRET:-local-dev-secret-please-override-32b}"
export MEDIA_TRACK_JWT_SECRET
export MEDIA_TRACK_SEARCH_PROVIDER MEDIA_TRACK_WORKFLOW_ADAPTER
export MEDIA_TRACK_STORAGE_ADAPTER MEDIA_TRACK_AGENT_ADAPTER
export MEDIA_TRACK_SQLITE_PATH="$DB"
export MEDIA_TRACK_SINGLE_USER="${MEDIA_TRACK_SINGLE_USER:-true}"
export MEDIA_TRACK_WORKER_MODE="${MEDIA_TRACK_WORKER_MODE:-inprocess}"

cd apps/web
# setsid：让服务器跑在自己的进程组里，PID 文件记的是这个组的组 ID（= 首进程 PID），
#  stop_server 才能 `kill -TERM -<pgid>` 把整棵树（含真正的 next-server）带走。
#  记 $! 是不够的——那是 npx 包装进程，真正的 next-server 是它的子进程。
# --fork：setsid 只有在该进程本来就不是进程组长时才 fork；加了它保证一定新建组。
setsid npx next start -p "$PORT" >"$LOG" 2>&1 &
child=$!
# setsid --fork 的子进程 PID 与 $! 不同，得从进程组反查；组 ID 就是那个新会话首进程。
#  简单可靠的做法：等一瞬间，取以 $child 为父的、pgid 不等于自身的那个进程。
sleep 0.3
pgid=$(ps -o pgid= -p "$child" 2>/dev/null | tr -d ' ')
if [ -z "${pgid:-}" ] || [ "$pgid" = "$child" ]; then
  # 没拿到独立进程组就退化为记子进程自己（stop 仍可按单 PID 杀，只是杀不干净树）。
  pgid="$child"
fi
echo "$pgid" >"$PID_FILE"
cd "$ROOT"

# ---- 自验证：确认它真的起来了，而不是留一个后台僵尸 ----
# deploy.sh 的同一条教训：五连部署 silently 服务旧代码，因为「看起来启动了」是个
# 会说谎的信号。这里轮询 /api/health，超时就打日志并非零退出。
#
# 但光探测健康是不够的——曾经因此**假绿**：上一次的旧服务还占着端口，新进程启动
# 就失败了（端口占用），而健康检查打到旧实例上返回 200，脚本于是报告「已启动」。
# 所以循环里同时要求「我们起的进程组还活着」：健康 OK 但进程组没了 = 端口上有
# 别人的服务，这是失败，不是成功。
i=0
ready=0
while [ "$i" -lt 60 ]; do
  if ! kill -0 "-$pgid" 2>/dev/null; then
    # 进程组没了：要么启动即失败，要么端口被抢。两种情况都得看日志。
    break
  fi
  if port_is_serving; then
    ready=1
    break
  fi
  sleep 0.5
  i=$((i + 1))
done

if [ "$ready" != "1" ]; then
  echo "启动失败或超时。日志尾部：" >&2
  tail -20 "$LOG" >&2 || true
  # 失败时把可能残留的进程组收掉，别留孤儿占着端口。
  kill -9 "-$pgid" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

echo ""
echo "✓ 已启动 (进程组 $pgid)"
echo "  本机:   http://127.0.0.1:$PORT"
echo "  局域网: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
echo "  日志:   $LOG"
echo "  停止:   $0 --stop"
echo ""
echo "首次使用：未设访问密码时局域网零 friction 直通；要锁起来就"
echo "  curl --noproxy '*' -X POST http://127.0.0.1:$PORT/api/auth/password \\"
echo "    -H 'content-type: application/json' -d '{\"password\":\"...\"}'"
echo "（首次设密按设计只接受局域网请求。）"
echo ""
echo "注意：搜到片名后的「获取」需要网盘凭证 + 模型 key（设置页里配），"
echo "否则会因缺配置失败——这是产品设计，keyless 实例照样启动并空转。"
