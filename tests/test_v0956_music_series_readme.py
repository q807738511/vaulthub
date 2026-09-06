from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
BOOT = (ROOT / "web/js/04-boot.js").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
UPDATELOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
GOMAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GOAUDIO = (ROOT / "media-go/audio_metadata.go").read_text(encoding="utf-8")

fails = []
def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name} {detail}")

# ============ T1 移动端顶栏横滑 ============
assert '@media (max-width: 768px)' in CSS
# 768 段内的滚动增强
m768 = CSS[CSS.index('@media (max-width: 768px)'):]
check("T1 scroll-snap 停靠", "scroll-snap-type: x mandatory" in m768)
check("T1 触摸惯性滚动", "-webkit-overflow-scrolling: touch" in m768 and "touch-action: pan-x" in m768)
check("T1 overscroll 约束", "overscroll-behavior-x: contain" in m768)
check("T1 nav-item 停靠对齐", ".sidebar .nav-item { scroll-snap-align: start; }" in m768)
check("T1 溢出提示 class", ".sidebar.nav-overflow" in m768 and "inset -14px 0 12px -12px" in m768)
# JS 侧：溢出检测 + MutationObserver
check("T1 updateSidebarNavOverflow 函数", "function updateSidebarNavOverflow()" in STATE)
check("T1 initSidebarNavOverflowWatch 函数", "function initSidebarNavOverflowWatch()" in STATE)
check("T1 scrollWidth/clientWidth 判定", "nav.scrollWidth > nav.clientWidth" in STATE)
check("T1 MutationObserver 监听异步导航", "MutationObserver" in STATE and "childList: true" in STATE)
check("T1 boot 挂载", "initSidebarNavOverflowWatch();" in BOOT)

# ============ T2 音乐专辑/歌手点击逻辑 ============
check("T2 openAudioTracks 整单拉取", "async function openAudioTracks(libId, kind, key)" in JS
      and "fetchAllLibraryFiles(lib.id, { has_more: true }, 0)" in JS)
check("T2 按 kind 过滤", 'kind === "artist" ? meta.artist === key : meta.album === key' in JS)
check("T2 曲目行整行播放", "audio-row-click" in JS and 'onclick="playAudioFile(' in JS)
check("T2 行内按钮 stopPropagation", JS.count("event.stopPropagation()") >= 6)
check("T2 播放队列=专辑/歌手集合", "audioFiles = files;" in JS and "audioCursor = 0;" in JS)

# ============ T3 歌手刮削 ============
# 后端
check("T3 Go 拆分合作演唱", "func splitAudioCollaborators(name string)" in GOAUDIO)
check("T3 合作分隔符覆盖", "feat." in GOAUDIO and "featuring" in GOAUDIO and '" & "' in GOAUDIO and '"、"' in GOAUDIO and ' × ' in GOAUDIO)
check("T3 主歌手决定封面", "scrapeAudioArtistItunes(ctx, lead)" in GOAUDIO and "lead := parts[0]" in GOAUDIO)
check("T3 MB 兜底", "scrapeAudioArtistMusicBrainz" in GOAUDIO and "no reliable artist match" in GOAUDIO)
check("T3 头像 600x600", "audioHiResArtwork(hit.ArtworkURL100)" in GOAUDIO)
check("T3 路由注册", '"/api/media/audio/artist", a.audioArtist' in GOMAIN)
# iTunes 端点与择优（v0.9.56 实测修复）
check("T3 iTunes 端点根", 'itunesSearchBase = "https://itunes.apple.com"' in GOAUDIO)
check("T3 search/lookup 各自拼路径", '"/search?entity=musicArtist' in GOAUDIO and '"/lookup?id="' in GOAUDIO)
check("T3 合作串主歌手重试", "if parts := splitAudioCollaborators(artist); len(parts) > 1" in GOAUDIO
      and "a.scrapeAudioItunes(ctx, title, parts[0])" in GOAUDIO)
check("T3 择优先歌手命中", "func audioArtistNameMatches(want, got string) bool" in GOAUDIO
      and "第一趟：标题 + 歌手双命中" in GOAUDIO)
# 前端
check("T3 歌手缓存", 'audioArtistCache = "vaulthub_audio_artists_v1"' in JS)
check("T3 歌手刮削函数", "async function scrapeAudioArtists(host, lib, files)" in JS)
check("T3 头像渲染", "audio-artist-avatar" in JS and "audioArtistInfoFor(artist)" in JS)
check("T3 合作演唱标注", "合作演唱" in JS)
check("T3 歌手视图触发刮削", 'if (audioView === "artists") scrapeAudioArtists(host, lib, files);' in JS)
check("T3 刮削失败以文件名展示", 'provider: ""' in JS and "cover || esc(artist)" in JS)
# CSS
check("T3 圆形头像 CSS", ".audio-artist-cover img.audio-artist-avatar" in CSS and "border-radius:50%" in CSS)

