#!/usr/bin/env python3
"""v0.9.87 契约测试：3 项客户修正的静态落点。

1. 刮削队列提示移到通知栏，不再展示在媒体库
2. 新增刮削地区配置（中/日/美）并同步到 TMDB 刮削请求
3. 无刮削信息状态下不显示「已按 Plex / Emby 风格…聚合到同一剧集」
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
TOPNAV = (ROOT / "web/js/07-topnav.js").read_text(encoding="utf-8")
MAIN_GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

fails = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}{(' — ' + detail) if detail else ''}")
        fails.append(name)


print("v0.9.87 契约检查")

# ---------------------------------------------- 1. 刮削队列提示只进通知中心
check("1a 库页刮削区不再有队列徽标 DOM（#movieScrapeStatus）",
      'id="movieScrapeStatus"' not in MEDIA)
check("1b 02-media.js 不再写队列徽标节点",
      'getElementById("movieScrapeStatus")' not in MEDIA)
check("1c 队列状态改由通知中心承载（稳定 key，同库一条）",
      "function scrapeQueueNotice(" in MEDIA and "scrape-queue-${" in MEDIA)
check("1d 队列通知写进 updateMovieScrapeStatus（刮削状态机每次刷新都会更新它）",
      "function updateMovieScrapeStatus(files) {" in MEDIA and "scrapeQueueNotice(files)" in MEDIA)
check("1e 通知中心支持同 key 就地更新（不刷屏）",
      "function upsertNotification(" in TOPNAV and "n.key === key" in TOPNAV)
check("1f 就地更新保留已读状态（未读徽标不虚高）",
      "existing.read = false" in TOPNAV and "entry.unread === true" in TOPNAV)
MEDIA_CODE = re.sub(r"/\*.*?\*/", " ", MEDIA, flags=re.S)
check("1g 库页不再有任何刮削按钮/状态（v0.9.90 客户要求：继续删除刮削设置按钮）",
      "movieScrapeControls" not in MEDIA_CODE and "movieScrapeStatus" not in MEDIA_CODE)
check("1h 系统设置里的扫描胶囊不受影响（扫描中 n/m 仍在设置页）",
      "扫描中 ${Number(st.done" in MEDIA)

# ---------------------------------------------- 2. 刮削地区（中/日/美）
check("2a 设置面板有刮削地区下拉框", 'id="scrapeRegion"' in HTML)
for value in ["auto", "cn", "jp", "us"]:
    check(f"2b 地区选项 {value} 存在", f'<option value="{value}" data-i18n="scrapeRegion' in HTML)
check("2c 四个地区选项都带 i18n key（标签另有 scrapeRegionLabel）",
      len(re.findall(r'<option value="(?:auto|cn|jp|us)" data-i18n="scrapeRegion', HTML)) == 4
      and HTML.count('data-i18n="scrapeRegionLabel"') == 1)
check("2d 前端把地区映射成 TMDB 语言",
      "function scrapeRegionLangTag(" in MEDIA and 'if (r === "jp") return "ja-JP";' in MEDIA)
check("2e TMDB 语言标签优先用地区、auto 时跟随界面语言",
      "scrapeRegionLangTag((typeof scraperStatus === \"object\" && scraperStatus) ? scraperStatus.scrape_region : \"\")" in MEDIA)
check("2f 保存设置带上 scrape_region",
      'scrape_region:value("scrapeRegion")||"auto"' in MEDIA)
check("2g 读取设置回填 scrape_region",
      'scrapeRegion:c.scrape_region || "auto"' in MEDIA)
check("2h 服务端 RuntimeConfig 有 scrape_region 字段",
      'ScrapeRegion' in MAIN_GO and 'json:"scrape_region,omitempty"' in MAIN_GO)
check("2i 服务端归一化 + 白名单校验（非法值拒绝而非静默回落）",
      "func normalizeScrapeRegion(" in MAIN_GO and "func validScrapeRegion(" in MAIN_GO
      and 'return fmt.Errorf("invalid scrape region")' in MAIN_GO)
check("2j 服务端地区 → TMDB language 映射",
      "func scrapeRegionLanguage(" in MAIN_GO and 'case "jp":' in MAIN_GO
      and 'return "ja-JP"' in MAIN_GO)
check("2k tmdbLanguage 白名单放行 ja-JP",
      re.search(r'case "ja", "ja-jp":\s*\n\s*return "ja-JP"', MAIN_GO) is not None)
check("2l tmdb 处理器：显式 lang > region 参数 > 已配置地区 > zh-CN",
      "region := a.scrapeRegion" in MAIN_GO and "scrapeRegionLanguage(region)" in MAIN_GO)
check("2m 快照把地区与对应语言一起下发（前端可直接用）",
      re.search(r'"scrape_region":\s+a\.scrapeRegion', MAIN_GO) is not None
      and re.search(r'"scrape_region_lang":\s+scrapeRegionLanguage\(a\.scrapeRegion\)', MAIN_GO) is not None)
check("2n 保存后立即写入内存（无需重启即生效）",
      "a.scrapeRegion = normalizeScrapeRegion(c.ScrapeRegion)" in MAIN_GO)
check("2o TMDB 请求 URL 仍带 language 参数",
      '"?language=" + url.QueryEscape(lang)' in MAIN_GO)
check("2p 有刮削地区的 Go 单测", (ROOT / "media-go/v0987_scrape_region_test.go").exists())

# ---------------------------------------------- 3. 无刮削信息不显示聚合说明
check("3a 聚合说明的展示判定集中在 seriesHeroOverview",
      "function seriesHeroOverview(show) {" in MEDIA)
check("3b 有真实简介时优先用简介",
      'if (own) return own;' in MEDIA)
check("3c 无刮削信息时返回空串（不渲染聚合说明）",
      'return hasScrapedInfo(show) ? "已按 Plex / Emby 风格根据根目录、Season 01 和 S01E01 规则聚合到同一剧集。" : "";' in MEDIA)
check("3d 剧集详情用该判定做首屏介绍",
      "overview:seriesHeroOverview(show)" in MEDIA)
check("3e 无简介时整段不渲染 <p>（剧集）",
      'meta.media_type === "series" ? "" : "暂无电影介绍' in MEDIA and "heroText ? `<p>" in MEDIA)
check("3f 工艺信息判定函数存在（文件名展示不算刮削信息）",
      "function hasScrapedInfo(meta) {" in MEDIA and "/文件名/.test(provider)" in MEDIA)
check("3g 电影页原有兜底文案未被改动",
      'meta.media_type === "series" ? "" : "暂无电影介绍；可在系统设置中配置 TMDB API 进行刮削。"' in MEDIA)

# ---------------------------------------------- i18n 与版本
for key in ["scrapeRegionLabel", "scrapeRegionAuto", "scrapeRegionCn", "scrapeRegionJp",
            "scrapeRegionUs", "notifyScrapeQueue"]:
    count = len(re.findall(rf"\b{key}:", STATE))
    check(f"4 i18n {key} 三语齐备", count >= 3, f"出现 {count} 次")
check("4b 队列通知文案带 {ok}/{total} 占位符",
      re.search(r'notifyScrapeQueue: "[^"]*\{ok\}[^"]*\{total\}', STATE) is not None)

print()
if fails:
    print(f"FAIL: {len(fails)} 项未通过：")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("PASS: v0.9.87 三项修正契约全部通过")
