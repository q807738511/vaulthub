#!/usr/bin/env bash
# VaultHub 桌面客户端冒烟：登录 → 库列表 → 文件分页 → 封面/播放决策（全部只读）
#
#   BASE=http://<host>:8088 VH_USER=admin VH_PASS='***' bash smoke.sh [库ID]
#
# 不写任何数据：不建库、不改进度、不建播放会话。
set -u

BASE="${BASE:-http://<vault-hub-host>:8088}"
VH_USER="${VH_USER:-admin}"
VH_PASS="${VH_PASS:-}"
LIB="${1:-${VH_LIB:-}}"
ok=0; fail=0

say()  { printf '%s\n' "$*"; }
pass() { ok=$((ok+1));   printf '  ok   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$*"; }

code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }

say "BASE=$BASE"
[ -n "$VH_PASS" ] || { say "缺少 VH_PASS"; exit 2; }

# 1. 健康
h=$(curl -s -m 8 "$BASE/api/health")
case "$h" in *'"ok":true'*) pass "health";; *) bad "health: $h";; esac

# 2. 认证模式（公开）
m=$(curl -s -m 8 "$BASE/api/auth/mode")
case "$m" in *'"ok":true'*) pass "auth/mode";; *) bad "auth/mode: $m";; esac

# 3. 登录
cookie=$(curl -si -m 15 -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$VH_USER\",\"password\":\"$VH_PASS\",\"keep_days\":30}" \
  | tr -d '\r' | awk 'tolower($1)=="set-cookie:"{print $2; exit}')
case "$cookie" in vh_session=*) pass "login (Set-Cookie)";; *) bad "login 未拿到 vh_session"; exit 1;; esac

# 4. 未登录取库必须 401（v1.0.7 起的边界）
[ "$(code "$BASE/api/media/libraries")" = "401" ] && pass "匿名库列表 401" || bad "匿名库列表未返回 401"

# 5. 库列表
libs=$(curl -s -m 15 -H "Cookie: $cookie" "$BASE/api/media/libraries")
case "$libs" in *'"libraries"'*) pass "libraries";; *) bad "libraries: $libs"; exit 1;; esac
if [ -z "$LIB" ]; then
  LIB=$(printf '%s' "$libs" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
fi
say "  使用库: ${LIB:-<空>}"
[ -n "$LIB" ] || { bad "没有可用媒体库"; exit 1; }

# 6. 文件分页
files=$(curl -s -m 20 -H "Cookie: $cookie" "$BASE/api/media/files?id=$LIB&limit=3")
case "$files" in *'"files"'*) pass "files 分页";; *) bad "files: ${files:0:160}"; exit 1;; esac
FILE=$(printf '%s' "$files" | sed -n 's/.*"files":\[{"path":"\([^"]*\)".*/\1/p' | head -1)
say "  首个文件: ${FILE:-<无>}"
[ -n "$FILE" ] || { bad "库里没有文件"; exit 1; }

# 7. 封面（允许 404：没有 sidecar 属正常）
case "$(code -H "Cookie: $cookie" "$BASE/api/media/cover?id=$LIB&path=$FILE&w=320")" in
  200|304|404) pass "cover 端点可达";; *) bad "cover 端点异常";; esac

# 8. 播放决策（只 POST 计划，不建会话）
plan_code=$(code -X POST -H "Cookie: $cookie" -H 'Content-Type: application/json' \
  -d "{\"library_id\":\"$LIB\",\"path\":\"$FILE\",\"quality\":\"auto\",\"client\":{\"mp4\":true,\"h264\":true,\"aac\":true}}" \
  "$BASE/api/media/playback/plan")
case "$plan_code" in
  200) pass "playback/plan";;
  422) pass "playback/plan 可达（文件无法探测：占位/损坏文件属正常）";;
  404) pass "playback/plan 可达（音乐/书刊库不适用，属正常）";;
  *)   bad "playback/plan → $plan_code";;
esac

# 9. 进度端点可读（应为 200 且 items 对象）
prog=$(curl -s -m 15 -H "Cookie: $cookie" "$BASE/api/media/playback/progress?id=$LIB")
case "$prog" in *'"items"'*) pass "playback/progress 可读";; *) bad "playback/progress: ${prog:0:120}";; esac

printf '\n'
if [ "$fail" -eq 0 ]; then say "SMOKE OK（$ok 项通过）"; exit 0; fi
say "SMOKE FAILED（$ok 通过 / $fail 失败）"; exit 1
