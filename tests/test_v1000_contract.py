#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.0 契约测试：正式版版本口径、三处修正的静态契约、旧实现确实被移除、洗版自查。

只做静态契约断言；行为验证在 tests/v1000_behavior.js 与真实容器验证里。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ok = True


def check(name, cond, extra=""):
    global ok
    if cond:
        print("PASS:", name)
    else:
        ok = False
        print("FAIL:", name, extra)


def rd(p):
    return (ROOT / p).read_text(encoding="utf-8")


HTML = rd("index.html")
STATE = rd("web/js/01-state.js")
MEDIA = rd("web/js/02-media.js")
CSS = rd("web/css/main.css")
GO = rd("media-go/main.go")
LOG = rd("Update Log.md")
NOTES = rd(".github/RELEASE_NOTES_1.0.0.md")

print("== 1. 正式版版本口径 ==")
check("1a index.html 资源版本 ≥11 处且为本版",
      len(re.findall(r"\?v=1\.0\.5", HTML)) >= 11 and "?v=0.9.99" not in HTML,
      len(re.findall(r"\?v=1\.0\.5", HTML)))
check("1b 全部静态资源版本串只出现本版",
      set(re.findall(r"\?v=([0-9.]+)", HTML)) == {"1.0.5"})
check("1c ASSET / SCRIPT 版本一致",
      'window.VAULTHUB_ASSET_VERSION = "1.0.5";' in HTML
      and 'const VAULTHUB_SCRIPT_VERSION = "1.0.5";' in STATE)
check("1d 页面标语 ×3 且整串一致",
      len(re.findall(r"v1\.0\.5 · [^<\"]+", HTML)) == 3
      and len(set(re.findall(r"v1\.0\.5 · [^<\"]+", HTML))) == 1,
      sorted(set(re.findall(r"v1\.0\.5 · [^<\"]+", HTML))))
check("1e 上一版标语已清除", "v0.9.99 · " not in HTML)
check("1f 安装 / 升级脚本版本同步",
      'VERSION="v1.0.5"' in rd("scripts/install.sh") and 'VERSION="v1.0.5"' in rd("scripts/upgrade.sh"))
check("1g Update Log 顶部为本版（仓库格式：# VaultHub 蜀鼠之家 vX 置顶）",
      LOG.startswith("# VaultHub 蜀鼠之家 v1.0.5"))
check("1h 发布说明按本版命名且够长",
      len(NOTES) >= 2000 and (ROOT / ".github/RELEASE_NOTES_1.0.0.md").exists(), len(NOTES))

print("\n== 2. 需求1：详情页标题加粗与季度排版 ==")
check("2a 区块标题加粗样式存在",
      ".movie-detail-scroll .detail-section-h { font-weight:700; }" in CSS)
check("2b 演职人员 / 视频推荐 标题都带该类（季度标题另带 inline 类，见 2c）",
      MEDIA.count('class="detail-section-h"') >= 2, MEDIA.count('class="detail-section-h"'))
# v1.0.5（需求1）：「季度」二字改为季名行内的加粗 span，不再是 h3 区块标题。
INLINE_HEADING = '<span class="season-inline-title">季度</span>'
check("2c 季度标题不再是独立成行的区块",
      '<section><h3 class="detail-section-h">季度</h3></section>' not in MEDIA)
check("2c2 「季度」并入最上层那一季的季名行（加粗仅「季度」二字）",
      '${isFirst ? ' + "'" + '<span class="season-inline-title">季度</span>' + "'" + ' : ""}' in MEDIA
      and MEDIA.count(INLINE_HEADING) == 1
      and '.series-season-head .season-inline-title { font-weight: 700;' in CSS)
check("2c3 最上层那一季没有剧集时季名行仍然渲染（标题不会整体消失）",
      '<h3 class="series-season-head" onclick="toggleSeriesSeason(this)">${head}</h3>' in MEDIA
      and "${eps.length ? `<div ${listClass}" in MEDIA)
check("2d 迁移提示行已删除（渲染与样式都不再引用）",
      "series-plex-moved" not in MEDIA and "series-plex-moved" not in CSS
      and "多季诊断与多季全量刮削已移到" not in MEDIA)
check("2e 季名改为常规字重容器（不再是 <b>）",
      '<span class="series-season-title">${esc(show.title)} ${esc(seriesPlexSeasonLabel(season.season))}' in MEDIA
      and ".series-season-head .series-season-title { font-weight: 400;" in CSS)
check("2f 季度条整体常规字重（加粗只留给区块标题）",
      "font:400 11.5px/1.6 inherit" in CSS and ".series-season-toggle small { color:var(--text2); font-weight:400; }" in CSS)
check("2g 季名行为「每季一次」口径（回归 0.9.89 季名行）",
      "series-season-head" in MEDIA and "series-season-prefix" not in MEDIA and "is-season-top" not in MEDIA)

print("\n== 3. 需求2：小窗还原按钮居中 + 鼠标移入才显示 ==")
check("3a 居中压在小窗画面上（76/47 + translate(-50%,50%)）",
      "left:76px; bottom:47px" in CSS and "transform:translate(-50%,50%)" in CSS)
