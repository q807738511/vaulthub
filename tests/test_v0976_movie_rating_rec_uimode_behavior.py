#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.76 行为测试：跑 tests/v0976_behavior.js（Node VM 桩，推荐+UI 模式+评分同步）。"""
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

# v0.9.93：把仓库根显式传给 Node 夹具（默认的 /opt/data/vaulthub-github 可能指向旧的检出）。
import os as _os
_os.environ.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0976_behavior.js")], capture_output=True, text=True, timeout=120)
print(r.stdout[-3000:])
if r.stderr:
    print("STDERR:", r.stderr[-800:])
raise SystemExit(r.returncode)
