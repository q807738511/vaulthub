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
check("1g 页脚样式齐备", ".app-footer {" in CSS and ".app-footer .af-note {" in CSS
      and "@media (max-width:640px) { .app-footer {" in CSS)

print("2. 自定义模块入口移入「系统设置 → 媒体库」")
check("2a 头像弹窗不再有自定义模块入口",
      "topUserMenuGo('custom')" not in TOP_MENU and "自定义模块" not in TOP_MENU)
check("2b 头像弹窗其余入口保留",
      all(f"topUserMenuGo('{t}')" in TOP_MENU for t in ["library", "look", "account"])
      and "topUserMenuLogout()" in TOP_MENU)
check("2c 媒体库面板新增自定义模块区块",
      'id="setLibCustomModule"' in LIB_PANEL and 'data-i18n="setLibCustomModule"' in LIB_PANEL
      and 'onclick="openModuleModal()"' in LIB_PANEL)
check("2d 区块说明可用于添加媒体库",
      'data-i18n="setLibCustomModuleHint"' in LIB_PANEL and "等价于新增一个对应大类的媒体库" in LIB_PANEL)
check("2e 区块显示已添加模块数量并可刷新",
      'id="libCustomModuleCount"' in LIB_PANEL and "renderLibCustomModuleCount()" in LIB_PANEL
      and "function renderLibCustomModuleCount()" in STATE)
check("2f 打开媒体库面板时刷新模块数量",
      'if (key === "library") {\n    if (typeof renderLibCustomModuleCount === "function") renderLibCustomModuleCount();' in STATE)
check("2g 旧 custom 入口仍兼容（打开媒体库 + 模块设置）",
      'if (tab === "custom") {' in STATE and 'switchSetTab("library");' in STATE
      and 'if (typeof openModuleModal === "function") openModuleModal();' in STATE)
check("2h 三个语种语言包都补了新键",
      STATE.count("setLibCustomModule:") == 3 and STATE.count("setLibCustomModuleHint:") == 3
      and STATE.count("footerAboutHint:") == 3)

print("3. 清除右上角搜索框内的装饰图标")
check("3a 搜索框内不再有 ⌕ 图标", "⌕" not in HEADER)
check("3b 搜索框与快捷键提示保留（v0.9.85：kbd 改为平台化 Ctrl K / ⌘K）",
      'id="topSearch"' in HEADER and 'id="topSearchKbd"' in HEADER and 'class="tn-search"' in HEADER)
check("3c 搜索框结构未被破坏（input 紧跟 label）",
      '<label class="tn-search">\n      <input id="topSearch"' in HEADER)
check("3d 搜索框样式仍完整", ".tn-search {" in CSS and ".tn-search:focus-within kbd { display: none; }" in CSS)

print("4. 季度提示去除 + 季度展示规范")
check("4a 季度提示长文案已删除",
      "点击季度标题展开/收起该季集列表" not in MEDIA and "多季剧集会为每一季生成独立季度卡片" not in MEDIA)
check("4b 季度区块标题保留", '<section><h3>季度</h3></section>' in MEDIA)
check("4c 季度标题为「剧名 第N季 共M集」",
      '${esc(show.title)} 第${esc(season.season)}季 <small>共${epCount}集</small>' in MEDIA)
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
check("4h 展开/收起行为与复选箭头保留",
      "function toggleSeriesSeason(head)" in MEDIA and "series-season-chev" in MEDIA)

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
      'VAULTHUB_ASSET_VERSION = "0.9.91"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "0.9.91"' in STATE)
check("6b 关于 / 侧栏 / 页脚标语一致",
      HTML.count("v0.9.91 · ") == 3)   # v0.9.90：标语随版本推进，只校验版本前缀 + 三处一致
check("6c Update Log 有 v0.9.85 段",
      (ROOT / "Update Log.md").read_text(encoding="utf-8").startswith("# VaultHub 蜀鼠之家 v0.9.91"))
check("6d Release Notes 存在", (ROOT / ".github/RELEASE_NOTES_0.9.90.md").exists())

if FAILS:
    print(f"\nFAIL: {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("\nPASS: v0.9.85 页脚版本同步 / 模块归位 / 搜索框清理 / 季度规范 / 推荐弹窗 契约全部通过")
