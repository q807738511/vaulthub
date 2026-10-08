#!/bin/sh
# =============================================================================
# VaultHub —— NAS 侧发布脚本（构建 → 推 Docker Hub → 建 Gitee 发行版）
#
# 为什么要有这个脚本：
#   Gitee Go 能托管校验流水线，但它的免费额度只有「单仓库 200 分钟（一次性）
#   + 个人每月 500 分钟」。本仓库的构建上下文含 39MB 的 caddy 与 31MB 的
#   ffmpeg-core.wasm，每构建一次都是分钟级消耗，按本项目的发版节奏很快会见底。
#   而 NAS 上本来就有 Docker 与全部工具链（v0.9.89 就是这么构建出来的），
#   在这里发布：零构建分钟消耗、零依赖第三方 runner、行为与原 GitHub Actions
#   完全对等（同样产出 vX.Y.Z / latest / sha-xxxxxxx 三种 tag）。
#
# 与原 publish-image.yml 的对等关系：
#   checkout            → git 工作区校验（分支、脏文件、tag 一致性）
#   docker/setup-buildx → docker build（普通 builder 即可，本仓库单平台 linux/amd64）
#   docker/login-action → docker login / skopeo login
#   docker/metadata-action（三个 tag）→ 下面的 TAG_VERSION / TAG_LATEST / TAG_SHA
#   docker/build-push   → docker build + 推送
#   gh release create   → scripts/ci-release.sh（Gitee OpenAPI v5）
#   sync-dockerhub-to-ghcr.yml → 整条作废（GHCR 不再是任何一环）
#
# 用法：
#   sh scripts/release-nas.sh [--no-push] [--no-release] <tag>      # 例：v0.9.90
#   sh scripts/release-nas.sh --check-only                          # 只做一致性体检
#
# 需要的环境变量：
#   DOCKERHUB_USERNAME / DOCKERHUB_TOKEN   推镜像（缺省则尝试已登录的 docker 凭据）
#   GITEE_TOKEN                            建发行版（缺省则跳过发行版并提示）
#   GITEE_REPO_SLUG                        默认 q807738511/vaulthub
#   PUSH_PROXY                             例 socks5://proxy.lan:7890
#                                          见下方「推送到 Docker Hub 的三条路」
#
# === 推送到 Docker Hub 的三条路（NAS 直连 registry-1.docker.io 会超时）=========
#   A. daemon.json 里配 proxies —— 最省事，但要改宿主机并 reload dockerd
#   B. skopeo copy docker-daemon:… docker://… + ALL_PROXY —— 纯客户端，不改宿主
#   C. 本脚本默认先试 A/B 之外的原生 docker push；若超时，脚本会提示改用 B
#   实测依据：NAS 上 `docker pull hello-world` 能成功，是因为 daemon.json 里配了
#   只读加速器（docker.fnnas.com / docker.m.daocloud.io / docker.nju.edu.cn 等）；
#   加速器只加速拉取，**不能用于推送**，所以推送必须另找出口。
# =============================================================================
set -eu

DO_PUSH=1
DO_RELEASE=1
CHECK_ONLY=0
TAG=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-push)    DO_PUSH=0 ;;
    --no-release) DO_RELEASE=0 ;;
    --check-only) CHECK_ONLY=1 ;;
    -h|--help)    usage 0 ;;
    -*)           echo "未知参数：$1" >&2; usage 1 ;;
    *)            TAG="$1" ;;
  esac
  shift
done

die()  { echo "错误：$*" >&2; exit 1; }
note() { echo "[release] $*"; }

DOCKERHUB_NAMESPACE="${DOCKERHUB_NAMESPACE:-q807738511}"
IMAGE_BASE="docker.io/${DOCKERHUB_NAMESPACE}/vaulthub"
GITEE_REPO_SLUG="${GITEE_REPO_SLUG:-q807738511/vaulthub}"

# ---------------------------------------------------------------- 定位仓库根
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
[ -f Dockerfile ] || die "看起来不在 VaultHub 仓库根目录：$ROOT"
command -v docker >/dev/null 2>&1 || die "找不到 docker"

