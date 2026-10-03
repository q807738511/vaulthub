#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.88 行为测试：跑 tests/v0988_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：TMDB 标题匹配阈值（默认 70%，含年份纠偏与 original_title 打分）、
原盘 ISO/BDMV 识别与合并（ISO + BDMV 同目录只留一条、标题上溯）、
刮削结果服务端持久化（读写形状 / 合并语义 / 批量请求次数 / 封面回灌）、
音乐未命中曲目的重试窗口、匹配阈值设置项与三语文案。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.88 行为测试")
    sys.exit(0)

r = subprocess.run(["node", str(ROOT / "tests/v0988_behavior.js")],
                   capture_output=True, text=True, timeout=180)
print(r.stdout[-6000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-1500:])
sys.exit(r.returncode)
