#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.0 行为测试包装器：跑 tests/v1000_behavior.js（Node VM 桩，真实执行 web/js/02-media.js）。

覆盖：
  A. 详情页排版（需求1）：演职人员 / 视频推荐 / 季度 标题加粗类、季名常规字重容器、
     迁移提示行已彻底删除
  B. 小窗还原按钮（需求2）：四向外扩图标、鼠标移入才显示、内部移动不闪烁、缩小/还原清标记
  C. 内嵌字幕标签（需求3）：服务端语言标签原样展示、图形字幕走烧录、无标签才回落
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if shutil.which("node") is None:
    print("SKIP: 本机没有 node，跳过 v1.0.0 行为测试")
    sys.exit(0)

env = dict(os.environ)
env.setdefault("VH_ROOT", str(ROOT))
r = subprocess.run(["node", str(ROOT / "tests/v1000_behavior.js")],
                   capture_output=True, text=True, timeout=240, env=env)
print(r.stdout[-9000:])
if r.stderr.strip():
    print("stderr:", r.stderr[-2000:])
sys.exit(r.returncode)
