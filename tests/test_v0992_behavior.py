#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.92 行为测试：跑 tests/v0992_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：
  A. 封面/海报 sidecar：真值表（覆盖 .cover 与 -poster/-fanart/-backdrop/-logo）、
     不进列表、正常漫画/电子书条目不受影响
  B. 跨页「正在播放」：状态持久化、浮标显隐（播放面可见即不出现）、暂停态、
     kind 精确清理、媒体侧续播判定
  C. 影视铺满窗口：viewerShell({player:true}) 带 player-fullbleed，文档阅读器不带
  D. 服务端与分页收尾：活跃窗口、命中刷 mtime、用量快照、翻页守卫与冷静期
  E. 版本与公开文档脱敏
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.92 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0992_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
