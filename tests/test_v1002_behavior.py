#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.12 行为测试包装器：跑 tests/v1002_behavior.js（Node VM 桩，真实执行 02-media.js / 06-theme.js）。

覆盖：
  A. 季度版式回归（需求1）：季名独立行、全部分集同网格、无首集大图、加粗「季度」只在最上层
  B. 剧名/取路修复（需求2）：seriesFirstVideoPath 跳海报、剧名修复回写整部剧
  C. 推荐定位与播放（需求3）：命中条目自身库 id、▶ 直接播放、点卡片进详情、双评分
  D. 豆瓣评分与综合排序（需求4/5）：键格式对齐服务端、加权综合分、会话缓存、排序结果
  E. 操作模式（需求6/7）：三档图标包差异、data-opmode 落点、与界面规格互不干扰
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v1.0.12 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v1002_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-9000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
