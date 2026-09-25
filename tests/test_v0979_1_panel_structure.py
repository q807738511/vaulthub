#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.79.1 修复版契约（回归守卫）：
根因：index.html 的 setpanel 面板缺少 </div>（setpanel-scrape 未闭合导致 hardware/account
被嵌套进 scrape 内部 → display:none 的面板里内容不可见，表现为「页面为空」）；
同时标签页复用了区块标题的 i18n key（setScrape="刮削与硬件" / setHw="显卡加速"），
导致选项名称不对。

本文件锁定三条约束，防止再次回归：
1. 所有 <div> 必须闭合，且 5 个 setpanel 必须平级（同一嵌套深度）；
2. 标签页必须使用专用 i18n key（setScrapeTab / setHwTab），四语言齐全；
3. 面板内不得出现重复 id。
"""
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")

OK = 0
FAIL = 0
def check(name, cond):
    global OK, FAIL
    if cond:
        OK += 1
    else:
        FAIL += 1
        print("  - FAIL", name)

# ===== 1) div 必须全部闭合 =====
opens = len(re.findall(r"<div\b", HTML))
closes = len(re.findall(r"</div>", HTML))
check(f"1.1 <div> 全部闭合（open={opens} close={closes}）", opens == closes)

# 5 个 setpanel 必须平级（同一深度）
lines = HTML.split("\n")
depth = 0
panel_depth = {}
for i, l in enumerate(lines, start=1):
    for m in re.finditer(r"<div\b[^>]*>", l):
        if "setpanel" in m.group(0):
            panel_depth.setdefault(m.group(0)[:60], []).append(depth)
    depth += len(re.findall(r"<div\b", l)) - len(re.findall(r"</div>", l))

check("1.2 恰好 5 个 setpanel 面板", len(panel_depth) == 5)
depths = {d for v in panel_depth.values() for d in v}
check(f"1.3 全部 setpanel 在同一嵌套深度（实际 {sorted(depths)}）", len(depths) == 1)
# 逐个面板：不得缺少 </div>（否则会被后续面板包住）
for tag, ds in panel_depth.items():
    check(f"1.4 {tag[:34]}… 未被嵌套", ds == [min(depths)])

# ===== 2) 专用 i18n 标签 key =====
check("2.1 标签页使用 setScrapeTab", 'data-i18n="setScrapeTab"' in HTML)
check("2.2 标签页使用 setHwTab", 'data-i18n="setHwTab"' in HTML)
check("2.3 标签页不再复用 setScrape/setHw 作标题",
      'data-i18n="setScrape">刮削配置' not in HTML and 'data-i18n="setHw">硬件配置' not in HTML)
# 每个 key 必须在三种语言字典里各出现一次（zh-CN / zh-TW / en）
for key in ["setScrapeTab", "setHwTab"]:
    n = len(re.findall(rf"\b{key}:", STATE))
    check(f"2.4 i18n {key} 三语言齐全（实际 {n}）", n == 3)

# 标签名实义正确
check("2.5 setScrapeTab 意为刮削配置", 'setScrapeTab: "刮削配置"' in STATE)
check("2.6 setHwTab 意为硬件配置", 'setHwTab: "硬件配置"' in STATE)
check("2.7 账户管理标签为账户管理", 'setAccount: "账户管理"' in STATE)

# ===== 3) 无重复 id（重复 id 会让配置读/写错元素）=====
ids = re.findall(r'\bid="([^"]+)"', HTML)
dupes = {k: v for k, v in Counter(ids).items() if v > 1}
check(f"3.1 无重复 id（重复：{list(dupes)}）", not dupes)

# ===== 4) 关键配置控件存在且唯一 =====
for cid in ["mediaCacheDir", "mediaCacheMaxBytes", "mediaPageCacheMaxBytes",
            "mediaScanMaxDepth", "mediaScraperMode", "hardwareAcceleration",
            "mediaRuntimeStatus", "hardwareRuntimeStatus"]:
    check(f"4.x 控件 {cid} 存在且唯一", ids.count(cid) == 1)

# ===== 5) 面板归属正确 =====
hw = HTML[HTML.index('id="setpanel-hardware"'):HTML.index('id="setpanel-account"')]
acct = HTML[HTML.index('id="setpanel-account"'):]
for kw in ["显卡加速", "NAS 监控", "转码缓存"]:
    check(f"5.x 硬件配置含「{kw}」", kw in hw)
for kw in ["当前登录状态", "登录凭据与鉴权模式", "反向代理服务域名", "关于", "退出登录"]:
    check(f"5.y 账户管理含「{kw}」", kw in acct)
check("5.z 账户管理不含显卡加速", "显卡加速" not in acct)

if FAIL:
    print(f"FAIL: {FAIL} 项 v0.9.79.1 未满足（PASS {OK}）")
    raise SystemExit(1)
print(f"PASS: v0.9.79.1 {OK} 项面板结构/标签契约全部通过")
