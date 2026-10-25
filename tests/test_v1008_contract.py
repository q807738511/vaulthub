#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.0.8 契约测试（L1 静态层）：7 项需求的实现面冻结。

覆盖七组：
  1. 转码 live 可拖动：compat 支持 ss（输入侧 -ss、响应头 X-VaultHub-Seek-Start、
     带 ss 不再触发预转码）；播放器侧时间坐标（videoAbsoluteTime / videoTimelineDuration /
     restartLiveStream / seekVideoTo）与进度条、拖动、键盘、进度持久化接入；
  2. 内容自适应居中：服务端 CSS 单点下发（--vh-content-max + 安全区 + 断点）、viewport-fit；
  3. 去冗余信息：媒体库页不再输出「我的媒体库 / 库名 / 条目数 / 扫描时间 / 已加载全部」；
  4. 音乐库去页签：默认歌手视图，页签整条移除，喜欢/歌单改为入口卡；
  5. 歌手 → 专辑 → 歌曲：openAudioArtist / renderAudioArtistAlbums / 返回层级；
  6. 播放器按钮描边：内外双环（暗环 + 亮环）；
  7. 刮削落盘：scrape-cache POST 后服务端写 NFO 到媒体同目录（含库类型/路径边界）；
  8. 版本纪律与禁用字面量。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
GOMAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GOSTORE = (ROOT / "media-go/scrape_store.go").read_text(encoding="utf-8")
GONFO = (ROOT / "media-go/scrape_nfo_persist.go").read_text(encoding="utf-8")
GONFOWRITE = (ROOT / "media-go/nfo_write.go").read_text(encoding="utf-8")
VERSION = "1.0.8"

checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))


# ---------------- 1. 转码 live 可拖动（服务端） ----------------
check("1a compat 解析 ss 参数", "strconv.ParseFloat(r.URL.Query().Get(\"ss\"), 64)" in GOMAIN)
check("1b ss 属于输入选项（在 -i 之前）",
      '-ss", strconv.FormatFloat(seekStart' in GOMAIN
      and GOMAIN.index('seekStart, \'f\', 3, 64))\n\t}\n\targs = append(args, "-i"') > 0)
check("1c 响应头回显起点", 'X-VaultHub-Seek-Start' in GOMAIN)
check("1d 带 ss 不再触发整段预转码", "if seekStart <= 0 && env(\"COMPAT_PRECACHE\", \"1\") != \"0\"" in GOMAIN)
check("1e 缓存命中路径不受 ss 影响（先开缓存文件再解析 live 分支）",
      GOMAIN.index("if f, e := os.Open(cache); e == nil") < GOMAIN.index("seekStart > 0"))

# 播放器侧时间坐标
for fn in ("videoIsLiveStream", "videoAbsoluteTime", "videoTimelineDuration", "restartLiveStream", "seekVideoTo"):
    check(f"1f 播放器函数 {fn}", f"function {fn}(" in MEDIA)
check("1g 进度条按整片时长绘制", "const duration=videoTimelineDuration(video);" in MEDIA)
check("1h 进度条时间用绝对坐标", "const now=videoAbsoluteTime(video);" in MEDIA)
check("1i 点击进度条走 seekVideoTo", "seekVideoTo(video, videoSeekRatio(event,shell)*total);" in MEDIA)
check("1j 拖动松手才重开流", "if(videoIsLiveStream(video)) seekVideoTo(video, pending);" in MEDIA)
check("1k 键盘跳转走绝对时间", "seekVideoTo(video,Math.max(0,Math.min(limit,cur+(event.key==='ArrowRight'?5:-5))));" in MEDIA)
check("1l 跳转按钮走绝对时间", "seekVideoTo(video, Math.max(0, Math.min(limit, videoAbsoluteTime(video) + Number(seconds || 0))));" in MEDIA)
check("1m 进度持久化写绝对时间", "position_ms:Math.round(videoAbsoluteTime(video)*1000)" in MEDIA)
check("1n 断点续播对 live 流用 ss 重开", "restartLiveStream(video, saved.time)" in MEDIA and "restartLiveStream(video, pos)" in MEDIA)
check("1o 整片时长来自播放计划", "video.dataset.liveDuration = String(_d)" in MEDIA)
check("1p ss 参数拼装不重复", 'var(--vh-content-max' not in MEDIA and 'ss=" + target' in MEDIA)

# ---------------- 2. 内容自适应居中 ----------------
check("2a CSS 内容上限变量", "--vh-content-max" in CSS)
check("2b 视图居中", ".main .content > .view { width: 100%; max-width: var(--vh-content-max); margin-inline: auto; }" in CSS)
check("2c 窄屏收边距", "@media (max-width: 900px)" in CSS and "padding-left: clamp(10px, 3vw, 18px)" in CSS)
check("2d 安全区适配", "env(safe-area-inset-left)" in CSS and "env(safe-area-inset-right)" in CSS)
check("2e 宽屏网格自适应", "@media (min-width: 1800px)" in CSS and "minmax(196px, 1fr)" in CSS)
check("2f viewport-fit=cover", "viewport-fit=cover" in HTML)

# ---------------- 3. 去冗余信息 ----------------
check("3a 媒体库标题函数不再输出内容",
      'void lib; void badge; void extra;\n  return "";' in MEDIA and 'class="eyebrow">我的媒体库' not in MEDIA)