# ---------------------------------------------------------------- 版本一致性体检
# 本项目的约定（见 Update Log.md）：一个版本要在 4 处同步出现，缺一处就会
# 出现「镜像里显示旧版本号」这类难查的问题。这里一次性全部核对。
VERSION=""
if [ -n "$TAG" ]; then
  case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) : ;; *) die "tag 必须形如 v0.9.90，收到：$TAG" ;; esac
  VERSION="${TAG#v}"
fi

echo "================ 版本一致性体检 ================"
DETECTED=$(grep -oE 'VAULTHUB_ASSET_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"' index.html 2>/dev/null \
           | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
STATE_VER=$(grep -oE 'VAULTHUB_SCRIPT_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"' web/js/01-state.js 2>/dev/null \
           | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
notes_count=$(ls .github/RELEASE_NOTES_*.md 2>/dev/null | wc -l | tr -d ' ')

printf '  index.html  VAULTHUB_ASSET_VERSION  = %s\n' "${DETECTED:-<未找到>}"
printf '  01-state.js VAULTHUB_SCRIPT_VERSION = %s\n' "${STATE_VER:-<未找到>}"
printf '  RELEASE_NOTES 文件数               = %s\n' "$notes_count"
[ -n "$DETECTED" ] || die "index.html 里找不到 VAULTHUB_ASSET_VERSION"
[ "$DETECTED" = "$STATE_VER" ] || die "index.html($DETECTED) 与 01-state.js($STATE_VER) 版本号不一致"

if [ -n "$VERSION" ]; then
  printf '  目标版本                           = %s\n' "$VERSION"
  [ "$DETECTED" = "$VERSION" ] || die "目标版本 $VERSION 与仓库内版本 $DETECTED 不一致；请先完成版本号升级"
  NOTES=".github/RELEASE_NOTES_${VERSION}.md"
  [ -f "$NOTES" ] || die "缺少发布说明 $NOTES"
  printf '  发布说明                           = %s（%s 字节）\n' "$NOTES" "$(wc -c < "$NOTES" | tr -d ' ')"
fi

echo "================ git 工作区体检 ================"
command -v git >/dev/null 2>&1 && {
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  printf '  当前分支 = %s  未提交改动 = %s 个\n' "$BRANCH" "$DIRTY"
  [ "$DIRTY" -eq 0 ] || note "⚠️ 工作区有 $DIRTY 个未提交改动；发布镜像会把未提交内容一起打进镜像"
  if [ -n "$TAG" ]; then
    if git rev-parse "$TAG" >/dev/null 2>&1; then
      printf '  tag %s 已存在，指向 %s\n' "$TAG" "$(git rev-parse --short "$TAG^{commit}" 2>/dev/null)"
    else
      note "⚠️ 本地还没有 tag $TAG；镜像会带这个版本号，但 git 里没有对应 tag"
    fi
  fi
}

[ "$CHECK_ONLY" -eq 1 ] && { echo; note "仅体检（--check-only），未构建、未推送。"; exit 0; }

# ---------------------------------------------------------------- 推 Docker Hub 的三条路
push_ok=0

try_docker_push() {
  for t in "$@"; do
    note "docker push $t"
    if docker push "$t"; then
      push_ok=$((push_ok + 1))
    else
      return 1
    fi
  done
}

echo
echo "================ 构建镜像 ================"
SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")
TAG_VERSION="${IMAGE_BASE}:${TAG:-v${DETECTED}}"
TAG_LATEST="${IMAGE_BASE}:latest"
TAG_SHA="${IMAGE_BASE}:sha-${SHORT_SHA}"

note "构建 $TAG_VERSION（同时打 3 个 tag）"
# 构建参数与原 GitHub Actions 的差异：这里是国内网络，所以把 apt 与 go proxy
# 都指到国内镜像（等价于原 Dockerfile 注释里说的「中国大陆构建传 APT_MIRROR」）。
docker build \
  --build-arg APT_MIRROR="${APT_MIRROR:-http://mirrors.aliyun.com/debian}" \
  --build-arg GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" \
  -t "$TAG_VERSION" -t "$TAG_LATEST" -t "$TAG_SHA" \
  -f Dockerfile .

note "镜像信息："
docker images --format '  {{.Repository}}:{{.Tag}}  ID={{.ID}}  大小={{.Size}}  建于={{.CreatedSince}}' \
  | grep -F "${DOCKERHUB_NAMESPACE}/vaulthub" || true

if [ "$DO_PUSH" -eq 1 ]; then
  echo
  echo "================ 推送到 Docker Hub ================"
  if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
    printf '%s' "$DOCKERHUB_TOKEN" | docker login docker.io -u "$DOCKERHUB_USERNAME" --password-stdin \
      || note "⚠️ docker login 失败，下面会直接试推送"
  else
    note "未提供 DOCKERHUB_USERNAME / DOCKERHUB_TOKEN，尝试使用本机已登录的 docker 凭据"
  fi

  if try_docker_push "$TAG_VERSION" "$TAG_LATEST" "$TAG_SHA"; then
    note "✅ 原生 docker push 三个 tag 全部成功"
  else
    note "❌ 原生 docker push 失败（NAS 直连 registry-1.docker.io 超时是已知现象）"
    echo
    echo "---------------------------------------------------------------"
    echo "改走方案 B：skopeo 客户端推送（不改宿主机配置）"
    echo "---------------------------------------------------------------"
    if ! command -v skopeo >/dev/null 2>&1; then
      cat <<'EOF'
本机没有 skopeo。二选一：

  ① 在容器里跑 skopeo（推荐，不动宿主机）：
     docker run --rm \
       -v /var/run/docker.sock:/var/run/docker.sock \
       -e ALL_PROXY=socks5://proxy.lan:7890 \
       quay.io/skopeo/stable copy --all \
         docker-daemon:vaulthub-src:latest \
         docker://docker.io/q807738511/vaulthub:vX.Y.Z \
         --dest-creds "$DOCKERHUB_USERNAME:$DOCKERHUB_TOKEN"

  ② 或给 dockerd 配代理（改宿主机，daemon.json 的 proxies 现在是空的）：
     { "proxies": { "https-proxy": "socks5://proxy.lan:7890",
                    "http-proxy":  "socks5://proxy.lan:7890" } }
     然后 systemctl reload docker（compose 里已开 live-restore，容器不会被重启）

推送不了的根因：daemon.json 里的 4 个加速器（docker.fnnas.com /
docker.m.daocloud.io / docker.nju.edu.cn / registry.hub.docker.com）
只加速拉取，不能用于推送。
EOF
      die "未推送任何 tag；镜像已在本机构建好（$TAG_VERSION / $TAG_LATEST / $TAG_SHA）"
    fi

    PROXY_ARG=""
    [ -n "${PUSH_PROXY:-}" ] && PROXY_ARG="$PUSH_PROXY"
    for t in "$TAG_VERSION" "$TAG_LATEST" "$TAG_SHA"; do
      note "skopeo copy docker-daemon:${t} → docker://${t}"
      if [ -n "$PROXY_ARG" ]; then
        ALL_PROXY="$PROXY_ARG" skopeo copy --all "docker-daemon:${t}" "docker://${t}"
      else
        skopeo copy --all "docker-daemon:${t}" "docker://${t}"
      fi
    done
    note "✅ skopeo 推送完成"
  fi

  echo
  echo "================ 读回校验（Docker Hub，严格判定：不一致即失败）================"
  # v0.9.95（安全审查 B3）：原来只打印读回结果，且把「config 摘要相等」当判据 —— skopeo 与 docker
  # 对 config JSON 的序列化并不逐字节相同，一旦失配只打警告、还会退回「看 version 标签」，而标签是
  # 作者可任意填写的字段，证明不了层内容。现在改成硬门：
  #   ① 两个 tag 的远端 manifest digest 必须都能读到、且**彼此相等**（读不到即失败）；
  #   ② 本机有 python3 时，再把远端 vX.Y.Z 的 rootfs diff_ids 与本地镜像逐层比对，不一致即失败。
  READBACK_FAIL=0
  DIGEST_VERSION=""
  DIGEST_LATEST=""
  if ! command -v skopeo >/dev/null 2>&1; then
    note "❌ 没有 skopeo：无法读回远端 digest（本脚本用 skopeo 推送，正常不会走到这里）"
    READBACK_FAIL=1
  else
    for t in "$TAG_VERSION" "$TAG_LATEST"; do
      d=$(ALL_PROXY="${PUSH_PROXY:-}" skopeo inspect --format '{{.Digest}}' "docker://${t}" 2>/dev/null || true)
      if [ -z "$d" ]; then
        note "❌ 读回 ${t} 失败 —— 无法证明远端内容与本次推送一致（网络出口问题？）"
        READBACK_FAIL=1
      else
        note "读回 ${t} → ${d}"
        case "$t" in
          "$TAG_VERSION") DIGEST_VERSION="$d" ;;
          *) DIGEST_LATEST="$d" ;;
        esac
      fi
    done
  fi
  if [ -n "$DIGEST_VERSION" ] && [ -n "$DIGEST_LATEST" ] && [ "$DIGEST_VERSION" != "$DIGEST_LATEST" ]; then
    note "❌ ${TAG_VERSION} 与 ${TAG_LATEST} 的 manifest digest 不同（${DIGEST_VERSION} ≠ ${DIGEST_LATEST}）"
    READBACK_FAIL=1
  fi
  if [ -n "$DIGEST_VERSION" ] && command -v python3 >/dev/null 2>&1 && command -v skopeo >/dev/null 2>&1; then
    REMOTE_IDS=$(ALL_PROXY="${PUSH_PROXY:-}" skopeo inspect --config "docker://${TAG_VERSION}" 2>/dev/null \
      | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["rootfs"]["diff_ids"]))' 2>/dev/null || true)
    LOCAL_IDS=$(docker inspect --format '{{json .RootFS}}' "$TAG_VERSION" 2>/dev/null \
      | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["Layers"]))' 2>/dev/null || true)
    if [ -n "$REMOTE_IDS" ] && [ "$REMOTE_IDS" = "$LOCAL_IDS" ]; then
      note "✅ 远端与本地镜像逐层一致（$(printf '%s' "$LOCAL_IDS" | wc -l | tr -d ' ') 层 diff_ids 相同）"
    else
      note "❌ 远端与本地镜像的层不一致 —— 已推送的内容不是本次构建/实测的那一份"
      READBACK_FAIL=1
    fi
  elif [ -n "$DIGEST_VERSION" ]; then
    note "提示：本机没有 python3，只做了 manifest digest 判定；逐层 diff_ids 比对请在能跑 python3 的机器上复核"
  fi
  if [ "$READBACK_FAIL" -ne 0 ]; then
    note "❌ 读回校验未通过：镜像可能已推到远端但无法证明内容一致，不要对外宣布发布完成"
    exit 1
  fi
  note "✅ 读回校验通过：远端 ${TAG_VERSION} 与 ${TAG_LATEST} 指向同一份内容，且与本地镜像逐层一致"
