#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.94 行为测试：跑 tests/v0994_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：
  A. 需求1 迷你播放器常驻顶栏：updatePlaybackDock 的真实显示条件（含占满窗口时不显示）
  B. 需求2 搜索弹窗：开合 / Ctrl+K / Esc / 点遮罩关闭 / aria-expanded 同步 / 聚焦
  C. 需求9 多季度分离刮削：季标签解析真值表、标签来源（手工标签 + 目录名）、
     多季归一张卡、卡片名、季详情请求与解析
  D. 需求6 音频播放模式：四模式四图标、不再弹窗、模式写进 data-loop-mode
  E. 需求3/4/5 视频控制条：右下角顺序、无随机/重复、VCD 双三角、播完与上下集规则
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.94 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0994_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