check("3b 窄屏同步换算（67/41）",
      ".video-minimized.video-controller-docked .vc-restore { left:67px; bottom:41px; }" in CSS)
check("3c 默认隐藏（opacity:0 / visibility:hidden / pointer-events:none）",
      re.search(r"\.video-minimized\.video-controller-docked \.vc-restore \{[^}]*opacity:0; visibility:hidden; pointer-events:none;", CSS) is not None)
check("3d 由 vc-restore-hover 标记驱动显示（不再靠常显）",
      ".video-minimized.video-controller-docked.vc-restore-hover .vc-restore" in CSS)
check("3e 触屏（无 hover）仍直接可见，避免没法还原",
      "@media (hover: none)" in CSS and "hover: none" in CSS)
check("3f 指针事件绑定函数存在并挂在播放器初始化里",
      "function bindDockedRestoreHover(root, video)" in MEDIA
      and "bindDockedRestoreHover(root, video);" in MEDIA)
check("3g 缩小 / 还原都会清掉悬停标记",
      MEDIA.count('overlay.classList.remove("vc-restore-hover");') >= 2)
check("3h 还原图标不再是向上箭头（四向外扩）",
      "M12 20.8V10.2" not in MEDIA and "M19.6 4.4 11.8 12.2" in MEDIA)
check("3i 上一版「常显可点」的旧规则已移除",
      "还原按钮在缩小态常显可点" not in CSS and "width:30px; height:30px; opacity:1; visibility:visible; pointer-events:auto;" not in CSS)
check("3j 旧的兄弟选择器规则已移除（video 与按钮并非兄弟，选不中；注释中的说明保留）",
      ".media-video-body video:hover ~ .vc-restore," not in CSS
      and "video:hover ~ .vc-restore {" not in CSS)
check("3k 停靠态高度降至 96px（旧值已清除）",
      "height:96px" in CSS and "height:138px" not in CSS)

print("\n== 4. 需求3：内嵌字幕语言 / 内容识别 ==")
check("4a 语言码 → 中文名映射存在",
      "func subLangName(code string) string" in GO and '"zho": "中文"' in GO and '"jpn": "日语"' in GO)
check("4b 简繁专用字表 + 内容判定函数存在",
      "subHansChars" in GO and "subHantChars" in GO and "func subtitleSampleLabel(sample string) string" in GO)
check("4c 轨标题语言提示识别（含双语 / 简繁）",
      "func subtitleTitleHint(title string) string" in GO and '"中英双语"' in GO and '"简体中文"' in GO and '"繁体中文"' in GO)
check("4d 文本轨采样（限制 64 KiB，不整轨读入）",
      "func sampleEmbeddedSubtitle(ctx context.Context, disc discInput, track int) string" in GO
      and "max: 64 << 10" in GO and '"0:s:%d"' in GO)
check("4e 采样结果按「输入 + 轨号 + 尺寸 + mtime」缓存",
      "func subtitleSampleCached(" in GO and "st.Size(), st.ModTime().Unix()" in GO)
check("4f 原盘 PGS 无标签时按 PID 读 M2TS 的 PMT 语言描述符",
      "func discSubtitleLangInfo(ctx context.Context, disc discInput) discSubLangInfo" in GO
      and 'filepath.Join(disc.DiscRoot, "BDMV", "STREAM")' in GO
      and "func normalizeStreamPID(id string) string" in GO
      and 'info.byPID[normalizeStreamPID(pid)]' in GO)
check("4g 统一推导入口 subtitleLabelFor，且两处轨清单都走它",
      "func subtitleLabelFor(" in GO and GO.count("subtitleLabelFor(") >= 3)
check("4h 接口带上 language / pid 字段",
      GO.count('"language": s.Tags["language"]') >= 2 and GO.count('"pid": s.ID') >= 2)
check("4i 旧的「字幕 N · 内嵌字幕 N」两段式标签已移除",
      'fmt.Sprintf("字幕 %d · %s"' not in GO)
check("4j 拿不到线索时才回落「内嵌字幕 N」（向后兼容旧断言）",
      'label = fmt.Sprintf("内嵌字幕 %d", si+1)' in GO)

print("\n== 5. 新增测试文件在库内 ==")
for rel in ("media-go/v1000_subtitle_label_test.go", "tests/v1000_behavior.js", "tests/test_v1000_behavior.py"):
    check(f"5 {rel} 存在", (ROOT / rel).exists())

print("\n== 6. 洗版自查（本仓禁止真实域名 / 内网 IP / 卷路径字面量）==")
BANNED = ["enged" + ".top", "192" + ".168.", "/vol" + "1", "/vol" + "2", "/vol" + "3"]
for rel in ("media-go/main.go", "web/js/02-media.js", "web/css/main.css", "tests/v1000_behavior.js",
            "tests/test_v1000_contract.py", "tests/test_v1000_behavior.py",
            ".github/RELEASE_NOTES_1.0.0.md", "Update Log.md", "media-go/v1000_subtitle_label_test.go"):
    body = rd(rel)
    check(f"6 {rel} 无禁用字面量", not any(b in body for b in BANNED),
          [b for b in BANNED if b in body])

print("\n===== v1.0.0 契约测试：", "全部通过 =====" if ok else "存在失败 =====")
raise SystemExit(0 if ok else 1)
