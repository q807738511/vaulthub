#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.87 行为测试：跑 tests/v0987_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：刮削地区 → TMDB 语言（含优先级与缓存失效）、刮削队列提示只进通知中心、
通知中心同 key 就地更新、无刮削信息不渲染聚合说明、设置读写 scrape_region。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.87 行为测试")
    sys.exit(0)

r = subprocess.run(["node", str(ROOT / "tests/v0987_behavior.js")],
                   capture_output=True, text=True, timeout=180)
print(r.stdout[-3000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-1200:])
sys.exit(r.returncode)
