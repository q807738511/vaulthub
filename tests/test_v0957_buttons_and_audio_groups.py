from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
UPDATELOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.57.md").read_text(encoding="utf-8")

fails = []
def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name} {detail}")

# ============ T1 版本一致性（bump 0.9.56 → 0.9.57） ============
check("T1 HTML 资源版本", 'VAULTHUB_ASSET_VERSION = "0.9.57"' in HTML)
check("T1 JS 脚本版本", 'VAULTHUB_SCRIPT_VERSION = "0.9.57"' in STATE)
check("T1 CSS 缓存串", 'href="/web/css/main.css?v=0.9.57"' in HTML)
check("T1 JS 缓存串 x5", HTML.count('?v=0.9.57') >= 6)  # css 1 + js 5
check("T1 无 0.9.56 缓存串残留", HTML.count('?v=0.9.56') == 0)
check("T1 UI 版本角标", "v0.9.57 · Floating Player" in HTML)

# ============ T2 影视详情返回按钮 → 横向药丸（修复穿模） ============
# 不再使用圆形 media-reader-close + ✕ 长文案组合
check("T2 不再输出圆形 class", 'class="media-reader-close" title="返回剧集详情"' not in JS
      and 'class="media-reader-close" title="关闭并返回媒体库"' not in JS)
check("T2 不再使用 ✕ 长文案", "✕ 返回详情</button>" not in JS and "✕ 返回媒体库</button>" not in JS)
# 新药丸：返回箭头 SVG + 中文
check("T2 movie-return-pill 两态", JS.count('class="movie-return-pill"') >= 2)
check("T2 返回箭头 SVG", 'path d="M19 12H5m6-6-6 6 6 6"' in JS)
check("T2 中文文案", "返回详情" in JS and "返回媒体库" in JS)
check("T2 保留语境语义", "closeEpisodeDetail()" in JS and "closeMovieDetails()" in JS)
# CSS 药丸样式
check("T2 CSS 药丸 class", ".movie-return-pill {" in CSS)
check("T2 圆角胶囊", ".movie-return-pill {" in CSS and "border-radius:999px" in CSS)
check("T2 横向自适应", ".movie-return-pill {" in CSS and "white-space:nowrap" in CSS
      and "inline-flex" in CSS and "padding:0 18px 0 13px" in CSS)
check("T2 fixed 定位共用", ".movie-detail-scroll>.movie-return-pill" in CSS
      and "top:calc(var(--topbar-h) + 14px)" in CSS)
# 阅读器圆形 ✕ 按钮不受影响
check("T2 阅读器圆钮保留", ".media-reader-close { flex:0 0 auto; width:36px;" in CSS)

# ============ T3 音乐专辑/歌手操作逻辑 ============
# 分组文件加载器 + 一键直播
check("T3 audioGroupFiles 函数", "async function audioGroupFiles(libId, kind, key)" in JS)
check("T3 playAudioGroup 函数", "function playAudioGroup(libId, kind, key)" in JS)
check("T3 播放首曲且队列=分组", "audioFiles = files;" in JS
      and "playAudioFile(libId, files[0].path);" in JS)
check("T3 空分组提示", "该分组暂无歌曲" in JS)
check("T3 openAudioTracks 复用加载器", "const files = await audioGroupFiles(lib.id, kind, String(key));" in JS)
# 专辑/歌手卡片「▶ 播放」按钮
check("T3 专辑卡片播放按钮", "playAudioGroup('" in JS and "直接播放该专辑全部歌曲" in JS)
check("T3 歌手卡片播放按钮", "直接播放该歌手全部歌曲" in JS)
# 分组曲目列表头部「▶ 播放全部」（仅专辑/歌手分组，歌单不显示）
check("T3 列表播放全部按钮", "audio-play-all" in JS and "▶ 播放全部" in JS)
check("T3 播放全部仅分组场景", "back === \"artists\" || back === \"albums\"" in JS)
# 未知分组兜底与加载器语义一致（未知专辑/未知歌手也可打开）
check("T3 未知专辑兜底", 'meta.album || "未知专辑"' in JS
      and 'kind === "artist" ? meta.artist === key : meta.album === key' in JS)
check("T3 点击曲目直接播放保留", 'onclick="playAudioFile(' in JS)
# 分组队列锁：刮削完成重载不冲掉播放队列
check("T3 audioGroupLock 声明", "let audioGroupLock = null;" in JS)
check("T3 分组播放设锁", "audioGroupLock = { kind, key: String(key) };" in JS)
check("T3 重载不覆盖队列", "if (!audioGroupLock) { audioFiles = files; audioCursor = offset; }" in JS)
check("T3 切页签释放锁", "audioGroupLock = null;" in JS)

# ============ T4 文档一致性 ============
check("T4 README 药丸按钮", "横向药丸" in README and "← 返回详情" in README)
check("T4 README 分组一键播放", "▶ 播放全部" in README and "队列即该专辑/歌手" in README)
check("T4 Update Log v0.9.57 段", "# VaultHub 蜀鼠之家 v0.9.57" in UPDATELOG)
check("T4 Update Log 药丸化记载", "药丸化" in UPDATELOG and "穿模" in UPDATELOG)
check("T4 RELEASE_NOTES 存在", "v0.9.57" in NOTES and "药丸" in NOTES
      and "audioGroupFiles" in JS)  # 发布说明与本实现同源
check("T4 历史日志归档结构", "<details>" in UPDATELOG and "v0.9.56：TXT 阅读编码修复" in UPDATELOG)

if fails:
    print(f"FAIL: v0.9.57 契约 {len(fails)} 项未通过")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)
print("PASS: v0.9.57 版本一致性/返回按钮药丸/音乐专辑歌手分组逻辑/文档一致性契约通过")