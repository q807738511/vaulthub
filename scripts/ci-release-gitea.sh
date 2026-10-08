#!/bin/sh
# =============================================================================
# VaultHub —— Gitea 发行版（Release）幂等创建 / 更新脚本
#
# 与 scripts/ci-release.sh（Gitee 版）同源同规矩，只是把 OpenAPI 换成 Gitea 的：
#   Gitee : https://gitee.com/api/v5          头 Authorization 走 access_token
#   Gitea : <实例>/api/v1                     头 Authorization: token <令牌>
#   列表接口也不同：Gitee 用 GET /repos/{owner}/{repo}/releases/tags/{tag}
#                   Gitea 同路径同名，这点一致
#
# 保留的三项能力（与 v0.9.70 复盘结论一致，不可退化）：
#   ① 幂等：Release 已存在则 PATCH 覆盖标题与说明，而不是报错或产生重复
#   ② 重试：最多 3 次，每次间隔 10 秒；最终以「读回结果」为准，不信任单次退出码
#   ③ 读回校验：写入之后重新 GET 一次，核对标题、说明长度、draft、prerelease
#
# 用法：
#   GITEA_TOKEN=<访问令牌> \
#   GITEA_API_BASE=https://gitea.example.com/api/v1 \
#   GITEA_REPO_SLUG=<owner>/<repo> \
#   sh scripts/ci-release-gitea.sh <tag> <说明文件>
#
# 例：
#   GITEA_TOKEN=xxx GITEA_API_BASE=http://127.0.0.1:30001/api/v1 \
#   GITEA_REPO_SLUG=someone/vaulthub \
#   sh scripts/ci-release-gitea.sh v0.9.90 .github/RELEASE_NOTES_0.9.90.md
#
# 依赖：curl；JSON 转义优先用 node（Gitea runner 镜像里必有 node，且没有 python3），
#      其次 python3，最后用内置的逐行转义兜底。
# 退出码：0 = Release 已发布且说明完整；非 0 = 失败（CI 据此亮红灯）
# =============================================================================
set -eu

TAG="${1:-}"
NOTES="${2:-}"
SLUG="${3:-${GITEA_REPO_SLUG:-}}"

MIN_BODY_LEN=500
API_BASE="${GITEA_API_BASE:-}"
RETRIES=3
RETRY_SLEEP=10

die() { echo "错误：$*" >&2; exit 1; }
note() { echo "[ci-release-gitea] $*" >&2; }