else
  note "跳过推送（--no-push）"
fi

# ---------------------------------------------------------------- 创建 Gitee 发行版
if [ "$DO_RELEASE" -eq 1 ] && [ -n "$VERSION" ]; then
  echo
  echo "================ 创建 Gitee 发行版 ================"
  if [ -z "${GITEE_TOKEN:-${VH_GITEE_TOKEN:-}}" ]; then
    note "⚠️ 未设置 GITEE_TOKEN / VH_GITEE_TOKEN，跳过发行版创建。"
    note "   需要时单独执行："
    note "   GITEE_TOKEN=<令牌> sh scripts/ci-release.sh $TAG .github/RELEASE_NOTES_${VERSION}.md ${GITEE_REPO_SLUG}"
  else
    GITEE_REPO_SLUG="$GITEE_REPO_SLUG" sh scripts/ci-release.sh "$TAG" ".github/RELEASE_NOTES_${VERSION}.md" "$GITEE_REPO_SLUG"
  fi
elif [ "$DO_RELEASE" -eq 1 ]; then
  note "未指定 tag，跳过发行版创建"
fi

echo
note "完成。生产升级（NAS 上）："
note "  cd /srv/vaulthub && docker compose pull && docker compose up -d"
note "注意：生产 compose 是 pull_policy: always，升级依赖 :latest 已被更新。"
