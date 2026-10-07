#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.91 行为测试：跑 tests/v0991_behavior.js（Node VM 桩，真实执行源文件）。

覆盖：
  A. 解/转码风向标：策略开关、播放计划带 server_transcode、客户端解码标签与「解码路径」行、
     禁用时兼容流回退被拒绝
  B. 下滑自动翻页：到底判定、窗口/分页两种模式、冷却窗口、hasMore 守卫、监听器单例
  C. 剧名修复：旧记录（只有 title）补出 show_title；已有/电影/失败态不动
  D. 长会话内存治理：非当前库的重型缓存与阅读状态索引被释放，当前库保留
  E. 版本与审查项（三处标语完全一致、面板提示行重置底色）
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.91 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0991_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-8000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
