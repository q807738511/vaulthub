#!/usr/bin/env python3
"""v0.9.70: 发布步骤（publish-image.yml）的幂等 / 重试 / 读回校验守卫。

背景：v0.9.70 的 tag 构建里，「Create GitHub Release for version tags」步骤返回非 0，
而 Release 本身已正确创建并发布（说明与 .github/RELEASE_NOTES_0.9.70.md 完全一致）。
整条工作流因此红灯 → workflow_run 触发的 Docker Hub 同步被判「构建失败」而跳过，
Docker Hub 的 v0.9.70 / latest 停留在 v0.9.69 摘要。

本测试用 gh / jq / sleep 桩程序真实执行 YAML 里那段 shell，逐场景断言退出码：
  必须绿：Release 不存在时创建成功、已存在时改为覆盖发布、前几次调用失败后重试成功、
          「gh 调用全部报错但 Release 其实已正确发布」（v0.9.70 实况，不应再红灯）。
  必须红：说明过短、读回仍是草稿、调用全失败且 Release 不存在、读回接口报错。
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/publish-image.yml"


def extract_run_script(workflow_text: str, step_name: str) -> str:
    """从工作流文本里抽出指定步骤的 run: | 脚本块（不依赖 PyYAML）。"""
    lines = workflow_text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip() == f"- name: {step_name}":
            start = i
            break
    assert start is not None, f"找不到步骤 {step_name}"
    run_at = None
    for i in range(start, len(lines)):
        if lines[i].strip() == "run: |":
            run_at = i
            break
    assert run_at is not None, f"步骤 {step_name} 没有 run: | 块"
    body = []
    for line in lines[run_at + 1:]:
        if line.strip() and not line.startswith(" " * 10):
            break
        body.append(line[10:] if line.startswith(" " * 10) else "")
    return "\n".join(body).rstrip() + "\n"


GH_STUB = '''#!/usr/bin/env python3
import json, pathlib, sys
S = pathlib.Path(__file__).resolve().parent.parent
def state(): return json.loads((S / "state.json").read_text())
def save(d): (S / "state.json").write_text(json.dumps(d))
def spend():
    fb = S / "fails"
    n = int(fb.read_text()) if fb.exists() else 0
    if n > 0:
        fb.write_text(str(n - 1)); return True
    return False
args = sys.argv[1:]
(S / "calls").open("a").write(" ".join(args[:2]) + "\\n")
if args[:2] == ["release", "view"]:
    d = state()
    if "--json" in args:
        if d.get("view_fail", 0) > 0:
            d["view_fail"] -= 1; save(d); sys.exit(1)
        print(json.dumps({"isDraft": d["draft"], "isPrerelease": d.get("pre", False),
                          "name": "VaultHub v0.9.70", "tagName": "v0.9.70",
                          "body": d["body"], "url": "https://example.invalid/rel"}))
        sys.exit(0)
    sys.exit(0 if d["exists"] else 1)
if args[:2] == ["release", "create"]:
    if spend(): sys.exit(1)
    d = state(); d["exists"] = True; d["draft"] = False; save(d); sys.exit(0)
if args[:2] == ["release", "edit"]:
    if spend(): sys.exit(1)
    d = state()
    if not d.get("edit_keeps_draft"): d["draft"] = False
    save(d); sys.exit(0)
sys.exit(0)
'''

JQ_STUB = '''#!/usr/bin/env python3
import json, sys
args = [a for a in sys.argv[1:] if a != "-r"]
expr, path = args[0], args[-1]
d = json.load(open(path))
if "isDraft" in expr: v = d["isDraft"]
elif "isPrerelease" in expr: v = d.get("isPrerelease", False)
elif "length" in expr: v = len(d["body"])
elif "url" in expr: v = d["url"]
else:
    sys.stderr.write("unknown filter %s\\n" % expr); sys.exit(1)
print(str(v).lower() if isinstance(v, bool) else v)
'''

SLEEP_STUB = "#!/bin/sh\nexit 0\n"


def run_scenario(workdir: Path, script: Path, state: dict, fails: int):
    (workdir / "fails").write_text(str(fails))
    (workdir / "state.json").write_text(json.dumps(state))
    calls = workdir / "calls"
    if calls.exists():
        calls.unlink()
    env = dict(os.environ)
    env["PATH"] = f"{workdir / 'bin'}{os.pathsep}{env['PATH']}"
    env["GITHUB_REF_NAME"] = "v0.9.70"
    env["GITHUB_REPOSITORY"] = "q807738511/vaulthub"
    out = workdir / "out.txt"
    with open(out, "w") as fh:
        proc = subprocess.run(["bash", str(script)], cwd=ROOT, env=env,
                              stdout=fh, stderr=subprocess.STDOUT)
    actions = []
    if calls.exists():
        parts = calls.read_text().split()
        actions = [parts[i + 1] for i in range(0, len(parts), 2) if i + 1 < len(parts)]
    return proc.returncode, actions, out.read_text()


def main() -> int:
    text = WF.read_text(encoding="utf-8")
    script_text = extract_run_script(text, "Create GitHub Release for version tags")
    # 步骤必须仍然具备幂等 / 重试 / 读回校验三项能力（防止被改回旧写法）
    checks = {
        "保留 release view 存在性判断": 'gh release view "$GITHUB_REF_NAME"' in script_text,
        "保留 create 与 edit 两条分支": "gh release create" in script_text and "gh release edit" in script_text,
        "带重试循环": "for ATTEMPT in 1 2 3" in script_text,
        "创建时校验 tag 存在": "--verify-tag" in script_text,
        "发布后读回校验": "isDraft,isPrerelease,name,tagName,body,url" in script_text,
        "空值长度显式拦截": '*[!0-9]*' in script_text,
        "实测强度至少 500 字符": '"$BODY_LEN" -lt 500' in script_text,
    }
    failed = [k for k, v in checks.items() if not v]
    for k, v in checks.items():
        print(("PASS" if v else "FAIL") + ": 静态-" + k)
    if failed:
        raise SystemExit(f"FAIL: 发布步骤静态检查 {len(failed)} 项未通过")

    tmp = Path(tempfile.mkdtemp(prefix="vh-release-step-"))
    try:
        (tmp / "bin").mkdir()
        for name, content in (("gh", GH_STUB), ("jq", JQ_STUB), ("sleep", SLEEP_STUB)):
            p = tmp / "bin" / name
            p.write_text(content)
            p.chmod(0o755)
        script = tmp / "step_release.sh"
        script.write_text(script_text)

        body = "#" * 3691
        scenarios = [
            ("不存在→创建成功", {"exists": False, "draft": True, "body": body}, 0, 0),
            ("已存在→覆盖发布", {"exists": True, "draft": True, "body": body}, 0, 0),
            ("前两次调用失败后重试成功", {"exists": False, "draft": True, "body": body}, 2, 0),
            ("调用全报错但 Release 已正确发布（v0.9.70 实况）",
             {"exists": True, "draft": False, "body": body}, 9, 0),
            ("说明过短→必须红灯", {"exists": True, "draft": False, "body": "short"}, 0, 1),
            ("读回仍是草稿→必须红灯",
             {"exists": True, "draft": True, "body": body, "edit_keeps_draft": True}, 0, 1),
            ("调用全失败且 Release 不存在→必须红灯",
             {"exists": False, "draft": True, "body": body}, 9, 1),
            ("读回接口报错→必须红灯",
             {"exists": True, "draft": False, "body": body, "view_fail": 1}, 0, 1),
        ]
        bad = []
        for name, state, fails, expect in scenarios:
            rc, actions, output = run_scenario(tmp, script, state, fails)
            ok = rc == expect
            if not ok:
                bad.append(name)
            print(("PASS" if ok else "FAIL") + f": 场景-{name} (rc={rc}, 期望 {expect}, 动作={actions[:4]})")
            if not ok:
                print("      " + output.strip().splitlines()[-1][:160])
        if bad:
            raise SystemExit(f"FAIL: 发布步骤行为场景 {len(bad)} 项未通过")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("PASS: v0.9.70 发布步骤幂等/重试/读回校验守卫")
    return 0


if __name__ == "__main__":
    sys.exit(main())