# ============ T3b 专辑/歌手可编辑（v0.9.56） ============
check("T3b 编辑弹窗", 'id="audioGroupEditModal"' in HTML and 'id="audioGroupEditName"' in HTML and 'id="audioGroupEditCover"' in HTML)
check("T3b 保存按钮", 'onclick="saveAudioGroupEdit()"' in HTML)
check("T3b 打开编辑函数", "async function openAudioGroupEdit(kind, key)" in JS)
check("T3b 整库分组拉取", "async function audioGroupFilesAll(kind, key)" in JS and "fetchAllLibraryFiles(lib.id, { has_more: true }, 0)" in JS)
check("T3b 批量写入 manual", "async function saveAudioGroupEdit()" in JS and 'provider: "manual"' in JS)
check("T3b 专辑卡片编辑按钮", """openAudioGroupEdit('album'""" in JS)
check("T3b 歌手卡片编辑按钮", """openAudioGroupEdit('artist'""" in JS)

# ============ T3c 喜欢栏目 + 播放器喜欢按钮（v0.9.56） ============
check("T3c 喜欢页签", '♥ 喜欢' in JS and 'setAudioView(\'favorites\')' in JS)
check("T3c 喜欢视图渲染", "function renderAudioFavorites(lib)" in JS and "function audioFavoriteRows()" in JS)
check("T3c 曲目行喜欢按钮", 'title="喜欢"' in JS and "toggleAudioFavorite(" in JS)
check("T3c 播放器喜欢按钮", 'id="audioFavoriteButton"' in HTML and 'onclick="toggleActiveAudioFavorite()"' in HTML)
check("T3c 播放器喜欢状态同步", "function updateAudioFavoriteButton()" in JS and "audio-fav-on" in JS
      and "updateAudioFavoriteButton();" in JS)

# ============ T3d 播放器居中（v0.9.56） ============
audio_player_rule = CSS[CSS.index(".audio-player { position:fixed;"):]
audio_player_rule = audio_player_rule[:audio_player_rule.index("}") + 1]
check("T3d 底部播放器水平居中", "left:50%" in audio_player_rule and "translateX(-50%)" in audio_player_rule
      and "right:auto" in audio_player_rule, audio_player_rule[:120])
maximized_rule = CSS[CSS.index(".audio-player.maximized {"):]
maximized_rule = maximized_rule[:maximized_rule.index("}") + 1]
check("T3d 展开播放器上下左右居中", "left:50%" in maximized_rule and "top:50%" in maximized_rule
      and "translate(-50%,-50%)" in maximized_rule, maximized_rule[:120])

# ============ T4 剧集图示卡片 ============
check("T4 renderSeriesEpisodeRow 卡片化", "series-episode-card" in JS and "data-series-episode" in JS)
check("T4 缩略图 + 集号角标", "series-episode-thumb" in JS and "series-episode-label" in JS and "S" in JS)
check("T4 整卡点击播放", 'onclick="openLocalMedia(\'movie\'' in JS)
check("T4 详情按钮 stopPropagation", 'onclick="event.stopPropagation();openEpisodeDetails(' in JS)
check("T4 容器 series-episode-list", 'class="series-episode-list"' in JS)
check("T4 剧集封面传入", "const episodeArt = show.poster || show.fanart || show.backdrop" in JS)
check("T4 CSS 卡片样式", ".series-episode-list" in CSS and ".series-episode-thumb" in CSS and ".series-episode-label" in CSS)
check("T4 CSS 移动端缩略图", "@media (max-width: 560px)" in CSS)

# ============ T5 README / Update Log 分离 ============
assert (ROOT / "README.md").exists() and (ROOT / "Update Log.md").exists()
check("T5 主页介绍含标题", "# VaultHub · 蜀鼠之家" in README and "自托管一站式媒体中心" in README)
check("T5 主页含部署/解码/功能段", "## 部署方式" in README and "硬件解码配置" in README and "## 功能介绍" in README)
check("T5 主页指向 Update Log", "Update Log.md" in README and "RELEASE_NOTES" in README)
check("T5 Update Log 归档历史", "# VaultHub 蜀鼠之家 v0.9.56" in UPDATELOG and "v0.9.55" in UPDATELOG and "README.md" in UPDATELOG)
check("T5 主页无更新日志流水", "## 功能介绍" in README and "v0.9.55 围绕" not in README)
# 洗版：Update Log/主页都不应含真实域名
for fname, txt in [("README.md", README), ("Update Log.md", UPDATELOG)]:
    check(f"T5 {fname} 无真实域名", not re.search(r"enged\.top|192\.168\.|/vol[1-4]", txt), fname)

# ============ 版本号 ============
check("版本 HTML >=2", HTML.count("v0.9.56") >= 2)
check("版本 script 变量", 'VAULTHUB_SCRIPT_VERSION = "0.9.57"' in STATE)
check("版本 release notes 存在", (ROOT / ".github/RELEASE_NOTES_0.9.56.md").exists())

if fails:
    print(f"FAIL: v0.9.56 契约 {len(fails)} 项未通过")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)
print("PASS: v0.9.56 顶栏滑动/音乐专辑歌手逻辑/歌手刮削/剧集卡片/README分离契约通过")
