#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# v0.9.97 契约测试：影视播放时顶栏自动让位（含根因回归护栏）+ 搜索入口归一与放大镜图标修复
# 口径：断言「新实现存在」且「旧实现已不存在」；历史断言按新口径重定向。
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILED = []

def rd(p):
    with io.open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()

def check(label, cond, detail=""):
    if cond:
        print(f"  ✔ {label}")
    else:
        print(f"  ✗ {label}" + (f"  [{detail}]" if detail else ""))
        FAILED.append(label)

HTML = rd("index.html")
CSS = rd("web/css/main.css")
M = rd("web/js/02-media.js")
S = rd("web/js/01-state.js")
# v0.9.98：同上 —— 内容断言指向 v0.9.97 的历史说明；当前版存在性版本无关地断言。
NOTES = rd(".github/RELEASE_NOTES_0.9.97.md")
import re as _re
_CUR = _re.search(r'VAULTHUB_ASSET_VERSION = "([0-9.]+)"', HTML).group(1)
check("4f 当前版本的发布说明存在且够长",
      os.path.exists(os.path.join(ROOT, f".github/RELEASE_NOTES_{_CUR}.md"))
      and len(open(os.path.join(ROOT, f".github/RELEASE_NOTES_{_CUR}.md"), encoding="utf-8").read()) >= 500)
LOG = rd("Update Log.md")
ACTIONS = HTML[HTML.index('<div class="tn-actions">'):HTML.index("</header>")]
NAV = HTML[HTML.index('<nav class="tn-nav" aria-label="主导航">'):HTML.index("</nav>")]

print("== 1. 需求2：搜索入口归一（去左侧）==")
check("1a 左侧导航里的「媒体搜索」按钮已移除", 'data-topnav="search"' not in HTML)
check("1b 顶栏一级导航只剩 首页 / PT",
      'data-topnav="home"' in NAV and 'data-topnav="pt"' in NAV
      and NAV.count('class="tn-item') == 2)
check("1c 右侧放大镜按钮仍在 .tn-actions 且接线弹窗",
      'id="tnSearchButton"' in ACTIONS and "toggleMediaSearchModal()" in ACTIONS)
check("1d 入口不丢：旧书签落点 #view-search 仍在、openMediaSearch 仍弹窗",
      'id="view-search"' in HTML and "openMediaSearchModal();" in M.split("function openMediaSearch()")[1][:600])
check("1e i18n 词条保留（navMediaSearch 三语言都在，避免旧引用取不到）",
      S.count("navMediaSearch:") == 3)

print("\n== 2. 需求2：放大镜图标修复 ==")
# 取「搜索按钮」自己的 svg（.tn-actions 里第一个 svg 是迷你播放器的播放图标，不能顺手拿）
_SEARCH_BLOCK = ACTIONS[ACTIONS.index('id="tnSearchButton"'):]
SEARCH_SVG = _SEARCH_BLOCK[_SEARCH_BLOCK.index("<svg"):_SEARCH_BLOCK.index("</svg>")]
check("2a 图标显式声明无填充 + currentColor 描边",
      'fill="none"' in SEARCH_SVG and 'stroke="currentColor"' in SEARCH_SVG)
check("2b 图标有描边宽度与圆头线帽（否则手柄画不出来）",
      'stroke-width=' in SEARCH_SVG and 'stroke-linecap="round"' in SEARCH_SVG)
check("2c 镜头 + 手柄两个图元都在", "<circle" in SEARCH_SVG and "<path" in SEARCH_SVG)
check("2d CSS 侧同款兜底（行内属性被覆盖也不会退回实心黑点）",
      re.search(r"\.tn-icon-btn \.tn-svg \{[^}]*fill: *none; *stroke: *currentColor", CSS) is not None)
check("2e 旧放大镜几何已不存在（cx=10.6 那个无属性裸图标）", 'cx="10.6"' not in HTML)
check("2f 顶栏第二个同类缺陷（头像菜单齿轮图标）也已补描边",
      'class="ic ic-gear">' in HTML and '<svg class="vc-svg tn-svg"' in HTML.split("ic-gear")[1][:600]
      and 'stroke="currentColor" stroke-width="1.6"' in HTML.split("ic-gear")[1][:600])

print("\n== 3. 需求1：渲染可见性判定（根因回归护栏）==")
check("3a 新增 elementRendered()，按渲染盒子判定",
      "function elementRendered(el)" in M and "getClientRects" in M.split("function elementRendered(el)")[1][:600])
