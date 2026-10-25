#!/bin/sh
# Back up the compose SQLite database to a timestamped file on the host.
# Usage (repo root): ./scripts/sqlite-backup.sh [output-dir]
# 纯 SQLite 单引擎（任务单 S1.4b）：VACUUM INTO 在 web 容器内生成一致性快照
# （WAL 模式下等价于 pg_dump 的正确性），写到 stdout 由宿主落盘。
set -eu
cd "$(dirname "$0")/.."
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/mediatrack-${STAMP}.db.gz"
# Template must end with X… (BSD/macOS mktemp requirement).
TMP="$(mktemp "${OUT_DIR}/mediatrack-${STAMP}.db.XXXXXX")"
trap 'rm -f "$TMP"' EXIT INT TERM
echo "==> SQLite 热备份 → $FILE"
# Avoid pipe status masking: copy to temp first, then gzip (a failed backup aborts).
docker compose exec -T web node -e "const D=require('better-sqlite3');const fs=require('fs');const d=new D(process.env.MEDIA_TRACK_SQLITE_PATH||'/app/data/mediary.db');d.exec(\"VACUUM INTO '/tmp/mediary-backup.db'\");d.close();process.stdout.write(fs.readFileSync('/tmp/mediary-backup.db'))" > "$TMP"
gzip -c "$TMP" > "$FILE"
echo "==> OK ($(wc -c < "$FILE") bytes)"
echo "Restore: 停掉 web 后 gunzip -c \"$FILE\" > data/mediary.db（或 docker compose cp 进 mediaray-data 卷）再启动"
