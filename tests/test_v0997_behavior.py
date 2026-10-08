#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.97 行为测试：跑 tests/v0997_behavior.js（Node VM 桩，真实执行
web/js/02-media.js 与 web/js/03-series-plex.js）。

覆盖：
  A. parseSeriesEpisode 的 Plex 口径（方括号忽略 / sXXeYY / 多集合并 / 1x02 / 第X季第Y集 /
     E05 / 纯数字 / 无标记回落文件名）
  B. 季目录优先、Specials 与 Season 00 → 第 0 季
  C. 特别篇称号、Season XX 目录名、集号压缩、缺失集比对
  D. 官方季/集元数据写回本地（多集合并两集名、本地 NFO 默认不覆盖、缺集保留展示）
  E. 服务端方案与前端剧卡的目录对齐、面板渲染
  F. 新旧口径对照（方括号内的季集号、多集合并的标题误判）
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
r = subprocess.run(["node", str(ROOT / "tests/v0997_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-9000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
