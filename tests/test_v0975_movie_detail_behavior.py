#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.76 行为测试：跑 tests/v0975_behavior.js（Node VM 桩，18 项）。"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
r = subprocess.run(["node", str(ROOT / "tests/v0975_behavior.js")], capture_output=True, text=True, timeout=120)
print(r.stdout[-2200:])
raise SystemExit(r.returncode)