# ---------------------------------------------------------------- 前置检查
[ -n "$TAG" ] || die "用法：GITEA_TOKEN=<令牌> GITEA_API_BASE=<.../api/v1> GITEA_REPO_SLUG=<owner/repo> sh scripts/ci-release-gitea.sh <tag> <说明文件>"
[ -n "$SLUG" ] || die "缺少 owner/repo；请作为第 3 个参数传入，或设置环境变量 GITEA_REPO_SLUG"
[ -n "${GITEA_TOKEN:-}" ] || die "缺少环境变量 GITEA_TOKEN（Gitea 访问令牌）"
[ -n "$API_BASE" ] || die "缺少环境变量 GITEA_API_BASE（例如 https://gitea.example.com/api/v1）"
case "$SLUG" in
  */*) : ;;
  *) die "owner/repo 格式不合法：$SLUG" ;;
esac
case "$API_BASE" in
  http://*|https://*) : ;;
  *) die "GITEA_API_BASE 必须以 http:// 或 https:// 开头：$API_BASE" ;;
esac
[ -f "$NOTES" ] || die "找不到发布说明文件：$NOTES"
command -v curl >/dev/null 2>&1 || die "缺少 curl"

API_BASE="${API_BASE%/}"
BASE_URL="$API_BASE/repos/$SLUG/releases"
NOTES_BYTES=$(wc -c < "$NOTES" | tr -d ' ')
TITLE="VaultHub $TAG"
note "tag=$TAG  repo=$SLUG  说明文件=$NOTES（$NOTES_BYTES 字节）  api=$API_BASE"

if [ "$NOTES_BYTES" -lt "$MIN_BODY_LEN" ]; then
  die "说明文件只有 $NOTES_BYTES 字节，小于 $MIN_BODY_LEN，几乎可以断定文件截断或抓错了文件"
fi

# ---------------------------------------------------------------- JSON 转义
# 把说明文件的正文转成 JSON 字符串字面量（含首尾引号）。
json_string() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$1"
    return $?
  fi
  # 兜底：sed 做转义（\\ \" 制表），再用 awk 把换行拼成 \n。
  # sed 的替换语义比 awk 的 gsub 可移植，所以转义全交给 sed。
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' "$1" \
    | awk 'BEGIN { printf "\"" } { if (NR > 1) printf "\\n"; printf "%s", $0 } END { printf "\"" }'
}

BODY_JSON=$(json_string "$NOTES")
[ -n "$BODY_JSON" ] || die "说明文件转义后为空"

# ---------------------------------------------------------------- 读回校验
# 只看仓库里真实存在的 Release 状态，不信任写入调用的退出码。
verify_once() {
  RESP=$(curl -sS -m 30 -w '\n%{http_code}' \
    -H "Authorization: token $GITEA_TOKEN" \
    -H 'Accept: application/json' \
    "$BASE_URL/tags/$TAG") || die "读回请求失败"
  CODE=$(printf '%s' "$RESP" | tail -1)
  JSON=$(printf '%s' "$RESP" | sed '$d')
  [ "$CODE" = "200" ] || die "读回失败：HTTP $CODE"
  # v0.9.95（安全审查 M1）：优先用 node 核对读回内容（runner 镜像里必有 node、没有 python3），
  # 两者都缺时**判失败**，不再「只确认 HTTP 200」降级成假绿灯。
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$JSON" | node -e '
      let raw = "";
      process.stdin.on("data", d => raw += d).on("end", () => {
        const tag = process.argv[1], minimum = Number(process.argv[2]);
        let rel;
        try { rel = JSON.parse(raw); } catch (e) { console.error("读回的不是合法 JSON：" + e.message); process.exit(1); }
        const body = rel.body || "";
        console.log("读回：name=" + (rel.name || "") + " draft=" + rel.draft + " prerelease=" + rel.prerelease + " 说明字符数=" + body.length);
        const bad = [];
        if (rel.tag_name !== tag) bad.push("tag_name=" + rel.tag_name);
        if (rel.draft !== false) bad.push("draft=" + rel.draft);
        if (rel.prerelease !== false) bad.push("prerelease=" + rel.prerelease);
        if (body.length < minimum) bad.push("说明过短(" + body.length + ")");
        if (bad.length) { console.error("校验不通过：" + bad.join("，")); process.exit(1); }
      });
    ' "$TAG" "$MIN_BODY_LEN"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$JSON" "$TAG" "$MIN_BODY_LEN" <<'PY'
import json, sys
tag, minimum = sys.argv[2], int(sys.argv[3])
try:
    rel = json.loads(sys.argv[1])
except Exception as e:
    sys.exit("读回的不是合法 JSON：%s" % e)
body = rel.get("body") or ""
name = rel.get("name") or ""
draft = rel.get("draft")
pre = rel.get("prerelease")
print("读回：name=%s draft=%s prerelease=%s 说明字符数=%d" % (name, draft, pre, len(body)))
bad = []
if rel.get("tag_name") != tag: bad.append("tag_name=%s" % rel.get("tag_name"))
if draft is not False: bad.append("draft=%s" % draft)
if pre is not False: bad.append("prerelease=%s" % pre)
if len(body) < minimum: bad.append("说明过短(%d)" % len(body))
if bad:
    sys.exit("校验不通过：" + "，".join(bad))
PY
  else
    die "本机既没有 node 也没有 python3：无法核对 tag_name/draft/prerelease/说明长度，拒绝把 HTTP 200 当发布成功"
  fi
}

# ---------------------------------------------------------------- 幂等写入
publish_once() {
  EXIST=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' \
    -H "Authorization: token $GITEA_TOKEN" "$BASE_URL/tags/$TAG") || return 1
  if [ "$EXIST" = "200" ]; then
    RAW=$(curl -sS -m 30 -H "Authorization: token $GITEA_TOKEN" -H 'Accept: application/json' \
      "$BASE_URL/tags/$TAG") || return 1
    if command -v python3 >/dev/null 2>&1; then
      RID=$(printf '%s' "$RAW" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
    else
      RID=$(printf '%s' "$RAW" | sed -n 's/.*"id"[: ]*\([0-9]*\).*/\1/p' | head -1)
    fi
    [ -n "$RID" ] || return 1
    note "Release 已存在（id=$RID），改为覆盖标题与说明"
    CODE=$(curl -sS -m 30 -o /tmp/ci-release-gitea.out -w '%{http_code}' -X PATCH \
      -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
      -d "{\"name\":\"$TITLE\",\"body\":$BODY_JSON,\"draft\":false,\"prerelease\":false}" \
      "$BASE_URL/$RID")
  else
    note "Release 不存在，创建新的正式 Release"
    CODE=$(curl -sS -m 30 -o /tmp/ci-release-gitea.out -w '%{http_code}' -X POST \
      -H "Authorization: token $GITEA_TOKEN" -H 'Content-Type: application/json' \
      -d "{\"tag_name\":\"$TAG\",\"name\":\"$TITLE\",\"body\":$BODY_JSON,\"draft\":false,\"prerelease\":false}" \
      "$BASE_URL")
  fi
  case "$CODE" in
    200|201) note "写入返回 HTTP $CODE"; return 0 ;;
    *) note "写入返回 HTTP $CODE：$(head -c 300 /tmp/ci-release-gitea.out 2>/dev/null)"; return 1 ;;
  esac
}

ATTEMPT=1
OK=0
while [ "$ATTEMPT" -le "$RETRIES" ]; do
  if publish_once && verify_once; then
    OK=1
    note "第 $ATTEMPT 次调用通过读回校验"
    break
  fi
  note "第 $ATTEMPT 次未通过，${RETRY_SLEEP} 秒后重试"
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -le "$RETRIES" ]; then sleep "$RETRY_SLEEP"; fi
done

[ "$OK" -eq 1 ] || die "重试 $RETRIES 次仍未发布成功（说明文件 $NOTES_BYTES 字节）"
echo "published $TAG"