check("3b 影视播放面判定改用 elementRendered（不再用 offsetParent）",
      "return elementRendered(overlay);" in M)
check("3c 旧判定 overlay.offsetParent !== null 已彻底消失",
      "overlay.offsetParent" not in M)
PSV = M.split("function playbackSurfaceVisible(cur)")[1].split("\n}")[0]
check("3d playbackSurfaceVisible 函数体内不再用 offsetParent 做判定（注释里解释根因不算）",
      "offsetParent !==" not in PSV and "offsetParent === null" not in PSV)
check("3e 新增 expandedVideoPlayerVisible()：打开且未缩成小窗即算完整可见",
      "function expandedVideoPlayerVisible()" in M
      and 'querySelectorAll(".media-reader-overlay.movie-player")' in M
      and "return !overlay.classList.contains(\"video-minimized\");" in M.split("function expandedVideoPlayerVisible()")[1][:700]
      # 缩成小窗必须把顶栏还回来（v0.9.93 口径），不能被“两者取或”吞掉
      and "if (overlay.classList.contains(\"video-minimized\")) continue;" not in M)
check("3f syncPlayerImmersive 以 expandedVideoPlayerVisible 单一来源决定回缩",
      "on = expandedVideoPlayerVisible();" in M
      # 旧的「两者取或」写法会让缩成小窗的状态仍判沉浸（顶栏不还），已废弃
      and "on = surfaceVisible || expandedVideoPlayerVisible();" not in M)
check("3g 关闭播放器显式恢复顶栏",
      "setPlayerImmersive(false);" in M.split("function closeVideoPlayer(el)")[1][:600])
check("3h 沉浸态四件套：类别切换 + --topbar-h 归零 + 顶栏滑出 + 真的看不见",
      'document.body.classList.toggle("player-immersive", next);' in M
      and "body.player-immersive { --topbar-h: 0px; }" in CSS
      and "body.player-immersive .topbar { transform: translateY(-100%);" in CSS
      # v0.9.97：0 高度盒子挡不住溢出子元素与 1px 底边线，回缩必须补齐这两项
      and "visibility: hidden; border-bottom-color: transparent;" in CSS)
check("3i 音乐路径未被改动（仍看 #audio-bottom-player 的 show）",
      'const bar = document.getElementById("audio-bottom-player");' in PSV
      and 'bar.classList.contains("show")' in PSV)
check("3j 浮标口门口径同步（注释/判定仍以 immersive 为准）",
      "const show = !!cur && !immersive && !surfaceVisible;" in S)
check("3k 其它 offsetParent 用法未被误伤（分页宿主仍用 display 判据的元素）",
      "host.offsetParent !== null" in M)

print("\n== 4. 版本与文档 ==")
check("4a 版本串 ?v=1.0.1（≥10 处）且无其它版本串",
      len(re.findall(r"\?v=1\.0\.1", HTML)) >= 10
      and set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.1"})
check("4b ASSET_VERSION / SCRIPT_VERSION = 0.9.97",
      'VAULTHUB_ASSET_VERSION = "1.0.1"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.1"' in S)
check("4c 当前标语 ×3 且历史标语已清除",
      HTML.count("v1.0.1 · 季度中文序号与小窗96px微调") == 3
      and "v0.9.97 · 播放时顶栏自动让位" not in HTML and "v0.9.97 · 迷你播放器按需出现" not in HTML
      and "v0.9.98 · 原盘播放菜单与演职人员补全" not in HTML)
check("4d 发布说明存在且覆盖本轮需求",
      "Plex" in NOTES and "缺失集" in NOTES and "方括号" in NOTES)
check("4e Update Log 含 v0.9.97 段落", "v1.0.1" in LOG and "## 1. 播放视频时顶栏自动让位" in LOG)

print("\n== 5. 洗版自查（本仓禁止真实域名 / 内网 IP / 卷路径字面量）==")
for name, text in (("测试文件自身", rd("tests/test_v0996_contract.py")),):
    bad = [p for p in ("enged" + ".top", "192" + ".168.", "/vol" + "1/", "/vol" + "3/") if p in text]
    check(f"5a {name}不含禁用字面量", not bad, str(bad))

print()
if FAILED:
    print(f"v0.9.97 契约测试失败 {len(FAILED)} 项：" + "、" .join(FAILED))
    sys.exit(1)
print("v0.9.97 契约测试全部通过")
