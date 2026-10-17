#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.85 契约测试（一）：画面清晰度与色彩档位（原「省流」）/ 首页文案修正 / 无元数据刮削链路。

四项用户诉求逐条对应：
  1) 无元数据资源刮削异常 → 刮削状态机（可重试、并发、节流、原盘合并、原盘结构不入库）
  2) 省流改为画面清晰度，最低档无色彩、可随时切回
  3) 首页「正在进行中的操作」→「正在播放」
  4) 首页选项右侧小字提示全部移除
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
QUALITY = (ROOT / "web/js/03-quality.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
SCAN = (ROOT / "media-go/scan_walk.go").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")

FAILS = []


def check(name, cond):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}")
        FAILS.append(name)


print("1. 首页文案：「正在进行中的操作」→「正在播放」（第 3 项）")
check("1a 首页第二栏标题为「正在播放」", '<span data-i18n="secNow">正在播放</span>' in HTML)
check("1b 简体 i18n 同步", 'secNow: "正在播放"' in STATE and 'secNow: "正在进行中的操作"' not in STATE)
check("1c 繁体/英文 i18n 同步", 'secNow: "正在進行中的操作"' not in STATE and 'secNow: "Operations in progress"' not in STATE)
check("1d 空态文案保留", 'nowEmpty:' in STATE)

print("2. 首页选项右侧小字提示全部移除（第 4 项）")
for badge in ["nasBadge", "diskSource", "nowBadge"]:
    check(f"2{chr(97 + ['nasBadge','diskSource','nowBadge'].index(badge))} 移除 {badge} 徽标",
          f'id="{badge}"' not in HTML)
check("2d 移除「最近入库」三个副标题徽标", "secRecentBookSub" not in HTML and "secRecentVideoSub" not in HTML and "secRecentAudioSub" not in HTML)
check("2e 章节标题不再渲染静态小字", HTML.count('class="badge" data-i18n="secRecent') == 0)
check("2f 徽标写入方改为可选元素（不再空指针崩溃）",
      'const badge = document.getElementById("nasBadge");\n  if (!badge) return;' in FEATURES
      and 'const diskSourceBadge = document.getElementById("diskSource"); if (diskSourceBadge)' in FEATURES)
check("2g 「更多 ›」入口保留", HTML.count('class="more" onclick="switchView(') >= 3)
check("2h 网络接口名等动态徽标未误删", 'id="netInterface"' in HTML)

print("3. 画面清晰度与色彩档位（第 2 项：省流重做）")
check("3a 档位模块文件存在并已引入", "/web/js/03-quality.js" in HTML and "QUALITY_PROFILE" in QUALITY)
check("3b 四档 + 自动", all(k in QUALITY for k in ['original:', 'high:', 'smooth:', 'minimal:'])
      and 'QUALITY_ORDER = ["auto", "original", "high", "smooth", "minimal"]' in QUALITY)
check("3c 色彩倍率：原画/高清 1、流畅 0.7、极省 0（无色彩）",
      'color: 1, gray: false' in QUALITY and 'color: 0.7, gray: false' in QUALITY and 'color: 0, gray: true' in QUALITY)
check("3d 最低档为无色彩（saturate 0）且保留清晰度",
      'saturate(var(--vh-quality-color, 1))' in CSS and 'html[data-quality="minimal"]' in CSS and 'saturate(0) contrast(1.04)' in CSS)
check("3e 档位落地到 <html>（data-quality + 色彩变量）",
      'root.dataset.quality = id' in QUALITY and '--vh-quality-color' in QUALITY)
check("3f 可随时切回：恢复原画 + 循环档位 + 设置项",
      "function resetQualityLevel()" in QUALITY and "function cycleQualityLevel(" in QUALITY and 'id="qualityLevel"' in HTML)
