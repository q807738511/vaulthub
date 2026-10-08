#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.90 行为测试：跑 tests/v0989_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：阈值辅助口径（识别字符占比为主判据、综合分只挑候选）、
匹配不足 → review（待确认）且不进自动重试、网络/凭据 → failed、
原因文案不再出现「最高 0%」、刮削命中后的本地化流水线（图片按角色落盘 + 写 NFO）、
NFO 目标选择（电影 movie.nfo / 剧集 tvshow.nfo 上一层）、
「媒体信息编辑」原文件名称只读字段与回填、版本推进。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# v0.9.93：把仓库根显式传给 Node 夹具（默认的 /opt/data/vaulthub-github 可能指向旧的检出）。
import os as _os
_os.environ.setdefault("VH_ROOT", str(ROOT))

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.90 行为测试")
    sys.exit(0)

r = subprocess.run(["node", str(ROOT / "tests/v0989_behavior.js")],
                   capture_output=True, text=True, timeout=180)
print(r.stdout[-6000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-1500:])
sys.exit(r.returncode)
