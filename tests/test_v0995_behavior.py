#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.95 行为测试：跑 tests/v0995_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：
  A. playbackSurfaceVisible 的真实判定（02-media.js）：音乐页播放条可见 / 视图不活跃 /
     播放条未显示 / 影视浮层可见 / 浮层被隐藏（offsetParent=null）
  B. 端到端门控：把 02-media.js 的真实判定接进 01-state.js 的 updatePlaybackDock，
     断言「播放面可见时不显示迷你播放器、切到别的视图才显示」这条规则的完整调用链
     （含影视播放器占满窗口、主动关闭两种边界）。
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.95 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0995_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