check("3g 切档立即重渲染（不必刷新浏览器才有新清晰度/色彩）", "function rerenderForQuality()" in QUALITY and "loadLocalFiles(group, lib, 0)" in QUALITY)
check("3h 启动即应用档位（首屏不跳变）", 'if (typeof initQualityLevel === "function") initQualityLevel();' in BOOT)
check("3i 阅读页清晰度跟档位（显式档位优先，自动档回落旧省流判定）",
      "const explicit = qualityPageWidth();" in MEDIA and "if (explicit !== null) return Number(explicit) || 0;" in MEDIA)
check("3j 阅读器按钮循环档位并保留小白鼠兼容分支", "cycleQualityLevel({ rerender: false })" in MEDIA)
check("3k 封面取图宽度随档位收紧（换档 → URL 变化 → 必然重新取图）",
      'Number(width) <= 640 && typeof qualityCoverWidth === "function"' in MEDIA
      and "qualityCoverWidth(requested)" in MEDIA)
check("3l 音频码率跟档位（自动档仍走测速）",
      'const explicit = qualityAudioKbps();' in MEDIA and "if (explicit !== null) return Number(explicit) || 0;" in MEDIA)
check("3m 视频播放器初始画质跟档位", 'data-video-quality="${typeof qualityVideoPreset === "function"' in MEDIA)
check("3n 设置页写明清晰度与色彩映射 + 一键恢复",
      "画面清晰度与色彩" in HTML and "恢复原画（完整色彩）" in HTML and "无色彩（灰度）" in HTML)
check("3o 测速后同步刷新档位呈现", "if (typeof applyQualityLevel === \"function\") applyQualityLevel();" in MEDIA)

print("4. 无元数据资源刮削（第 1 项）")
check("4a 刮削状态机常量（重试上限/退避/节流/并发）",
      "MOVIE_SCRAPE_MAX_ATTEMPTS = 3" in MEDIA and "MOVIE_SCRAPE_RETRY_MS = 10 * 60 * 1000" in MEDIA
      and "MOVIE_RENDER_THROTTLE_MS = 400" in MEDIA and "MOVIE_SCRAPE_CONCURRENCY = 3" in MEDIA)
check("4b 失败条目下次进库自动重试（不再一次失败即永久放弃）",
      'state === "ok" || state === "skip"' in MEDIA and "attempts < MOVIE_SCRAPE_MAX_ATTEMPTS" in MEDIA)
SCRAPE_BLOCK = MEDIA[MEDIA.index("async function scrapeOneMovie("):MEDIA.index("async function scrapeMovieMetadata(")]
check("4c 刮削请求改用 no-store（空结果不再被浏览器缓存成永久失败）",
      'cache: "no-store", credentials: "same-origin"' in SCRAPE_BLOCK
      and "force-cache" not in SCRAPE_BLOCK
      and 'type=${encodeURIComponent(mediaType)}`, { cache:"force-cache" }' not in MEDIA)
check("4d 不再把待刮条目预写成「等待刮削」再落盘", 'provider: "文件名展示（等待豆瓣刮削）"' not in MEDIA)
check("4e 无意义标题直接跳过，不浪费请求", "function scrapableMovieTitle(" in MEDIA and '"文件名无可用标题"' in MEDIA)
check("4f 蓝光原盘片段合并为一条（一部原盘不再是 600+ 条影片）",
      "function collapseDiscFragments(" in MEDIA and "function discFolderOf(" in MEDIA
      and 'if (file && file.disc) { out.push(file); return; }' in MEDIA)
check("4g 原盘条目标题取原盘目录名（片段名刮不到）", "const disc = discFolderOf(path);" in MEDIA)
check("4h 进库前先合并原盘", 'files = collapseDiscFragments(files);' in MEDIA)
check("4i 服务端扫描跳过原盘结构文件（.mpls/.clpi/.bdmv…）",
      "bluRayStructuralExt" in SCAN and "func skipIndexFile(" in SCAN and "func inBluRayStructure(" in SCAN)
