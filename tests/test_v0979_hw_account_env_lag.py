#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.80 契约：
1) 硬件配置(setpanel-hardware) 包含 显卡加速/NAS监控/转码缓存。
2) 账户管理(setpanel-account) 包含 当前登录状态/登录凭据与鉴权模式/反向代理服务域名/关于/退出登录。
3) vaulthub.env 停用：docker-compose.yml 不再引用 env_file。
4) 卡顿优化 + 运行时新增 page_cache_max_bytes / scan_max_depth（在线可改，替代 .env）。
凡涉及修改 .env 的场景均已迁移到 Web 可编辑位置。
"""
from pathlib import Path
import re
ROOT = Path(__file__).resolve().parent.parent

def rd(p):
    return (ROOT / p).read_text(encoding="utf-8", errors="ignore")

HTML = rd("index.html")
COMPOSE = rd("docker-compose.yml")

OK = 0
FAIL = 0
def check(name, cond):
    global OK, FAIL
    if cond:
        OK += 1
    else:
        FAIL += 1
        print("  - FAIL", name)

hw = HTML[HTML.index('id="setpanel-hardware"'):HTML.index('id="setpanel-account"')]
acct = HTML[HTML.index('id="setpanel-account"'):]

# ===== 1) 硬件配置 =====
check("1.1 显卡加速 在硬件配置", "显卡加速" in hw)
check("1.2 NAS 监控 在硬件配置", "NAS 监控" in hw)
check("1.3 转码缓存 在硬件配置", "转码缓存" in hw)
check("1.4 弱网/测速 不在硬件配置(已归刮削)", "weakNetworkMode" not in hw)
check("1.5 归档页缓存配额在线可改", "mediaPageCacheMaxBytes" in hw)
check("1.6 扫描最大深度在线可改", "mediaScanMaxDepth" in hw)

# ===== 2) 账户管理 =====
for kw in ["当前登录状态", "登录凭据与鉴权模式", "反向代理服务域名", "退出登录"]:
    check(f"2.x 账户管理含「{kw}」", kw in acct)

# ===== 3) vaulthub.env 停用 =====
check("3.1 compose 不再有 env_file 段", not re.search(r"^\s+env_file:", COMPOSE, re.M))

# ===== 4) 卡顿优化 + 运行时字段 =====
GOMAIN = rd("media-go/main.go").replace("\n", "")
check("4.1 DSN 含 cache_size 调优", "_pragma=cache_size(-16384)" in GOMAIN and "temp_store(MEMORY)" in GOMAIN)
check("4.2 files 表新增 lower(path) 函数索引", "idx_files_lib_lower_path" in rd("media-go/main.go"))
check("4.3 归档页缓存默认 16GiB(不再 4GiB)", "16*1024*1024*1024" in rd("media-go/page_handler.go"))
check("4.4 RuntimeConfig 含 ScanMaxDepth", "ScanMaxDepth" in rd("media-go/main.go"))
check("4.5 JS 下发 page_cache_max_bytes", "page_cache_max_bytes" in rd("web/js/02-media.js"))

if FAIL:
    print(f"FAIL: {FAIL} 项 v0.9.80 未满足")
    print(f"PASS: {OK} 项通过")
    raise SystemExit(1)
print(f"PASS: v0.9.80 {OK} 项契约全部通过")
