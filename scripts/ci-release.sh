#!/bin/sh
# =============================================================================
# VaultHub —— Gitee 发行版（Release）幂等创建 / 更新脚本
#
# 为什么要单独抽成脚本：
#   原来这段逻辑内嵌在 .github/workflows/publish-image.yml 的 run: | 里，
#   靠 gh CLI 实现「幂等 + 重试 + 发布后读回校验」。GitHub 账户停用后 gh 不可用，
#   Gitee 也没有 gh 这样的官方 CLI，因此改用 Gitee OpenAPI v5 + curl 重写，
#   并把逻辑独立成脚本 —— 好处是它既能在 CI 里跑，也能在 NAS 上手动跑，
#   而且可以在本地用 curl 桩程序做完整回归（见 tests/test_v0970_release_step_logic.py）。
#
# 保留的三项能力（与 v0.9.70 复盘结论一致，不可退化）：
#   ① 幂等：Release 已存在则改为覆盖标题与说明，而不是报错或产生重复
#   ② 重试：最多 3 次，每次间隔 10 秒；最终以「读回结果」为准，不信任单次退出码
#   ③ 读回校验：POST/PATCH 之后重新 GET 一次，核对标题、说明长度、prerelease
#
# 用法：
#   GITEE_TOKEN=<访问令牌> sh scripts/ci-release.sh <tag> <说明文件> [owner/repo]
#
# 例：
#   GITEE_TOKEN=xxx sh scripts/ci-release.sh v0.9.90 .github/RELEASE_NOTES_0.9.90.md enged/vaulthub
#
# 依赖：curl、python3（都用于解析 JSON；无 python3 时脚本会明确报错而不是静默通过）
# 退出码：0 = Release 已发布且说明完整；非 0 = 失败（CI 据此亮红灯）
# =============================================================================
set -eu

TAG="${1:-}"
NOTES="${2:-}"
SLUG="${3:-${GITEE_REPO_SLUG:-}}"

# 说明长度的最低要求：与 v0.9.70 复盘时定的护栏一致。
# 真实发布说明均远超此值；小于它基本可以断定是文件截断或抓错了文件。
MIN_BODY_LEN=500
API_BASE="${GITEE_API_BASE:-https://gitee.com/api/v5}"
RETRIES=3
RETRY_SLEEP=10

die() { echo "错误：$*" >&2; exit 1; }
# 日志走 stderr，stdout 只留给「created <id>/updated <id>」这类结果 ——
# 否则重试循环里的 OUT=$(publish_once) 会把日志一起吞进来。
note() { echo "[ci-release] $*" >&2; }

# ---------------------------------------------------------------- 前置检查
[ -n "$TAG" ] || die "用法：GITEE_TOKEN=<令牌> sh scripts/ci-release.sh <tag> <说明文件> [owner/repo]"
[ -n "$SLUG" ] || die "缺少 owner/repo；请作为第 3 个参数传入，或设置环境变量 GITEE_REPO_SLUG"
[ -n "${GITEE_TOKEN:-}" ] || die "缺少环境变量 GITEE_TOKEN（Gitee 个人访问令牌）"

case "$SLUG" in
  */*) : ;;
  *) die "owner/repo 格式不合法：$SLUG" ;;
esac
OWNER="${SLUG%%/*}"
REPO="${SLUG##*/}"

[ -f "$NOTES" ] || die "找不到发布说明文件：$NOTES"
NOTES_BYTES=$(wc -c < "$NOTES" | tr -d ' ')
NOTES_TITLE="VaultHub $TAG"
note "tag=$TAG  repo=$SLUG  说明文件=$NOTES（$NOTES_BYTES 字节）"

[ "$NOTES_BYTES" -ge "$MIN_BODY_LEN" ] || die "发布说明只有 $NOTES_BYTES 字节（< $MIN_BODY_LEN），拒绝发布不完整的说明"

command -v curl >/dev/null 2>&1 || die "缺少 curl"
command -v python3 >/dev/null 2>&1 || die "缺少 python3（用于解析 Gitee 返回的 JSON）"

# ---------------------------------------------------------------- JSON 取值
# 从 stdin 读取 JSON，按点分路径取值；取到 null / 缺失时输出空串。
# 用法：echo "$json" | json_get tag_name
json_get() {
  python3 -c '
import json,sys
path = sys.argv[1].split(".")
try:
    data = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
for key in path:
    if isinstance(data, dict) and key in data:
        data = data[key]
    else:
        print(""); sys.exit(0)
if data is None:
    print("")
elif isinstance(data, bool):
    print("true" if data else "false")
else:
    print(data)
' "$1"
}

# 判断 stdin 的 JSON 是否为空/null（Gitee 对「tag 下没有 Release」返回字面量 null）
json_is_null() {
  python3 -c '
import json,sys
raw = sys.stdin.read().strip()
if not raw:
    print("yes"); sys.exit(0)
try:
    data = json.loads(raw)
except Exception:
    print("bad-json"); sys.exit(0)
print("yes" if data is None else "no")
'
}

api() {  # api <METHOD> <PATH> [DATA_JSON]  —— 打印响应体，返回 curl 退出码
  _method="$1"; _path="$2"; _data="${3:-}"
  if [ -n "$_data" ]; then
    curl -sS -m 60 -X "$_method" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      --data-binary "$_data" \
      "${API_BASE}${_path}"
  else
    curl -sS -m 60 -X "$_method" \
      -H "Accept: application/json" \
      "${API_BASE}${_path}"
  fi
}

