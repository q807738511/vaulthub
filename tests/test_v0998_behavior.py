#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.98 行为测试：跑 tests/v0998_behavior.js（Node VM 桩，真实执行
web/js/02-media.js 与 web/js/03-series-plex.js）。

覆盖：
  A. 原盘（BDMV/ISO）媒体菜单：播放列表参数拼接、选择记忆、菜单渲染（主影片/时长/默认项）、
     非原盘隐藏按钮、打开播放器时自动拉取清单
  B. 本地 NFO 演职人员补全：该不该补的判定（无 cast / 无头像 / 关开关 / empty / 重试窗口）、
     本地优先合并（标题/海报/provider 不被覆盖、演员按姓名合并）、端到端跑一次 scrapeOneMovie
  C. 原盘条目合并（含剧集库）带上原盘根目录与可刮削的原盘标题
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v0.9.98 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v0998_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-9000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
