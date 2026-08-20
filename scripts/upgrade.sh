#!/usr/bin/env sh
set -eu

TARGET_DIR="${1:-/vol1/1000/Docker/vaulthub}"
LEGACY_DIR="/vol1/1000/Docker/hermes/data/docker-webui-container"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
FILES_DIR="$PROJECT_DIR"
VERSION="v0.6.4"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$FILES_DIR" ]; then
  echo "ERROR: project directory not found: $FILES_DIR" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker command not found" >&2
  exit 1
fi

if [ ! -d "$TARGET_DIR" ] && [ -d "$LEGACY_DIR" ]; then
  echo "Target does not exist; using legacy directory: $LEGACY_DIR"
  TARGET_DIR="$LEGACY_DIR"
fi

mkdir -p "$TARGET_DIR"
BACKUP_DIR="${TARGET_DIR}.backup-${STAMP}"

if [ -f "$TARGET_DIR/docker-compose.yml" ]; then
  echo "Stopping existing Compose service in $TARGET_DIR ..."
  (cd "$TARGET_DIR" && docker compose down) || true
fi

# 清理孤立同名容器，避免 container_name 冲突。
if docker ps -a --format '{{.Names}}' | grep -qx 'VaultHub'; then
  echo "Removing orphan container VaultHub ..."
  docker rm -f VaultHub || true
fi

echo "Creating backup: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
for name in Dockerfile docker-compose.yml .env .dockerignore Caddyfile index.html caddy vaulthub-manager README.md SHA256SUMS data; do
  if [ -e "$TARGET_DIR/$name" ]; then
    cp -a "$TARGET_DIR/$name" "$BACKUP_DIR/"
  fi
done

echo "Installing VaultHub $VERSION files ..."
for name in Dockerfile docker-compose.yml .dockerignore Caddyfile index.html caddy vaulthub-manager README.md; do
  cp -a "$FILES_DIR/$name" "$TARGET_DIR/$name"
done
chmod +x "$TARGET_DIR/caddy" "$TARGET_DIR/vaulthub-manager"

if [ ! -f "$TARGET_DIR/.env" ]; then
  cp -a "$FILES_DIR/.env.example" "$TARGET_DIR/.env"
  echo "Created default .env"
else
  if ! grep -q '^ADMIN_TOKEN=' "$TARGET_DIR/.env"; then
    printf '\nADMIN_TOKEN=\n' >> "$TARGET_DIR/.env"
  fi
  echo "Keeping existing .env"
fi

mkdir -p "$TARGET_DIR/data"
if [ ! -f "$TARGET_DIR/data/Caddyfile" ]; then
  cp -a "$TARGET_DIR/Caddyfile" "$TARGET_DIR/data/Caddyfile"
fi

(
  cd "$TARGET_DIR"
  sha256sum Dockerfile docker-compose.yml .env .dockerignore caddy vaulthub-manager Caddyfile index.html README.md > SHA256SUMS
)

echo "Building and starting VaultHub ..."
(cd "$TARGET_DIR" && docker compose up -d --build)

echo "Upgrade complete: $VERSION"
echo "Backup directory: $BACKUP_DIR"
echo "Verify: curl http://127.0.0.1:8088/healthz"
