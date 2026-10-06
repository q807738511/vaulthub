#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.90 行为测试：跑 tests/v0990_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：
  A. 阅读进度 / 收藏读取改 O(1) 内存索引（10000 次状态读取只触发常数次 localStorage 访问）
  B. 整库索引分块拉取（默认 2000/块）+ 让出主线程 + 分块进度回调
  C. 书刊架渲染窗口：≤3000 一次全量（「整库可见」不变）；超大库渐进渲染 + 「继续加载」
  D. 剧集刮削命名跟随语言：写入 show_title，展示名不再回落文件名解析值；英文界面得到英文命名
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.90 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0990_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
