#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.86 行为测试：跑 tests/v0986_behavior.js（Node VM 桩，27 项）。

覆盖：硬盘容量去重与容器盘温度（05-home / 03-features）、
库扫描胶囊与库页刮削区（02-media）、音乐库去分页、逐项扫描辅助函数。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.86 行为测试")
    sys.exit(0)

r = subprocess.run(["node", str(ROOT / "tests/v0986_behavior.js")],
                   capture_output=True, text=True, timeout=180)
print(r.stdout[-2600:])
if r.stderr.strip():
    print("stderr:", r.stderr[-1200:])
sys.exit(r.returncode)
