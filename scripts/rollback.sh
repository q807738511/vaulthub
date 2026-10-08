#!/usr/bin/env sh
set -eu

TARGET_DIR="${1:-/srv/vaulthub}"
BACKUP_DIR="${2:-}"

if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR=$(ls -dt "${TARGET_DIR}".backup-* 2>/dev/null | head -n 1 || true)
fi

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: backup directory not found. Usage: ./rollback.sh [target_dir] [backup_dir]" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker command not found" >&2
  exit 1
fi

if [ -f "$TARGET_DIR/docker-compose.yml" ]; then
  echo "Stopping current Compose service in $TARGET_DIR ..."
  (cd "$TARGET_DIR" && docker compose down) || true
fi

echo "Restoring backup: $BACKUP_DIR"
mkdir -p "$TARGET_DIR"
# v0.8.7: vaulthub.env is part of the deployment set (compose loads it via
# env_file), so it must be restored together with the rest — upgrade.sh backs it up.
# v0.9.56: README.md 拆分出 Update Log.md，两者都在备份集合内。
for name in Dockerfile docker-compose.yml .env vaulthub.env .dockerignore Caddyfile index.html caddy vaulthub-manager README.md "Update Log.md" SHA256SUMS data; do
  if [ -e "$BACKUP_DIR/$name" ]; then
    rm -rf "$TARGET_DIR/$name"
    cp -a "$BACKUP_DIR/$name" "$TARGET_DIR/$name"
  fi
done
if [ -f "$TARGET_DIR/caddy" ]; then chmod +x "$TARGET_DIR/caddy"; fi
if [ -f "$TARGET_DIR/vaulthub-manager" ]; then chmod +x "$TARGET_DIR/vaulthub-manager"; fi

# v0.9.95（安全审查 M2）：回滚不该只依赖「当前 :latest」，也不能在回滚时去拉远端 tag。
# 支持显式指定要回滚到的镜像：ROLLBACK_IMAGE=vaulthub:prod-0.9.94 scripts/rollback.sh
# 未指定时沿用当前 :latest，但会先把它的身份读出来打日志（方便事后核对回的是哪一份）。
if [ -n "${ROLLBACK_IMAGE:-}" ]; then
  if ! docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    echo "ERROR: 回滚目标镜像 $ROLLBACK_IMAGE 在本机不存在（可能被 docker image prune 清掉了）" >&2
    exit 1
  fi
  echo "回滚目标镜像（显式指定）：$ROLLBACK_IMAGE"
  docker tag "$ROLLBACK_IMAGE" q807738511/vaulthub:latest
else
  echo "回滚目标镜像（当前 :latest）：$(docker image inspect --format '{{.Id}}' q807738511/vaulthub:latest 2>/dev/null || echo '读不到')"
fi

echo "Starting restored Compose service ..."
# v0.9.93：回滚必须用「本地已固定的那个镜像」，绝不能在回滚时按 tag 去拉新镜像，
# 否则回滚会被远端 tag 直接覆盖（compose 里没有 build: 段，--build 也早已无意义）。
(cd "$TARGET_DIR" && docker compose up -d --force-recreate --pull never)

echo "Rollback complete from: $BACKUP_DIR"