# 所有写操作都把令牌放在 query 上：Gitee OpenAPI v5 的 access_token 是 query 参数，
# 放在请求头里不生效（这也是它和 GitHub v3 的一处关键差异）。
TOKEN_Q="access_token=${GITEE_TOKEN}"

RELEASE_PATH="/repos/${OWNER}/${REPO}/releases"

# ---------------------------------------------------------------- 发布主逻辑
# 成功后打印 "created <id>" 或 "updated <id>"；失败返回非 0
publish_once() {
  _existing=$(api GET "${RELEASE_PATH}/tags/${TAG}?${TOKEN_Q}" || true)
  _state=$(printf '%s' "$_existing" | json_is_null)
  if [ "$_state" = "bad-json" ]; then
    echo "读取现有 Release 返回的不是合法 JSON：$(printf '%s' "$_existing" | head -c 200)" >&2
    return 1
  fi

  if [ "$_state" = "yes" ]; then
    note "Release $TAG 不存在，创建正式 Release"
    # 说明正文经 JSON 转义后提交，避免引号/换行/中文把 body 破坏掉。
    _payload=$(python3 -c '
import json,sys
tag, title, notes = sys.argv[1], sys.argv[2], sys.argv[3]
body = open(notes, encoding="utf-8").read()
print(json.dumps({"tag_name": tag, "name": title, "body": body,
                  "target_commitish": "main", "prerelease": False},
                 ensure_ascii=False))
' "$TAG" "$NOTES_TITLE" "$NOTES") || return 1
    _resp=$(api POST "${RELEASE_PATH}?${TOKEN_Q}" "$_payload") || return 1
    _id=$(printf '%s' "$_resp" | json_get id)
    if [ -z "$_id" ]; then
      echo "创建 Release 失败：$(printf '%s' "$_resp" | head -c 300)" >&2
      return 1
    fi
    echo "created $_id"
    return 0
  fi

  _id=$(printf '%s' "$_existing" | json_get id)
  note "Release $TAG 已存在（id=$_id），改为覆盖标题与说明并确保非预发布"
  _payload=$(python3 -c '
import json,sys
title, notes = sys.argv[1], sys.argv[2]
body = open(notes, encoding="utf-8").read()
print(json.dumps({"name": title, "body": body, "prerelease": False},
                 ensure_ascii=False))
' "$NOTES_TITLE" "$NOTES") || return 1
  _resp=$(api PATCH "${RELEASE_PATH}/${_id}?${TOKEN_Q}" "$_payload") || return 1
  _ok=$(printf '%s' "$_resp" | json_get id)
  if [ -z "$_ok" ]; then
    echo "更新 Release 失败：$(printf '%s' "$_resp" | head -c 300)" >&2
    return 1
  fi
  echo "updated $_ok"
  return 0
}

ATTEMPT=1
PUBLISHED=""
while [ "$ATTEMPT" -le "$RETRIES" ]; do
  if OUT=$(publish_once); then
    PUBLISHED="$OUT"
    note "第 $ATTEMPT 次发布调用成功（$OUT）"
    break
  fi
  echo "[ci-release] 第 $ATTEMPT 次调用失败，${RETRY_SLEEP} 秒后重试" >&2
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -le "$RETRIES" ] && sleep "$RETRY_SLEEP"
done

# 关键：重试全部失败**不直接判失败**。
# v0.9.70 的教训是 —— 写接口报错时 Release 可能已经正确创建（服务器端生效、
# 客户端只看到非 0 退出码），当时就是因为「以退出码为准」把整条流水线判红，
# 连带把依赖它的 Docker Hub 同步也跳过了。
# 所以这里只警告，最终以随后的读回校验为准。
if [ -z "$PUBLISHED" ]; then
  echo "[ci-release] 连续 $RETRIES 次调用都没有返回成功；不据此判失败，改由读回校验裁定" >&2
fi

# ---------------------------------------------------------------- 读回校验
# 不信任写接口的返回体，重新 GET 一次，以仓库里真实存在的状态为准。
READBACK=$(api GET "${RELEASE_PATH}/tags/${TAG}?${TOKEN_Q}") || die "读回 Release 失败"
[ "$(printf '%s' "$READBACK" | json_is_null)" = "no" ] || die "读回时 Release $TAG 不存在，发布未生效"

RB_NAME=$(printf '%s' "$READBACK" | json_get name)
RB_PRE=$(printf '%s' "$READBACK" | json_get prerelease)
RB_BODY_LEN=$(printf '%s' "$READBACK" | python3 -c '
import json,sys
try:
    b = json.load(sys.stdin).get("body") or ""
except Exception:
    b = ""
print(len(b))
')
RB_URL=$(printf '%s' "$READBACK" | json_get html_url)

note "读回结果：name=$RB_NAME prerelease=$RB_PRE 说明字符数=$RB_BODY_LEN"

# 空值 / 非数字必须先拦住：否则 [ "" -lt 500 ] 只会打印报错而不改变判定，
# 校验会被静默跳过（v0.9.70 的旧脚本正是这样漏掉的，这里显式拦截）。
case "$RB_BODY_LEN" in
  ''|*[!0-9]*) die "读回说明长度无效（$RB_BODY_LEN），无法确认说明完整" ;;
esac
[ "$RB_PRE" = "false" ] || die "读回 prerelease=$RB_PRE，应为 false"
[ "$RB_BODY_LEN" -ge "$MIN_BODY_LEN" ] || die "读回说明只有 $RB_BODY_LEN 字符（< $MIN_BODY_LEN）"
[ -n "$RB_URL" ] || die "读回缺少 html_url"

echo "[ci-release] Release 已发布且说明完整：$RB_URL"