check("3b 书刊页头整块移除", "const head = \"\";" in MEDIA and "本视图 <b>" not in MEDIA)
check("3c 去掉「已加载全部 N / N 项」", "已加载全部 ${" not in MEDIA and "已加载全部 ${files.length}" not in MEDIA)
check("3d 去掉音乐库「已展开全部 N 首」", "已展开全部 ${" not in MEDIA)
check("3e 书刊扫描时间不再进页面", 'class="pn-head"' not in MEDIA)

# ---------------- 4. 音乐库去页签 + 默认歌手 ----------------
check("4a 默认视图 = 歌手", 'let audioView = "artists";' in MEDIA)
check("4b 页签整条移除", "audioTabs = \"\";" in MEDIA and 'onclick="setAudioView(\'albums\')">专辑</button>' not in MEDIA)
check("4c 喜欢 / 歌单改为入口卡", 'class="audio-album-card audio-entry-card"' in MEDIA and "audio-entry-cover" in MEDIA)
check("4d 入口卡 CSS", ".audio-entry-card .audio-entry-cover" in CSS)

# ---------------- 5. 歌手 → 专辑 → 歌曲 ----------------
check("5a 歌手卡片进入歌手页", "function openAudioArtist(" in MEDIA and "onclick=\"openAudioArtist('${esc(lib.id)}',${jsAttrArg(artist)})\"" in MEDIA)
check("5b 歌手页渲染专辑网格", "function renderAudioArtistAlbums(" in MEDIA)
check("5c 分发含 artistAlbums", 'audioView === "artistAlbums" ? renderAudioArtistAlbums(lib, files, audioArtistFilter)' in MEDIA)
check("5d 专辑返回层级记住歌手", 'const fromArtist = audioView === "artistAlbums";' in MEDIA and '(fromArtist ? "artistAlbums" : "albums")' in MEDIA)
check("5e 返回按钮回到歌手页", "openAudioArtist('${esc(lib.id)}',${jsAttrArg(audioArtistFilter)})" in MEDIA)
check("5f 歌曲行仍可编辑/播放", 'title="编辑歌曲信息"' in MEDIA and 'title="播放"' in MEDIA)

# ---------------- 6. 播放器按钮描边 ----------------
check("6a 暗环 + 亮环双描边",
      "box-shadow: 0 0 0 1px rgba(0, 0, 0, .62), 0 2px 10px rgba(0, 0, 0, .45)" in CSS
      and "border: 1px solid rgba(255, 255, 255, .62)" in CSS)
check("6b 亮色界面反相描边", ".reader-theme-light .audio-player-controls button {" in CSS and "rgba(0, 0, 0, .55)" in CSS)
check("6c 键盘聚焦可见", ".audio-player-controls button:focus-visible" in CSS)

# ---------------- 7. 刮削落盘 ----------------
check("7a scrape-cache POST 触发 NFO", "a.persistScrapeNFO(body.ID, body.Items)" in GOSTORE)
check("7b 响应回报写盘计数", '"nfo_written": nfoWritten, "nfo_kept": nfoKept' in GOSTORE)
check("7c 仅影视库", 'case "movie", "series":' in GONFO)
check("7d 路径走 safeFile 边界", "abs, _, err := safeFile(lib, path)" in GONFO)
check("7e 不覆盖他人 NFO", "writeNFOFile(t, doc, false)" in GONFO)
check("7f 剧集写 tvshow.nfo / 电影写 movie.nfo", 'extra, up = "tvshow.nfo", 1' in GONFO)
check("7g NFO 写到媒体同目录", "nfoResolveTarget(lib, path, stem+\".nfo\", 0)" in GONFO)
check("7h 失败条目不阻断整批", "if err != nil {\n\t\t\tcontinue\n\t\t}" in GONFO)
check("7i NFO 写入链路本身未变", "func writeNFOFile(" in GONFOWRITE and "func nfoBuildDoc(" in GONFOWRITE)

# ---------------- 8. 版本纪律与禁用字面量 ----------------
check("8a 资源版本 1.0.8", f"?v={VERSION}" in HTML and HTML.count(f"?v={VERSION}") >= 11)
check("8b 资产常量", f'VAULTHUB_ASSET_VERSION = "{VERSION}"' in HTML)
check("8c 脚本常量", f'VAULTHUB_SCRIPT_VERSION = "{VERSION}"' in (ROOT / "web/js/01-state.js").read_text(encoding="utf-8"))
check("8d 标语", f"v{VERSION} ·" in HTML)
check("8e 安装脚本版本", f'VERSION="v{VERSION}"' in (ROOT / "scripts/install.sh").read_text(encoding="utf-8"))

# 禁用字面量：新增/修改的源码文件不得写入内网地址与容器卷路径
BANNED = re.compile(r"enged\.top|192\.168\.|/vol[1-4]")
for rel in ("web/js/02-media.js", "web/css/main.css", "media-go/scrape_nfo_persist.go", "index.html"):
    hits = BANNED.findall((ROOT / rel).read_text(encoding="utf-8"))
    check(f"8f 禁用字面量 {rel}", not hits, ",".join(sorted(set(hits))[:3]))

# ---------------- 输出 ----------------
passed = sum(1 for _, ok, _ in checks if ok)
failed = [(n, d) for n, ok, d in checks if not ok]
for name, ok, detail in checks:
    print(("PASS " if ok else "FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
print(f"\nTOTAL {passed}/{len(checks)} PASS")
if failed:
    print("FAILED:")
    for n, d in failed:
        print("  -", n, d)
    raise SystemExit(1)
