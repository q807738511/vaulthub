#!/usr/bin/env python3
"""v0.9.90: 发行版创建步骤（scripts/ci-release.sh）的幂等 / 重试 / 读回校验守卫。

背景：这段逻辑原来长在 .github/workflows/publish-image.yml 的 run: | 里，靠 gh CLI。
v0.9.70 复盘过一次真实事故 —— tag 构建里 gh 返回非 0，而 Release 其实已正确创建并
发布（说明与 .github/RELEASE_NOTES_0.9.70.md 逐字节一致），整条工作流因此红灯，
连带把依赖 workflow_run 的 Docker Hub 同步也跳过了，Docker Hub 的 v0.9.70 / latest
一度停在 v0.9.69 摘要。

v0.9.90 GitHub 账户停用后 gh 不可用，逻辑改写为 Gitee OpenAPI v5 + curl 并抽成
scripts/ci-release.sh。本测试跟着迁移，但三项护栏一条都不放松：
  ① 幂等：已存在则覆盖，不是报错、也不产生重复
  ② 重试：最多 3 次；且重试全部失败**不直接判失败**，交给读回校验裁定（v0.9.70 教训）
  ③ 读回校验：重新 GET，核对存在性 / prerelease / 说明长度

做法：用 Python 写一个 curl 桩程序（模拟 Gitee 发行版接口 + 可注入故障的服务端），
放进临时 PATH 最前面，真的把脚本跑起来，逐场景断言退出码与调用序列。

  必须绿：不存在时创建成功、已存在时覆盖、前两次失败后重试成功、
          「写接口全部报错但服务端其实已创建」（v0.9.70 实况，不能再红灯）。
  必须红：说明过短、读回 prerelease=true、读回说明被截断、调用全失败且未创建、
          读回拿不到 Release、读回返回非 JSON。
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci-release.sh"
PIPELINE = ROOT / ".workflow" / "publish.yml"

TAG = "v0.9.70"
SLUG = "q807738511/vaulthub"

# --------------------------------------------------------------------------- 桩程序
# 模拟 Gitee OpenAPI v5 的发行版接口。服务端状态存在 $STUB_STATE/server.json，
# 可注入的故障由同一文件里的字段控制：
#   fail_mutations       前 N 次写操作（POST/PATCH）返回非 0
#   side_effect_on_fail  写操作「失败」时仍然在服务端生效（模拟 v0.9.70 的情形）
#   force_prerelease     服务端把 prerelease 记成 true
#   truncate_body        服务端只存前 100 个字符（模拟说明被截断）
#   touch_null           GET by tag 永远返回 null
#   get_error            GET 返回非 JSON 垃圾
CURL_STUB = r'''#!/usr/bin/env python3
import json, os, sys

STATE = os.environ["STUB_STATE"]
SERVER = os.path.join(STATE, "server.json")
CALLS = os.path.join(STATE, "calls.log")

args = sys.argv[1:]
method, data, url, i = "GET", None, None, 0
while i < len(args):
    a = args[i]
    if a == "-X":
        method = args[i + 1]; i += 2; continue
    if a == "--data-binary":
        data = args[i + 1]; i += 2; continue
    if a in ("-H", "-m"):
        i += 2; continue
    if a.startswith("-"):
        i += 1; continue
    url = a; i += 1

path = (url or "").split("?")[0]
with open(CALLS, "a") as fh:
    fh.write("%s %s\n" % (method, path))

with open(SERVER) as fh:
    server = json.load(fh)


def save():
    with open(SERVER, "w") as fh:
        json.dump(server, fh, ensure_ascii=False)


def out(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


if method == "GET":
    if server.get("get_error"):
        sys.stdout.write("<<< not json >>>")
        sys.exit(0)
    if server.get("touch_null"):
        out(None)
    key = path.split("/releases/tags/", 1)[1] if "/releases/tags/" in path else None
    out(server["releases"].get(key))

# ---------------- 写操作 ----------------
n = server.get("mutations", 0)
server["mutations"] = n + 1
fail = n < server.get("fail_mutations", 0)
side_effect = server.get("side_effect_on_fail", False)
if fail and not side_effect:
    save()
    sys.exit(1)

payload = json.loads(data) if data else {}

if method == "PATCH":
    rid = int(path.rsplit("/", 1)[1])
    for rel in server["releases"].values():
        if rel["id"] == rid:
            rel["name"] = payload.get("name", rel["name"])
            rel["body"] = payload.get("body", rel["body"])
            rel["prerelease"] = payload.get("prerelease", rel["prerelease"])
            if server.get("truncate_body"):
                rel["body"] = rel["body"][:100]
            if server.get("force_prerelease"):
                rel["prerelease"] = True
            save()
            if fail:
                sys.exit(1)
            out(rel)
    save()
    sys.exit(1)

key = payload.get("tag_name", path)
body = payload.get("body", "")
if server.get("truncate_body"):
    body = body[:100]
new_id = server.get("next_id", 900001)
server["next_id"] = new_id + 1
rel = {
    "id": new_id,
    "tag_name": key,
    "name": payload.get("name", ""),
    "body": body,
    "prerelease": bool(payload.get("prerelease", False)) or bool(server.get("force_prerelease")),
    "html_url": "https://gitee.com/%s/releases/tag/%s" % (os.environ.get("STUB_SLUG", "o/r"), key),
}
server["releases"][key] = rel
save()
if fail:
    sys.exit(1)
out(rel)
'''

SLEEP_STUB = "#!/bin/sh\nexit 0\n"

LONG_NOTES = ("# VaultHub v0.9.70 发布说明\n\n"
              + "这是一段足够长的发布说明正文，用于满足读回校验的最低长度要求。\n" * 20)
SHORT_NOTES = "# 太短了\n"


# --------------------------------------------------------------------------- 静态守卫
def static_checks():
    SCRIPT.chmod(0o755)
    script = SCRIPT.read_text(encoding="utf-8")
    pipeline = PIPELINE.read_text(encoding="utf-8")
    checks = {
        "脚本存在": SCRIPT.is_file(),
        "按 tag 查存在性（/releases/tags/）": "${RELEASE_PATH}/tags/${TAG}" in script,
        "保留 create 与 patch 两条分支": "api POST" in script and "api PATCH" in script,
        "带重试循环": 'while [ "$ATTEMPT" -le "$RETRIES" ]' in script and "RETRIES=3" in script,
        "重试耗尽不直接判失败（v0.9.70 教训）": "不据此判失败" in script,
        "发布后读回校验": "READBACK=" in script and "json_is_null" in script,
        "空值长度显式拦截": "*[!0-9]*" in script,
        "实测强度至少 500 字符": "MIN_BODY_LEN=500" in script,
        "access_token 走 query（Gitee 与 GitHub 的差异）": "access_token=" in script,
        "流水线真的调用该脚本": "scripts/ci-release.sh" in pipeline,
        "流水线推 Docker Hub 而非 GHCR": ("repository: docker.io" in pipeline
                                          and "ghcr.io/q807738511" not in pipeline),
    }
    failed = [k for k, v in checks.items() if not v]
    for k, v in checks.items():
        print(("PASS" if v else "FAIL") + ": 静态-" + k)
    return list(checks.keys()), failed


# --------------------------------------------------------------------------- 场景运行
def run_scenario(workdir: Path, notes: Path, server: dict):
    """返回 (退出码, 调用序列, 脚本输出)。"""
    state = workdir / "state"
    if state.exists():
        shutil.rmtree(state)
    state.mkdir()
    (state / "server.json").write_text(json.dumps(server, ensure_ascii=False))
    (state / "calls.log").write_text("")

    env = dict(os.environ)
    env["PATH"] = f"{workdir / 'bin'}{os.pathsep}{env['PATH']}"
    env["STUB_STATE"] = str(state)
    env["STUB_SLUG"] = SLUG
    env["GITEE_TOKEN"] = "stub-token"
    env["GITEE_REPO_SLUG"] = SLUG
    env["HOME"] = str(workdir)  # 防止脚本里任何 ~ 展开碰到真实家目录

    proc = subprocess.run(
        ["sh", str(SCRIPT), TAG, str(notes), SLUG],
        cwd=ROOT, env=env, capture_output=True, text=True,
    )
    calls = [ln for ln in (state / "calls.log").read_text().splitlines() if ln.strip()]
    return proc.returncode, calls, proc.stdout + proc.stderr


def actions(calls):
    return [c.split(" ", 1)[0] for c in calls]


def main() -> int:
    names, failed = static_checks()
    if failed:
        raise SystemExit(f"FAIL: 静态检查 {len(failed)} 项未通过")

    tmp = Path(tempfile.mkdtemp(prefix="vh-gitee-release-"))
    try:
        bindir = tmp / "bin"
        bindir.mkdir()
        for name, content in (("curl", CURL_STUB), ("sleep", SLEEP_STUB)):
            p = bindir / name
            p.write_text(content)
            p.chmod(0o755)

        long_notes = tmp / "notes-long.md"
        long_notes.write_text(LONG_NOTES, encoding="utf-8")
        short_notes = tmp / "notes-short.md"
        short_notes.write_text(SHORT_NOTES, encoding="utf-8")

        existing = {"releases": {TAG: {
            "id": 4242, "tag_name": TAG, "name": "旧标题",
            "body": "旧说明" * 200, "prerelease": False,
            "html_url": f"https://gitee.com/{SLUG}/releases/tag/{TAG}",
        }}}

        cases = [
            # 名称, notes, server 初始状态, 期望退出码, 额外断言
            ("不存在时创建成功", long_notes, {"releases": {}}, 0,
             lambda a, o: a.count("POST") == 1 and "PATCH" not in a and "created" in o),
            ("已存在时改为覆盖（幂等）", long_notes, existing, 0,
             lambda a, o: "PATCH" in a and "POST" not in a and "updated" in o),
            ("前两次失败第三次成功（重试）", long_notes,
             {"releases": {}, "fail_mutations": 2}, 0,
             lambda a, o: a.count("POST") == 3),
            ("写接口全报错但服务端其实已创建（v0.9.70 实况，必须绿）", long_notes,
             {"releases": {}, "fail_mutations": 3, "side_effect_on_fail": True}, 0,
             lambda a, o: "Release 已发布且说明完整" in o),
            ("说明过短必须红", short_notes, {"releases": {}}, 1,
             lambda a, o: "MIN_BODY_LEN" not in o),
            ("读回 prerelease=true 必须红", long_notes,
             {"releases": {}, "force_prerelease": True}, 1,
             lambda a, o: "prerelease" in o),
            ("读回说明被截断必须红", long_notes,
             {"releases": {}, "truncate_body": True}, 1,
             lambda a, o: "字符" in o),
            ("调用全失败且未创建必须红", long_notes,
             {"releases": {}, "fail_mutations": 99}, 1,
             lambda a, o: True),
            ("读回拿不到 Release 必须红", long_notes,
             {"releases": {}, "touch_null": True}, 1,
             lambda a, o: True),
            ("读回返回非 JSON 必须红", long_notes,
             {"releases": {}, "get_error": True}, 1,
             lambda a, o: True),
        ]

        print()
        problems = []
        for name, notes, server, want_code, extra in cases:
            code, calls, out = run_scenario(tmp, notes, json.loads(json.dumps(server)))
            ok = (code == want_code) and extra(actions(calls), out)
            print(("PASS" if ok else "FAIL")
                  + f": 场景-{name}  (退出码={code}, 期望={want_code}, 调用={actions(calls)})")
            if not ok:
                problems.append(name)
                print("      ---- 脚本输出（末 12 行）----")
                for line in out.strip().splitlines()[-12:]:
                    print("      " + line)

        if problems:
            raise SystemExit(f"FAIL: {len(problems)} 个场景未通过：{problems}")

        print()
        print(f"PASS: v0.9.90 Gitee 发行版步骤 —— 静态 {len(names)} 项 + 行为 {len(cases)} 项全部通过")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
