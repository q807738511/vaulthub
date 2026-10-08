#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.93 行为测试：跑 tests/v0993_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：
  A. 播放占用：setPlayerImmersive / syncPlayerImmersive 的真实状态推导 + CSS 落点
  B. 彻底停止：teardownMediaElement / hardStopVideoPlayback / 浮标 ✕ / 卸载停会话
  C. 剧集归组与同步：seriesGroupKeyOf 真值、buildSeriesShows 归组、整剧同步与即时同步
  D. 侧栏移除后的运行时不回归：布局收敛、自定义模块标签判空、头像菜单入口
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.93 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0993_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
