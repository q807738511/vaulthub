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
for name in Dockerfile docker-compose.yml .env vaulthub.env .dockerignore Caddyfile index.html caddy vaulthub-manager README.md SHA256SUMS data; do
  if [ -e "$BACKUP_DIR/$name" ]; then
    rm -rf "$TARGET_DIR/$name"
    cp -a "$BACKUP_DIR/$name" "$TARGET_DIR/$name"
  fi
done
if [ -f "$TARGET_DIR/caddy" ]; then chmod +x "$TARGET_DIR/caddy"; fi
if [ -f "$TARGET_DIR/vaulthub-manager" ]; then chmod +x "$TARGET_DIR/vaulthub-manager"; fi

echo "Starting restored Compose service ..."
(cd "$TARGET_DIR" && docker compose up -d --build)

echo "Rollback complete from: $BACKUP_DIR"
