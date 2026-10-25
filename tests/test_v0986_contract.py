#!/usr/bin/env python3
"""v0.9.87 契约测试：7 项客户修正的静态落点。

1. 通知喇叭位于搜索框与账户/系统设置按钮中间
2. 硬盘信息不再重复展示容量；未映射空间时展示容器所在硬盘的温度
3. 漫画 / 电子书副标题不再展示媒体库映射的空间位置
4. 影视刮削按钮迁到「系统设置 → 媒体库 → 已添加的媒体库」（自动 / 逐项扫描）
5. 音乐专辑海报「上层低分辨率、下层发绿」修复（色度平面写满 + 缓存键升版）
6. 音乐页取消分页（去掉上一页 / 下一页 / 每页 N）
7. 影视媒体编辑支持名称 / 年份并回写辅助刮削
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
TRANSCODE = (ROOT / "media-go/page_transcode.go").read_text(encoding="utf-8")
COVER = (ROOT / "media-go/cover_thumb.go").read_text(encoding="utf-8")
OVERRIDE = (ROOT / "media-go/metadata_override.go").read_text(encoding="utf-8")
CONTAINER_DISK = (ROOT / "media-go/v0986_container_disk.go").read_text(encoding="utf-8")
MAIN_GO = (ROOT / "media-go/main.go").read_text(encoding="utf-8")

fails = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}{(' — ' + detail) if detail else ''}")
        fails.append(name)


print("v0.9.87 契约检查")

# ---------------------------------------------------------------- 1. 喇叭位置
check("1a 顶栏顺序为 搜索框 → 通知喇叭 → 账户/设置按钮",
      # v0.9.94（需求2）：顶栏搜索框缩成放大镜图标（通知左侧），输入框移进搜索弹窗。
      HTML.index('id="tnSearchButton"') < HTML.index('id="tnNotifyBell"') < HTML.index('id="topUserButton"'))
check("1b .tn-actions 是 flex（旧实现没有任何样式，喇叭与头像会各占一行）",
      re.search(r"\.tn-actions\s*\{[^}]*display:\s*flex", CSS) is not None)
check("1c 喇叭两侧对称间距 = 落在搜索框与设置按钮中间",
      re.search(r"\.tn-notify-wrap\s*\{[^}]*margin:\s*0\s+14px", CSS) is not None)
check("1d 窄屏有单独的间距回落",
      re.search(r"@media \(max-width: 760px\)\s*\{\s*\.tn-notify-wrap\s*\{\s*margin:\s*0\s+6px", CSS) is not None)

# ------------------------------------------------- 2. 硬盘容量不重复 / 容器盘温度
check("2a 服务端返回 container_disk", '"container_disk": containerDisk(' in MAIN_GO)
check("2b 容器盘信息含设备/容量/温度与匹配标记",
      all(k in CONTAINER_DISK for k in ['"device"', '"temp"', '"total"', '"matched"']))
check("2c 设备名可解析（sda1→sda / nvme0n1p2→nvme0n1）", "func blockDeviceBase(" in CONTAINER_DISK)
check("2d mount 转义可还原", "func unescapeMount(" in CONTAINER_DISK)
check("2e 前端把「有没有映射空间」传给渲染层",
      "renderDiskTemps(data.disk_temperatures, data.temperatures, { mapped: disks.length, containerDisk: data.container_disk || null })" in FEATURES)
check("2f 未映射空间时温度取容器所在硬盘",
      "if (!mapped && cdisk && Number(cdisk.temp) > 0)" in FEATURES)
check("2g 有映射空间时容量不在温度行重复（改为已映射 N 处）",
      "已映射 ${list.length} 处" in HOME and "已映射" in HOME)
check("2h 未映射空间时才在温度行展示容器盘容量",
      "formatHomeBytes(cd.free)} / ${formatHomeBytes(cd.total)" in HOME)
check("2i 容量明细仍按卷逐项展示一次", 'id="diskCard"' in HTML and "disks.map(d =>" in FEATURES)

# ----------------------------------------------------- 3. 漫画/电子书副标题
check("3a 书刊页头不再渲染映射路径",
      '${lib.path ? `<span>路径 <code>' not in MEDIA)
# v1.0.9（需求3）：书刊页头整块移除（库名 / 大类 / 本视图·全库·本页 / 扫描时间）。
check("3b 页头统计已移除",
      "本视图 <b>${Number(total) || 0}</b>" not in MEDIA and "全库 <b>${Number((counts && counts.all) || 0)}</b>" not in MEDIA)

# --------------------------------------------------- 4. 刮削入口迁入系统设置
# 只判定代码：注释里的历史说明（「库页曾有…」）不应算残留。
MEDIA_CODE = re.sub(r"/\*.*?\*/", " ", MEDIA, flags=re.S)
check("4a 影视页标题不再挂任何按钮参数（注释不参与判定）",
      not re.search(r"mediaLibraryHeading\(lib, `[^`]*`,", MEDIA_CODE))
check("4b 影视页的刮削按钮整块移除（v0.9.90：连指路按钮也不留）",
      "movieScrapeControls" not in MEDIA_CODE and "刮削设置</span>" not in MEDIA_CODE)
check("4c 系统设置库列表提供自动扫描", "onclick=\"autoScanLibrary('${esc(lib.id)}')\"" in HOME)
check("4d 系统设置库列表提供逐项扫描", "onclick=\"openLibraryItemScan('${esc(lib.id)}')\"" in HOME)
check("4e 自动扫描走既有刮削状态机", "await scrapeMovieMetadata(null, lib, files);" in MEDIA)
check("4f 自动扫描保存并恢复库页刮削上下文", "const savedCtx = movieScrapeContext;" in MEDIA and "movieScrapeContext = savedCtx;" in MEDIA)
check("4g 逐项扫描弹窗存在且有单条刮削/编辑入口",
      'id="libItemScanModal"' in HTML and "function scanLibraryEntry(" in MEDIA and "function editLibraryEntry(" in MEDIA)
check("4h 逐项扫描支持仅重试失败项", "function libraryItemScanRetryFailed(" in MEDIA)
check("4i 扫描状态进库列表刮削列", "libraryScanPillHtml" in MEDIA and "libraryScanPillHtml(lib)" in HOME)
check("4j 扫描进度有真实节流（不阻塞 UI）", "libraryScanState[libId] = { running: true" in MEDIA)
check("4k 自动扫描只对影视库生效", "function isScannableLibrary(lib)" in MEDIA and 'lib.type === "movie" || lib.type === "series"' in MEDIA)
check("4l 逐项扫描列表按刮削状态着色", '.lib-scan-row[data-scan-state="failed"]' in CSS)

# ------------------------------------------------------- 5. 封面下半截发绿
check("5a 色度目标行按「色度行号 × 行距」定位（代码里不再用 COffset 二次除 2）",
      "rowStart := cy * dst.CStride" in TRANSCODE
      and "dst.Cb[dst.COffset" not in TRANSCODE and "dst.Cr[dst.COffset" not in TRANSCODE)
check("5b 色度平面宽高按采样比推导", "func ycbcrChromaSize(" in TRANSCODE)
check("5c 色度抽头系数按采样比推导", "func ycbcrChromaFactors(" in TRANSCODE)
check("5d 4:2:0 垂直抽头为 2（旧实现写满上半部分就停）",
      re.search(r"YCbCrSubsampleRatio420:\s*\n\s*return 2, 2", TRANSCODE) is not None)
check("5e 写入越界有保护", "if rowStart < 0 || rowStart >= len(dst.Cb)" in TRANSCODE and "if cx < len(rowCb)" in TRANSCODE)
check("5f 封面缩略缓存键升版（旧缓存整体失效）", 'coverCacheKeyVersion = "ch2"' in COVER)
check("5g 新增色度回归测试", (ROOT / "media-go/v0986_cover_chroma_test.go").exists())

# ------------------------------------------------------------- 6. 音乐去分页
check("6a 音乐渲染不再输出上一页/下一页按钮",
      "← 上一页" not in MEDIA.split("function renderAudioLibraryContent(")[1][:1200])
check("6b 音乐渲染不再有每页数量选择器", 'id="audioPageSize"' not in MEDIA)
check("6c 音乐库不再输出整库展开提示（v1.0.9 需求3）", "音乐库不再分页" not in MEDIA and "已展开全部 ${" not in MEDIA)
check("6d 音乐库一次性补齐整库索引",
      'if (group === "audio" && data.has_more && !fromSession)' in MEDIA)
check("6e 音乐库纳入会话级整库索引缓存",
      '(group === "movie" || group === "comic" || group === "audio") && data.status !== "indexing"' in MEDIA)
check("6f 音乐首屏请求放宽到 500", 'group === "audio" ? 500' in MEDIA)

# --------------------------------------------------- 7. 影视媒体编辑（名称/年份）
check("7a 编辑弹窗有名称/年份字段", 'id="mediaEditTitle"' in HTML and 'id="mediaEditYear"' in HTML)
check("7b 服务端 override 支持 title/year",
      'Title      string   `json:"title,omitempty"`' in OVERRIDE and 'Year       string   `json:"year,omitempty"`' in OVERRIDE)
check("7c 名称清洗：去控制字符、压空白、限长", "func sanitizeOverrideTitle(" in OVERRIDE)
check("7d 年份只接受 4 位有效年份", "func sanitizeOverrideYear(" in OVERRIDE and "n < 1800 || n > 2200" in OVERRIDE)
check("7e override 合并优先于文件名解析", "if in.Title != \"\" {" in OVERRIDE and "m.Title = in.Title" in OVERRIDE)
check("7f 刮削搜索词优先用人工名称", "base.user_title || base.title || movieTitleFromPath(path)" in MEDIA)
check("7g 保存后复位刮削状态并按新名称重刮",
      'scrape_state:"pending",reason:""' in MEDIA and "正在按新名称重刮" in MEDIA)
check("7h 逐项扫描里保存后自动重刮该条", "openLibraryItemScanFresh(" in MEDIA)
check("7i 有名称/年份的 Go 单测", (ROOT / "media-go/v0986_metadata_edit_test.go").exists())

# ------------------------------------------------------------------ i18n 与版本
# v1.0.9（需求10）：阈值说明文案已删除，只保留标签。
for key in ["scrapeMinMatchLabel", "libScanAuto", "libScanItem", "libScanTitle", "libScanAll",
            "libScanRetryFailed", "editTitleLabel", "editYearLabel", "editScrapeHint"]:
    count = len(re.findall(rf"\b{key}:", STATE))
    check(f"8 i18n {key} 三语齐备", count >= 3, f"出现 {count} 次")

print()
if fails:
    print(f"FAIL: {len(fails)} 项未通过：")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("PASS: v0.9.86 七项修正契约全部通过")