check("4j 两个遍历函数都做了拦截", SCAN.count("if skipIndexFile(rel) {") == 2)
check("4k 保留原盘真实视频片段（.m2ts 不跳过）", '".m2ts": true' not in SCAN and '".mpls": true' in SCAN)
# v0.9.86（客户要求）：整库「重新刮削 / 重试失败项」按钮从影视页迁走 ——
# 入口统一在「系统设置 → 媒体库 → 已添加的媒体库」的自动 / 逐项扫描。
# 只判定代码：注释里保留「为什么删」的说明，不应被当成残留实现。
MEDIA_CODE = re.sub(r"/\*.*?\*/", " ", MEDIA, flags=re.S)
check("4l 影视页头的刮削按钮整块移除（v0.9.90 客户要求）",
      "movieScrapeControls" not in MEDIA_CODE and "刮削设置</span>" not in MEDIA_CODE)
check("4m 电影库与剧集库标题只带库名与统计（不再挂刮削入口）",
      MEDIA.count("movieScrapeControls(files)") == 0 and MEDIA.count("mediaLibraryHeading(lib, ") >= 2)
check("4m2 系统设置内提供自动扫描与逐项扫描",
      "function autoScanLibrary(" in MEDIA and "function openLibraryItemScan(" in MEDIA
      and "autoScanLibrary('${esc(lib.id)}')" in HOME and "openLibraryItemScan('${esc(lib.id)}')" in HOME)
check("4n 旧的死代码签名已替换（带 scope 参数）", "function refreshMovieMetadata(scope)" in MEDIA)
# v0.9.87：库页的刮削队列徽标（#movieScrapeStatus）整体移除，队列状态改由顶栏通知中心承载。
check("4o 刮削状态经通知中心可见（库页不再有队列徽标）",
      "function movieScrapeSummary(" in MEDIA
      and 'id="movieScrapeStatus"' not in MEDIA
      and "function scrapeQueueNotice(" in MEDIA
      and "scrape-queue-" in MEDIA)
check("4p 失败原因可诊断（凭据/未命中/请求失败）",
      '"TMDB 凭据无效' in MEDIA and '"TMDB 未命中该标题"' in MEDIA and '"未配置 TMDB 凭据"' in MEDIA)
check("4q 渲染改节流（不再每条整库重绘）", "function scheduleMovieRender(" in MEDIA and "clearTimeout(movieRenderTimer)" in MEDIA)
check("4r 原盘片段数在卡片上可见", "discSubtitle(file)" in MEDIA and "原盘 · ${n} 个片段" in MEDIA)
check("4s 原盘镜像（ISO）在卡片上单独标注", 'return n > 1 ? `原盘 · ISO · ${n} 个镜像` : "原盘 · ISO";' in MEDIA)
check("4t ISO 与同目录 BDMV 并存时标注双形态", "原盘 · ISO + BDMV" in MEDIA)

print("5. 版本与文档")
check("5a 版本号已升至 0.9.90", 'VAULTHUB_ASSET_VERSION = "1.0.3"' in HTML and 'const VAULTHUB_SCRIPT_VERSION = "1.0.3"' in STATE)
# v0.9.92（上轮审查项）：整串一致，而不是只数版本前缀。
_slogans_5b = re.findall(r"v\d+\.\d+\.\d+ · [^<\"]+", HTML)
check("5b 关于 / 侧栏 / 页脚标语整串一致",
      len(_slogans_5b) == 3 and len(set(_slogans_5b)) == 1)
check("5c 脚本引用带新版本号", 'web/js/03-quality.js?v=1.0.3' in HTML and 'web/js/02-media.js?v=1.0.3' in HTML)
check("5d Update Log 顶部为 v0.9.90", LOG.startswith("# VaultHub 蜀鼠之家 v1.0.3"))
check("5e Release Notes 存在", (ROOT / ".github/RELEASE_NOTES_0.9.90.md").exists())

if FAILS:
    print(f"\nFAIL: {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("\nPASS: v0.9.85 刮削状态机 / 画面清晰度档位 / 首页文案 契约全部通过")
