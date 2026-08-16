#!/usr/bin/env sh
set -eu

TARGET_DIR="${1:-/vol1/1000/Docker/vaulthub}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
FILES_DIR="$PROJECT_DIR"
VERSION="v0.6.0"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$FILES_DIR" ]; then
  echo "ERROR: project directory not found: $FILES_DIR" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker command not found" >&2
  exit 1
fi

echo "=================================================="
echo "  VaultHub 蜀鼠之家 $VERSION 全新安装"
echo "=================================================="

# 1. 清理所有旧容器（无论旧版叫 docker-webui 还是新版 VaultHub）
echo ""
echo "[1/5] 清理旧容器 ..."
for cname in VaultHub docker-webui vaulthub docker_webui; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$cname"; then
    echo "      移除容器: $cname"
    docker rm -f "$cname" || true
  fi
done

# 2. 清理占用 8088 端口的容器（关键：旧版 docker-webui 可能仍占着 8088）
echo ""
echo "[2/5] 检查 8088 端口占用 ..."
PORT_BUSY=""
for cid in $(docker ps -q); do
  if docker port "$cid" 2>/dev/null | grep -q ':8088'; then
    cname=$(docker inspect --format '{{.Name}}' "$cid" | sed 's#^/##')
    echo "      端口 8088 被容器占用: $cname"
    docker rm -f "$cname" || true
    PORT_BUSY="1"
  fi
done
[ -z "$PORT_BUSY" ] && echo "      端口 8088 空闲"

# 3. 安装文件
echo ""
echo "[3/5] 安装文件到 $TARGET_DIR ..."
mkdir -p "$TARGET_DIR"
for name in Dockerfile docker-compose.yml .dockerignore Caddyfile index.html caddy vaulthub-manager README.md; do
  cp -a "$FILES_DIR/$name" "$TARGET_DIR/$name"
done
chmod +x "$TARGET_DIR/caddy" "$TARGET_DIR/vaulthub-manager"

if [ ! -f "$TARGET_DIR/.env" ]; then
  cp -a "$FILES_DIR/.env.example" "$TARGET_DIR/.env"
  echo "      创建默认 .env"
else
  if ! grep -q '^ADMIN_TOKEN=' "$TARGET_DIR/.env"; then
    printf '\nADMIN_TOKEN=\n' >> "$TARGET_DIR/.env"
  fi
  echo "      保留现有 .env"
fi

mkdir -p "$TARGET_DIR/data"
if [ ! -f "$TARGET_DIR/data/Caddyfile" ]; then
  cp -a "$TARGET_DIR/Caddyfile" "$TARGET_DIR/data/Caddyfile"
  echo "      初始化 data/Caddyfile"
fi

# 4. 构建并启动
echo ""
echo "[4/5] 构建并启动 ..."
(cd "$TARGET_DIR" && docker compose up -d --build)

# 5. 验证
echo ""
echo "[5/5] 验证 ..."
sleep 2
if curl -s http://127.0.0.1:8088/healthz 2>/dev/null | grep -q ok; then
  echo "      ✅ 安装成功！"
  echo ""
  echo "      当前容器："
  docker ps --filter name=VaultHub --format '        {{.Names}}  {{.Image}}  {{.Ports}}'
  echo ""
  echo "      访问：http://192.168.112.3:8088"
else
  echo "      ⚠️ 健康检查未通过，最近日志："
  docker logs VaultHub 2>&1 | tail -20 || true
  exit 1
fi
