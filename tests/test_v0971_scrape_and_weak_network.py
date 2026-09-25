#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.71 静态契约：刮削识别策略 · 放大视图歌词页 · 弱网方案。

行为级验证在 tests/test_v0971_lyrics_panel_and_weak_network_behavior.py（Node 沙箱真跑），
Go 侧在 media-go/v0971_audio_scrape_test.go 与 media-go/v0971_audio_stream_test.go。
本文件只做「写法与声明真实性」检查：文件里必须存在哪些结构、阈值，
以及**发布说明里的数字必须与代码一致**（v0.9.70 教训：说明写了但代码里没有）。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
ZOOM = (ROOT / "web/js/03-audio-zoom.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
GOQUERY = (ROOT / "media-go/audio_query.go").read_text(encoding="utf-8")
GOMETA = (ROOT / "media-go/audio_metadata.go").read_text(encoding="utf-8")
GOLYRICS = (ROOT / "media-go/audio_lyrics.go").read_text(encoding="utf-8")
GOSTREAM = (ROOT / "media-go/audio_stream.go").read_text(encoding="utf-8")
GOMAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.71.md").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
PLAYBOOK = (ROOT / "docs/weak-network-playbook.md")

checks = {}
def check(name, cond, extra=""):
    checks[name] = (bool(cond), extra)

# ============ 版本一致性 ============
check("本版版本", 'VAULTHUB_ASSET_VERSION = "0.9.78"' in HTML and 'VAULTHUB_SCRIPT_VERSION = "0.9.78"' in STATE)
check("资源缓存串", HTML.count("?v=0.9.78") >= 7, f"实际 {HTML.count('?v=0.9.78')}")
check("UI 版本角标", "0.9.78" in HTML)

# ============ 需求 1：刮削识别策略（特殊字符 / 日语 / 全角） ============
check("归一化：宽度折叠（含半角片假名）",
      "func audioWidthFold(s string) string" in GOQUERY and "halfWidthKanaTable" in GOQUERY
      and "audioVoicedKana" in GOQUERY)
check("归一化：去修饰（括号整段 + 嵌套括号栈）",
      "func audioStripDecorations(s string) string" in GOQUERY
      and "audioMatchingClose" in GOQUERY and "audioDecorationTokens" in GOQUERY
      and "audioDropGluedDecorationSuffix" in GOQUERY)
check("检索词阶梯（原样→去修饰→主歌手→仅标题，上限 4）",
      "func audioQueryVariants(title, artist string) []audioQuery" in GOQUERY
      and "audioMaxQueryVariants = 4" in GOQUERY)
check("店铺按脚本选择（假名→JP 优先）",
      "func audioCountryOrder(sample string) []string" in GOQUERY
      and 'return []string{"JP", "TW", "US"}' in GOQUERY
      and 'return []string{"TW", "JP", "US"}' in GOQUERY)
check("拉丁歌手名用编辑距离（拒绝 RADWIMPS/Piano Echoes 误配）",
      "func audioLatinSimilarity(a, b string) float64" in GOQUERY
      and "audioLatinSimilarity(w, g) >= 0.7" in GOQUERY)
check("歌手整串命中优先于合作者命中",
      "func audioArtistFullMatch(want, got string) bool" in GOQUERY
      and "audioArtistFullMatch(wantArtist, gotArtist)" in GOMETA)
check("歌手封面罗马音桥接（MusicBrainz 别名表 + 24h 缓存）",
      "func (a *App) audioArtistAliasNames(ctx context.Context, name string) []string" in GOMETA
      and "func itunesPickArtistByAlias" in GOMETA and "artistAliasCache" in GOMETA
      and "24*time.Hour" in GOMETA)
check("歌词取源阶梯（get/search/自由文本 q=）",
      "func (a *App) lrclibSearchFree(ctx context.Context, title string) (lyricsResult, bool)" in GOLYRICS
      and 'q.Set("q", title)' in GOLYRICS and "lyricsMaxAttempts" in GOLYRICS)
check("歌词不再退回「第一条有歌词的记录」",
      "不再" in GOLYRICS and "return titleOnly, titleOnlyOK" in GOLYRICS
      and "return lrclibRecord{}, false" not in GOLYRICS.split("func pickLrclibRecord(")[1].split("func ")[0]
      and "return list[0]" not in GOLYRICS)
check("歌词标题判定含脚本一致性（挡掉被包含的无关曲目）",
      "func audioLyricsTitleMatches(want, got string) bool" in GOLYRICS
      and "audioRuneDistanceAtMost" in GOLYRICS)
check("文件名解析支持全角/日文分隔符",
      "－ − — ― ／ ｜" in MEDIA and "withoutTrack" in MEDIA)
check("手动/批量刮削清会话内已尝试标记（让新策略真正生效）",
      "audioLyricsAttempted.delete(path)" in MEDIA)

# ============ 需求 2：放大视图药丸 + 中部歌词 + 海报虚化 5% ============
check("右侧两个药丸（海报/歌词，role=tab + aria-selected）",
      'id="audioFsPosterPill"' in HTML and 'id="audioFsLyricsPill"' in HTML
      and 'role="tablist"' in HTML and 'aria-controls="audioFullscreenLyrics"' in HTML
      and HTML.count('role="tab"') == 2 and 'aria-selected="true"' in HTML and 'aria-selected="false"' in HTML)
check("歌词层与提示条",
      'id="audioFullscreenLyrics"' in HTML and 'id="audioFullscreenLyricsInner"' in HTML
      and 'id="audioFullscreenLyricsHint"' in HTML)
check("药丸切换函数与默认海报页",
      "function setAudioFullscreenPage(page)" in ZOOM
      and 'data-page="poster"' in HTML and 'audioFullscreenPage = "poster"' in ZOOM)
check("主海报按宽度 5% 虚化（CSS 变量折算，blur 不接受百分比）",
      "--poster-lyrics-blur:calc(var(--poster-size) * .05)" in CSS
      and "--poster-size:min(520px,80vw)" in CSS
      and '.audio-fullscreen-overlay[data-page="lyrics"] .audio-fullscreen-poster img' in CSS
      and "blur(var(--poster-lyrics-blur" in CSS)
check("窄屏断点同步 --poster-size（虚化始终是海报宽度的 5%）",
      "--poster-size:min(420px,90vw)" in CSS and "width:var(--poster-size" in CSS)
check("歌词在页面中部（居中面板）",
      ".audio-fs-lyrics { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)" in CSS)
check("拖动阈值常量（6px，独立审查 J1：改成 0 会让拖动被当成点击）",
      "AUDIO_FS_DRAG_SLOP = 6" in ZOOM)
check("拖动：指针捕获 + 位移阈值 + 只滚列表",
      "function audioFsLyricsDragStart(event)" in ZOOM and "setPointerCapture" in ZOOM
      and "AUDIO_FS_DRAG_SLOP = 6" in ZOOM and "scrollTop = Math.max(0, startTop - delta)" in ZOOM)
check("松手后暂停自动跟随 6 秒并恢复",
      "AUDIO_FS_FOLLOW_PAUSE_MS = 6000" in ZOOM and "function lyricFollowPaused(host)" in ZOOM
      and "lyricFollowPaused" in MEDIA)
check("点击歌词行跳到该句（复用 seekLyric 语义的时间基准）",
      "function audioFsLyricsClick(event)" in ZOOM and "player.currentTime = Number(line.dataset.time)" in ZOOM)
check("两个歌词容器共用高亮/滚动实现（无第二套）",
      "function lyricHosts()" in MEDIA and "audioFullscreenLyricsInner" in MEDIA
      and "host.lines.dataset.lastLyricIndex" in MEDIA)

# ============ 需求 3：弱网方案 ============
check("服务端限码率音频流端点",
      "func (a *App) audioStream(w http.ResponseWriter, r *http.Request)" in GOSTREAM
      and 'mux.HandleFunc("/api/media/audio/stream", a.audioStream)' in GOMAIN)
check("码率白名单阶梯",
      "audioBitrateLadder = []int{64, 96, 128, 160, 192, 256, 320}" in GOSTREAM
      and "func parseAudioBitrate(raw string) (int, error)" in GOSTREAM)
check("转码结果落盘 + Range 复用（ServeContent）",
      "func (a *App) transcodeAudioToMP3" in GOSTREAM and "http.ServeContent" in GOSTREAM
      and "audioStreamCacheDirName = \"audio-transcode\"" in GOSTREAM)
check("转码走全局闸门并在拥塞时回落",
      "a.acquireTranscode(r.Context())" in GOSTREAM and 'Retry-After' in GOSTREAM)
check("音频缓存独立配额与清理",
      "func (a *App) pruneAudioStreamCache" in GOSTREAM and "func (a *App) audioStreamCacheLimit() int64" in GOSTREAM)
check("下行探测端点（禁压缩/禁缓存/大小上限）",
      "func (a *App) weakProbe(w http.ResponseWriter, r *http.Request)" in GOSTREAM
      and 'mux.HandleFunc("/api/media/weak/probe", a.weakProbe)' in GOMAIN
      and 'Content-Encoding", "identity"' in GOSTREAM and '"no-store, no-cache, must-revalidate"' in GOSTREAM
      and "n > 2048" in GOSTREAM)
check("前端弱网档位与后台判定（v0.9.78 移除手动档位循环，只留后台自动判定）",
      "function effectiveAudioKbps()" in MEDIA and "function autoAudioKbps()" in MEDIA
      and "AUDIO_QUALITY_KEY" in MEDIA)
check("音质档位与设置面板（v0.9.78：转换按钮已移除，改后台状态文案）",
      'id="autoSpeedTestToggle"' in HTML and 'id="audioQualityStatus"' in HTML
      and "function updateAudioQualityButton()" in MEDIA
      and "function saveWeakNetworkMode()" in MEDIA
      and "已移除" in MEDIA
      and "function autoSpeedTestEnabled()" in MEDIA)
check("转码流失败回落原文件",
      'player.dataset.streamFallback' in MEDIA and "已回落原文件直出" in MEDIA)
check("漫画省流联动弱网判定",
      "if (typeof weakNetworkActive === \"function\" && weakNetworkActive()) return true;" in MEDIA)
check("启动时初始化弱网状态与后台测速",
      "ensureWeakNetworkProbe" in BOOT and "syncWeakNetworkSettings" in BOOT)
check("客户向弱网手册", PLAYBOOK.exists() and "Plex" in PLAYBOOK.read_text(encoding="utf-8")
      and "Navidrome" in PLAYBOOK.read_text(encoding="utf-8")
      and "audio/stream" in PLAYBOOK.read_text(encoding="utf-8"))
# v0.9.76：仓库主在 e97c23f 里精简 README，删掉了「弱网与远程访问」小节（细则以
# docs/weak-network-playbook.md 为准）。原断言钉死 README 里的「弱网」二字，会被这次
# 正当的文档精简打红 —— 改为断言「能力有客户向文档可查」，README 提到与否都算通过。
check("弱网能力有客户向文档（README 或客户手册）",
      "弱网" in README or "weak-network" in README or PLAYBOOK.exists(),
      "README 可精简，但能力必须留下客户向文档")

# ============ 附带修复：漫画单页槽位隐藏 ============
check("漫画单页槽位 [hidden] 兜底", ".comic-slot[hidden] { display:none; }" in CSS)
check("单页模式仍在使用 slot.hidden", "slot.hidden = true" in MEDIA and "slot.hidden = false" in MEDIA)

# ============ 声明的真实性（发布说明 ↔ 代码） ============
check("说明里的弱网阈值与代码一致",
      "400 KiB/s" in NOTES and "WEAK_SLOW_BPS = 400 * 1024" in MEDIA
      and "1.5 MiB/s" in NOTES and "WEAK_MEDIUM_BPS = 1500 * 1024" in MEDIA)
check("说明里的档位白名单与代码一致",
      "64/96/128/160/192/256/320" in NOTES and "audioBitrateLadder = []int{64, 96, 128, 160, 192, 256, 320}" in GOSTREAM)
check("说明里的 5% 折算与 CSS 一致", "5%" in NOTES and "* .05)" in CSS and "--poster-size" in CSS)
check("说明里的歌词阶梯与代码一致",
      "LRCLIB get(原样)" in NOTES and "func (a *App) lrclibGet" in GOLYRICS
      and "自由文本 q=" in NOTES and "lrclibSearchFree" in GOLYRICS)
check("说明里的店铺顺序与代码一致",
      "含假名 → JP 优先" in NOTES and 'return []string{"JP", "TW", "US"}' in GOQUERY)
check("说明里的别名表缓存时长与代码一致",
      "24 小时内存缓存" in NOTES and "24*time.Hour" in GOMETA)
check("说明里的外呼上限与代码一致",
      "lyricsMaxAttempts" in GOLYRICS and "lyricsMaxAttempts" in NOTES)

failed = [f"{k}：{v[1]}" if v[1] else k for k, v in checks.items() if not v[0]]
print(f"v0.9.71 静态契约：{len(checks) - len(failed)}/{len(checks)} 通过")
for name, (ok, extra) in checks.items():
    if not ok:
        print(f"  - FAIL {name}" + (f"（{extra}）" if extra else ""))
if failed:
    raise SystemExit("FAIL: v0.9.71 静态契约未全部通过")
print("PASS: v0.9.71 刮削策略 / 歌词药丸 / 弱网方案静态契约通过")
