#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.99 行为测试：跑 tests/v0999_behavior.js（Node VM 桩，真实执行 web/js/02-media.js）。

覆盖：
  A. 季度标题作为「该季首条目的前缀」：无独立标题行、前缀只出现一次、折叠只作用于首条之外的集、
     点击前缀能真实显隐
  B. 图形字幕（PGS/DVD）：文本轨与图形轨分流、烧录 URL 拼接（mode/sub_track/audio_track）、
     选择记忆、切音轨保留、「搜索并挂载」列出内嵌轨与本地文件、空结果有明确文案
  C. 本地 NFO 演职人员与推荐：本地优先合并、按标题去重补位、本地库同类推荐（同类型/同演员/同剧排除）
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.99 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0999_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-9000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
