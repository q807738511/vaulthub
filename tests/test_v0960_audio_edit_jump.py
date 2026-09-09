from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
UPDATELOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.64.md").read_text(encoding="utf-8")

fails = []
def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name} {detail}")

# ============ T1 版本一致性（bump 0.9.59 → 0.9.64） ============
check("T1 HTML 资源版本", 'VAULTHUB_ASSET_VERSION = "0.9.64"' in HTML)
check("T1 JS 脚本版本", 'VAULTHUB_SCRIPT_VERSION = "0.9.64"' in STATE)
check("T1 CSS 缓存串", 'href="/web/css/main.css?v=0.9.64"' in HTML)
check("T1 JS 缓存串 x5", HTML.count('?v=0.9.64') >= 6)  # css 1 + js 5
check("T1 无 0.9.59 缓存串残留", HTML.count('?v=0.9.59') == 0)
check("T1 UI 版本角标", "v0.9.64" in HTML)

# ============ T2 编辑专辑/歌手按钮跳转曲目列表 ============
# 编辑按钮应调用 openAudioTracks 而非 openAudioGroupEdit
check("T2 专辑编辑按钮跳转", "openAudioTracks('${esc(lib.id)}','album',${esc(JSON.stringify(album))})" in JS)
check("T2 歌手编辑按钮跳转", "openAudioTracks('${esc(lib.id)}','artist',${esc(JSON.stringify(artist))})" in JS)
check("T2 专辑编辑按钮无 openAudioGroupEdit", 'openAudioGroupEdit(\'album\'' not in JS)
check("T2 歌手编辑按钮无 openAudioGroupEdit", 'openAudioGroupEdit(\'artist\'' not in JS)
check("T2 无冗余查看专辑曲目按钮", "查看专辑曲目" not in JS)
check("T2 无冗余查看歌手歌曲按钮", "查看歌手歌曲" not in JS)
check("T2 编辑专辑按钮 title", 'title="编辑专辑"' in JS)
check("T2 编辑歌手按钮 title", 'title="编辑歌手"' in JS)

# ============ T3 播放器喜欢按钮 ============
check("T3 播放器喜欢按钮存在", "audioFavoriteButton" in JS)
check("T3 toggleActiveAudioFavorite 函数", "function toggleActiveAudioFavorite()" in JS)
check("T3 播放器喜欢按钮居中样式", ".audio-player-controls" in CSS)

# ============ T4 文档一致性 ============
check("T4 Update Log v0.9.64 段", "# VaultHub 蜀鼠之家 v0.9.64" in UPDATELOG)
check("T4 Update Log 编辑跳转记载", "编辑按钮跳转" in UPDATELOG or "跳转曲目列表" in UPDATELOG)
check("T4 RELEASE_NOTES 存在", "v0.9.64" in NOTES and "音乐海报放大交互统一" in NOTES)

if fails:
    print(f"FAIL: v0.9.64 契约 {len(fails)} 项未通过")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)

print("PASS: v0.9.64 契约全部通过")
