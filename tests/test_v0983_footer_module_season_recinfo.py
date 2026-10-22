#!/usr/bin/env python3
"""v0.9.85 契约测试：页脚版本同步 / 自定义模块归位媒体库 / 搜索框图标清除 /
季度提示去除与展示规范 / 推荐「视频信息」弹窗（去左下角关闭 + 多图自适应填充）。"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
GOMAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

FAILS = []


def check(name, cond):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}")
        FAILS.append(name)


HEADER = HTML[HTML.index('<header class="topbar">'):HTML.index("</header>")]
LIB_PANEL = HTML[HTML.index('id="setpanel-library"'):HTML.index("<!-- 外观主题面板 -->")]
TOP_MENU = HEADER[HEADER.index('id="topUserMenu"'):]  # 头像弹窗本体

print("1. 页面最下端同步「关于」里的版本参数")
check("1a 页脚元素存在且带版本容器", 'class="app-footer" id="appFooter"' in HTML and 'id="appFooterVer"' in HTML)
check("1b 页脚在页面内容区最下端（在自定义模块容器之后）",
      HTML.index('id="customViews"') < HTML.index('class="app-footer"'))
check("1c 关于版本行带数据标记", 'class="about-row" data-about-ver="1"' in HTML and 'data-i18n="aboutVer"' in HTML)
check("1d 同步函数读取关于版本并写入页脚",
      "function appVersionLabel()" in STATE and '.about-row[data-about-ver] b' in STATE
      and 'function syncAppFooterVersion()' in STATE and 'getElementById("appFooterVer")' in STATE)
check("1e 启动时调用同步", 'if (typeof syncAppFooterVersion === "function") syncAppFooterVersion();' in BOOT)
_shown = re.findall(r'class="ver">v(\d+)\.(\d+)\.(\d+)', HTML)
_shown += re.findall(r'data-i18n="aboutVer">[^<]*</span><b>v(\d+)\.(\d+)\.(\d+)', HTML)
check("1f 侧栏 / 关于 / 页脚三处版本一致",
      len(_shown) >= 3 and len({tuple(x) for x in _shown}) == 1)
# v1.0.5（需求1）：页尾精简 —— 只保留「当前版本 + 版本功能提示」一行，
# 品牌名与「与关于页保持一致」的说明文字都去掉，并压缩上下留白降低高度。
check("1g 页脚样式齐备（v1.0.5 精简版）", ".app-footer {" in CSS and ".app-footer .ver {" in CSS
      and "@media (max-width:640px) { .app-footer {" in CSS)
check("1h 页尾已去掉「与关于页保持一致」说明与品牌名",
      "af-note" not in HTML and "版本与「系统设置 → 账户与登录 → 关于」中的版本参数保持一致" not in HTML
      and "af-name" not in HTML and "af-note" not in CSS and "af-name" not in CSS)
check("1i 页尾只展示版本 + 功能提示一行", HTML.count('id="appFooterVer"') == 1
      and "v1.0.5 · 遥控零漂移 · 焦点无虚位 · 三档真手感" in HTML)
check("1j 页尾高度已压缩（margin/padding 下调）",
      "margin:10px 0 0" in CSS and "padding:5px 2px 3px" in CSS)

print("2. 自定义模块入口移入「系统设置 → 媒体库」")
# v0.9.93：侧栏移除后，自定义模块入口重新回到头像菜单（原入口在已删除的侧栏里）。
check("2a 头像弹窗承接自定义模块入口",
      "topUserMenuModules()" in TOP_MENU and "自定义模块" in TOP_MENU
      and "topUserMenuGo('custom')" not in TOP_MENU)
check("2b 头像弹窗其余入口保留",
      all(f"topUserMenuGo('{t}')" in TOP_MENU for t in ["library", "look", "account"])
      and "topUserMenuLogout()" in TOP_MENU)
check("2c 媒体库面板新增自定义模块区块",
      'id="setLibCustomModule"' in LIB_PANEL and 'data-i18n="setLibCustomModule"' in LIB_PANEL
      and 'onclick="openModuleModal()"' in LIB_PANEL)
# v1.0.5（需求10）：区块说明段落已按客户要求删除；入口与按钮仍在。
check("2d 区块入口保留（说明段落已删）",
      'data-i18n="setLibCustomModule"' in LIB_PANEL and 'onclick="openModuleModal()"' in LIB_PANEL
      and 'data-i18n="setLibCustomModuleHint"' not in LIB_PANEL)
check("2e 区块显示已添加模块数量并可刷新",
      'id="libCustomModuleCount"' in LIB_PANEL and "renderLibCustomModuleCount()" in LIB_PANEL
      and "function renderLibCustomModuleCount()" in STATE)
check("2f 打开媒体库面板时刷新模块数量",
      'if (key === "library") {\n    if (typeof renderLibCustomModuleCount === "function") renderLibCustomModuleCount();' in STATE)
check("2g 旧 custom 入口仍兼容（打开媒体库 + 模块设置）",
      'if (tab === "custom") {' in STATE and 'switchSetTab("library");' in STATE
      and 'if (typeof openModuleModal === "function") openModuleModal();' in STATE)
check("2h 三个语种语言包都补了新键",
      STATE.count("setLibCustomModule:") == 3
      # v1.0.5（需求10）：模块说明与页尾提示键都已删除
      and STATE.count("setLibCustomModuleHint:") == 0
      and STATE.count("setLibCustomModuleTip:") == 0
      and STATE.count("footerAboutHint:") == 0)

print("3. 清除右上角搜索框内的装饰图标")
check("3a 搜索框内不再有 ⌕ 图标", "⌕" not in HEADER)
# v0.9.94（需求2）：搜索框缩成放大镜图标 + 搜索弹窗（原来这 3 条断言顶栏里的内联搜索框）。
check("3b 搜索入口保留为顶栏放大镜图标 + 搜索弹窗",
      'id="tnSearchButton"' in HEADER and 'id="mediaSearchModal"' in HTML
      and 'id="mediaSearchInput"' in HTML and 'id="topSearch"' not in HEADER)
check("3c 顶栏旧的 label.tn-search 内联框已移除（输入框只在弹窗里）",
      '<label class="tn-search">' not in HTML and HTML.count('id="mediaSearchInput"') == 1)
check("3d 搜索弹窗样式完整（弹出动画 + 图标按钮 + 过滤类保留）",
      ".search-modal-mask.show .search-modal" in CSS and "@keyframes searchModalPop" in CSS
      and ".tn-icon-btn {" in CSS and ".tn-search-hidden {" in CSS and ".tn-search {" not in CSS)

print("4. 季度提示去除 + 季度展示规范")
check("4a 季度提示长文案已删除",
      "点击季度标题展开/收起该季集列表" not in MEDIA and "多季剧集会为每一季生成独立季度卡片" not in MEDIA)
# v0.9.98（口径变更）：多季诊断 / 多季全量刮削已从剧集详情迁到系统设置 → 刮削配置
# （客户明确要求），因此这里断言「新落点存在」+「旧接线已彻底消失」。
# v1.0.0（需求1）：连那行「已移到系统设置」的迁移提示也一并删除 —— 入口搬完已久，留着只是噪音。
# v1.0.5（需求1）：「季度」二字留在最上层季名行行首（加粗），不再是独立 detail-section-h。
check("4b 季度区块保留，多季工具条与迁移提示都已清除（旧入口不残留）",
      '<span class="season-inline-title">季度</span>' in MEDIA
      and '<section><h3 class="detail-section-h">季度</h3></section>' not in MEDIA
      and 'series-plex-moved' not in MEDIA
      and '多季诊断与多季全量刮削已移到' not in MEDIA
      and "seriesPlexToolbarHtml" not in MEDIA
      and "seriesPlexToolbarHtml" not in (ROOT / "web" / "js" / "03-series-plex.js").read_text(encoding="utf-8")
      and 'id="multiSeasonScrapeBlock"' in (ROOT / "index.html").read_text(encoding="utf-8")
      and "function plexSettingsRun" in (ROOT / "web" / "js" / "03-series-plex.js").read_text(encoding="utf-8"))
# v0.9.95（安全审查 N-6）：季卡标题在「第N季」与「共M集」之间插入可选季名，
# 并在标题下渲染季简介 —— 这两个字段此前只被持久化、界面上没有落点。
# v0.9.97：季称号走 seriesPlexSeasonLabel —— 第 0 季在 Plex 口径里是「特别篇」。
# v0.9.99（需求4）：季度标题从独立一行改为「该季首条目的前缀」，文案口径不变（剧名 + 第N季/特别篇 + · 季名 + 共M集）。
check("4c 季名行为「剧名 第N季/特别篇 (· 季名) 共M集」（v1.0.5 起回到独立季名行）",
      '<span class="series-season-title">${esc(show.title)} ${esc(seriesPlexSeasonLabel(season.season))}${seasonName ? ` · ${esc(seasonName)}` : ""}</span> <small>共${epCount}集</small>' in MEDIA
      and 'class="series-season-head"' in MEDIA
      and 'class="series-season-prefix"' not in MEDIA)
check("4c2 季名/季简介从该季分集的刮削元数据汇总并渲染（v0.9.97 N-6 落点）",
      'if (!name && m.season_name) name = String(m.season_name);' in MEDIA
      and 'if (!overview && m.season_overview) overview = String(m.season_overview);' in MEDIA
      and 'return { season, episodes: eps, name, overview };' in MEDIA
      and 'seasonOverview ? `<p class="series-season-overview">${esc(seasonOverview)}</p>` : ""' in MEDIA
      and ".series-season-overview {" in (ROOT / "web" / "css" / "main.css").read_text(encoding="utf-8"))
check("4d 单集网格标题同口径", '<h3>${esc(ctx.showTitle||"")} 第${esc(ctx.seasonNum)}季 · 单集</h3>' in MEDIA)
check("4e 剧集视频信息集数同口径",
      '<dt>季度</dt><dd>${esc(seriesShowSeasonCount(show))} 季 · 共${esc(seriesShowEpisodeCount(show))}集</dd>' in MEDIA)
check("4i 集数按 seasonList 汇总（缓存态只留首个文件也不误报共1集）",
      "function seriesShowEpisodePaths(show)" in MEDIA and "function seriesShowEpisodeCount(show)" in MEDIA
      and "function seriesShowSeasonCount(show)" in MEDIA
      and 'files: show.files?.length ? [{ path: show.files[0].path }] : [],' in MEDIA
      and "seriesShowEpisodePaths(show).forEach(p=>" in MEDIA)
check("4f 剧集海报卡集数同口径", "`共${episodes}集`" in MEDIA)
check("4g 旧的「第 N 季 / N 集」写法已不存在",
      "第 ${esc(season.season)} 季" not in MEDIA and "第 ${esc(ctx.seasonNum)} 季" not in MEDIA)
# v0.9.99（需求4）：折叠按钮变成前缀里的切换按钮，折叠对象是「首条之外」的集列表。
check("4h 展开/收起行为与复选箭头保留",
      "function toggleSeriesSeason(head)" in MEDIA and "series-season-chev" in MEDIA
      and 'querySelector(".series-episode-list")' in MEDIA)

print("5. 推荐「视频信息」弹窗")
INFO = MEDIA[MEDIA.index("function recInfoShotUrls"):MEDIA.index("function buildRecInfoModal")]
BUILD = MEDIA[MEDIA.index("function buildRecInfoModal"):MEDIA.index("function movieRecBadge")]
check("5a 弹窗左下角关闭按钮已移除", ">关闭</button>" not in BUILD)
check("5b 右上角关闭按钮仍在", 'class="close" onclick="closeModal(\'recInfoModal\')"' in BUILD)
check("5c 图集容器与主图并存",
      'class="rec-info-art" id="recInfoArt"' in BUILD and 'id="recInfoPoster"' in BUILD
      and 'class="rec-info-shots" id="recInfoShots" hidden' in BUILD)
check("5d 图集按主图 + 最多 3 张剧照去重",
      "function recInfoShotUrls(" in INFO and "out.indexOf(u) < 0" in INFO and "out.slice(0, 4)" in INFO
      and "shots.slice(1, 4)" in INFO)
check("5e 打开弹窗与详情返回都填充图集",
      "fillRecInfoShots(item);" in MEDIA and "fillRecInfoShots(full);" in MEDIA)
check("5f 剧照来自 TMDB 详情 images 且只留横版",
      "detail.images && detail.images.backdrops" in MEDIA
      and "x.width / x.height >= 1.5 && x.width / x.height <= 1.9" in MEDIA)
check("5g 只有一张图时主图撑满左栏",
      'art.classList.toggle("has-shots", rest.length > 0)' in MEDIA
      and ".rec-info-art:not(.has-shots) > #recInfoPoster { flex:1 1 auto; height:100%;" in CSS)
check("5h Bangumi 回落清空图集",
      'const sw = document.getElementById("recInfoShots");' in MEDIA and "sw.hidden = true;" in MEDIA)
check("5i 图集 CSS 自适应两列网格",
      ".rec-info-shots {" in CSS and "repeat(auto-fit,minmax(132px,1fr))" in CSS
      and "grid-auto-rows:1fr" in CSS and ".rec-info-shot { width:100%; height:100%;" in CSS)
check("5j Go 侧 TMDB 详情追加 images",
      "append_to_response=credits,recommendations,images" in GOMAIN)
check("5k 简介排版与 16:9 画框保留（旧契约不破）",
      ".rec-info-grid img" in CSS and "aspect-ratio:16/9" in CSS.split(".rec-info-grid img")[1][:200]
      and ".rec-info-overview" in CSS)

print("6. 版本")
check("6a 页面与脚本版本一致",
      'VAULTHUB_ASSET_VERSION = "1.0.5"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "1.0.5"' in STATE)
# v0.9.92（上轮发布前审查项）：标语断言升级为「整串完全一致」——
# 旧写法只数 "v0.9.9x · " 出现 3 次，三处文案不一致也能过。
_slogans_6b = re.findall(r"v\d+\.\d+\.\d+ · [^<\"]+", HTML)
check("6b 关于 / 侧栏 / 页脚标语整串一致",
      len(_slogans_6b) == 3 and len(set(_slogans_6b)) == 1)
check("6c Update Log 有 v0.9.85 段",
      (ROOT / "Update Log.md").read_text(encoding="utf-8").startswith("# VaultHub 蜀鼠之家 v1.0.5"))
check("6d Release Notes 存在", (ROOT / ".github/RELEASE_NOTES_0.9.90.md").exists())

if FAILS:
    print(f"\nFAIL: {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("\nPASS: v0.9.85 页脚版本同步 / 模块归位 / 搜索框清理 / 季度规范 / 推荐弹窗 契约全部通过")
