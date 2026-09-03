#!/usr/bin/env sh
# merge-env.sh — 键级合并 vaulthub.env（不依赖 git）
#
# 新版本 VaultHub 可能在 vaulthub.env 模板里新增环境变量（例如 v0.9.30 增加的
# MEDIA_SCAN_MAX_DEPTH）。本脚本把「新版模板」与「本地 vaulthub.env」做键级合并：
#   · 只追加本地缺失的键，原样带上键上方紧邻的说明注释，默认值开箱即用；
#   · 本地已有的键（无论是否改过）一律不动；
#   · 写入前自动备份为 vaulthub.env.bak-<时间戳>；
#   · 幂等：重复执行不会产生重复键；没有任何新键时不做任何修改。
#
# 用法:
#   merge-env.sh [-n] [-l 本地文件] <新模板文件 | https://模板URL>
#     -n              预览模式：只打印将要追加的内容，不写文件
#     -l 本地文件      指定本地 env 文件，默认 ./vaulthub.env
#     模板为 URL 时需要 curl；私有仓库 raw 地址请在环境变量
#     VAULTHUB_GH_TOKEN（或 GH_TOKEN）里给带读取权限的 token，
#     脚本会自动附带 Authorization 头。
#
# 示例:
#   sh scripts/merge-env.sh /tmp/vaulthub.env.new
#   VAULTHUB_GH_TOKEN=ghp_xxx sh scripts/merge-env.sh \
#       https://raw.githubusercontent.com/q807738511/vaulthub/main/vaulthub.env
#
# 合并完成后需重建容器才会重新注入（restart 不够）:
#   docker compose up -d --force-recreate

PROG=$(basename "$0")
LOCAL="vaulthub.env"
DRY=0
TEMPLATE=""

usage() {
  cat <<EOF
用法: $PROG [-n] [-l 本地文件] <新模板文件 | https://模板URL>

键级合并 vaulthub.env：只追加本地缺失的新键（含默认值与说明注释），
本地已有的键一律不动；写入前自动备份，幂等可重复执行。

选项:
  -n            预览模式，不写文件
  -l 本地文件    默认 ./vaulthub.env
  -h            显示本帮助

URL 模板需要 curl；私有仓库 raw 地址用 VAULTHUB_GH_TOKEN / GH_TOKEN
提供带读取权限的 token。
EOF
  exit "${1:-0}"
}

# ---- 解析参数 ----
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    -n|--dry-run) DRY=1 ;;
    -l|--local)
      shift
      if [ "$#" -eq 0 ]; then
        echo "$PROG: -l 缺少本地文件参数" >&2
        usage 1
      fi
      LOCAL=$1
      ;;
    -*) echo "$PROG: 未知选项 $1" >&2; usage 1 ;;
    *) TEMPLATE=$1 ;;
  esac
  shift
done

if [ -z "$TEMPLATE" ]; then
  echo "$PROG: 缺少新模板参数（文件或 URL）" >&2
  usage 1
fi

# ---- 临时文件与清理 ----
_tmp_comment=$(mktemp) || exit 2
_tmp_add=$(mktemp) || exit 2
_tmp_keys=$(mktemp) || exit 2
_tmp_tpl=""
trap 'rm -f "$_tmp_comment" "$_tmp_add" "$_tmp_keys" "$_tmp_tpl"' EXIT HUP INT TERM

# ---- 模板来源：URL 下载或本地文件 ----
case "$TEMPLATE" in
  http://*|https://*)
    if ! command -v curl >/dev/null 2>&1; then
      echo "$PROG: URL 模式需要 curl，请先安装" >&2
      exit 2
    fi
    _tmp_tpl=$(mktemp) || exit 2
    TOKEN=${GH_TOKEN:-}
    if [ -z "$TOKEN" ]; then
      TOKEN=${VAULTHUB_GH_TOKEN:-}
    fi
    if [ -n "$TOKEN" ]; then
      curl -fsSL -H "Authorization: token $TOKEN" -o "$_tmp_tpl" "$TEMPLATE" \
        || { echo "$PROG: 模板下载失败: $TEMPLATE" >&2; exit 2; }
    else
      curl -fsSL -o "$_tmp_tpl" "$TEMPLATE" \
        || { echo "$PROG: 模板下载失败: $TEMPLATE" >&2; exit 2; }
    fi
    TPL=$_tmp_tpl
    ;;
  *)
    TPL=$TEMPLATE
    if [ ! -f "$TPL" ]; then
      echo "$PROG: 模板文件不存在: $TPL" >&2
      exit 2
    fi
    ;;
esac

# ---- 本地文件不存在：整体复制模板 ----
if [ ! -f "$LOCAL" ]; then
  if [ "$DRY" -eq 1 ]; then
    echo "$PROG: [dry-run] $LOCAL 不存在，将用模板整体创建（预览模式未写入）"
  else
    cp "$TPL" "$LOCAL" && echo "$PROG: $LOCAL 不存在，已用模板整体创建"
  fi
  exit 0
fi

# ---- 提取本地已有键（唯一化） ----
sed -n -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$LOCAL" | sort -u > "$_tmp_keys"
local_n=$(wc -l < "$_tmp_keys" | tr -d ' ')
tpl_n=$(sed -n -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$TPL" | wc -l | tr -d ' ')

# ---- 扫描模板：携带紧邻注释，只收集本地缺失的键 ----
n_new=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ -z "$line" ]; then
    : > "$_tmp_comment"
    continue
  fi
  case "$line" in
    '#'*)
      printf '%s\n' "$line" >> "$_tmp_comment"
      ;;
    *)
      key=$(printf '%s\n' "$line" | sed -n -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p')
      if [ -n "$key" ] && ! grep -qx "$key" "$_tmp_keys"; then
        if [ -s "$_tmp_comment" ]; then
          cat "$_tmp_comment" >> "$_tmp_add"
        fi
        printf '%s\n' "$line" >> "$_tmp_add"
        printf '%s\n' "$key" >> "$_tmp_keys"   # 防止模板内重复键
        n_new=$((n_new + 1))
      fi
      : > "$_tmp_comment"
      ;;
  esac
done < "$TPL"

echo "$PROG: 模板共 $tpl_n 个键 / 本地已有 $local_n 个"

if [ "$n_new" -eq 0 ]; then
  echo "$PROG: 无新增键，本地文件已覆盖模板全部键，不做修改"
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  echo "$PROG: [dry-run] 将向 $LOCAL 追加以下 $n_new 个键（预览，未写入）:"
  echo "------------------------------------------------------------"
  cat "$_tmp_add"
  echo "------------------------------------------------------------"
  exit 0
fi

# ---- 备份后追加 ----
bak="$LOCAL.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$LOCAL" "$bak"
{
  printf '\n# ---- %s %s: 依据模板补入 %s 个新键（默认值，可按需修改）----\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$PROG" "$n_new"
  cat "$_tmp_add"
} >> "$LOCAL"

echo "$PROG: 已备份原文件到 $bak"
echo "$PROG: 已向 $LOCAL 追加 $n_new 个新键:"
sed -n -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/  + \1/p' "$_tmp_add"
echo "$PROG: 完成。重建容器生效: docker compose up -d --force-recreate"
