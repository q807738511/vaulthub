#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.97 行为测试：跑 tests/v0996_behavior.js（Node VM 桩，真实执行 web/js/02-media.js）。

覆盖：
  A. elementRendered 真值表（固定定位元素的 offsetParent 恒为 null，必须按渲染盒子判定）
  B. playbackSurfaceVisible 的影视 / 音频两条分支
  C. syncPlayerImmersive 端到端：播放器打开 → 顶栏回缩；关闭 / 缩成小窗 / 切走视图 → 顶栏恢复；
     只有音频播放 → 顶栏不受影响
  D. 新旧口径对照：同一个固定定位且可见的浮层，旧表达式 false、新实现 true
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.97 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0996_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
