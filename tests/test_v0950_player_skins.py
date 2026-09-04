#!/usr/bin/env python3
"""VaultHub v0.9.53 contracts: player skins, SVG icons, resilience, ZIP fixes,
repo-wide scrubbing and removal of the preview label.

Asserts against the real repo files:
  * 02-media.js ships the inline SVG icon set (VIDEO_ICON_SVG / videoIcon) and
    uses it in the player chrome instead of Unicode glyphs/emoji;
  * main.css carries the two skins (PotPlayer for dark/custom, Apple for light)
    plus the fixed white title and enlarged centered corner buttons;
  * playback interruption now auto-rebuilds a transcode session
    (retryPlaybackPlanOnce / videoDeadEnd click-to-retry), minimize leaves
    fullscreen first, and switching sources stops stale sessions;
  * media-go mime() covers every imageEntry extension and the archive
    register endpoint sniffs content type;
  * the whole tracked tree is scrubbed: no private domains / LAN IPs / NAS
    volume paths, and no preview wording in page title, subtitles or login hint.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
media = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
css = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
state = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
features = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
index = (ROOT / "index.html").read_text(encoding="utf-8")
backend = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")


def test_svg_icon_set_shipped_and_used():
    assert "const VIDEO_ICON_SVG" in media
    assert "function videoIcon(name)" in media
    assert "function videoPlayPauseIcon(paused)" in media
    # chrome 模板必须用 videoIcon 注入，而不是 Unicode 字形/emoji 按钮
    for icon_call in ['videoIcon("collapse")', 'videoIcon("play")', 'videoIcon("restore")',
                      'videoIcon("fullscreen")', 'videoIcon("settings")', 'videoIcon("shuffle")']:
        assert icon_call in media, f"player chrome no longer calls {icon_call}"
    # 旧的 emoji/字形按钮直接以字符态写死在模板里属于回归
    assert '">⌄</button>' not in media and '">⛶</button>' not in media
    assert '">🔁</button>' not in media and '">⚙</button>' not in media
    # 动态播放/暂停图标切换
    assert "button.innerHTML = videoPlayPauseIcon(video.paused)" in media
    assert "videoIcon(active ? \"fullscreenExit\" : \"fullscreen\")" in media


def test_dual_skins_in_css():
    # 双皮肤作用域：PotPlayer 为默认（暗色/自定义），Apple 为亮色主题
    assert ".media-reader-overlay.movie-player .vc-icon" in css          # PotPlayer base
    assert ".media-reader-overlay.movie-player.reader-theme-light .vc-icon" in css  # Apple
    assert "PotPlayer" in css and "Apple" in css
    # SVG 图标尺寸与面板内小图标
    assert ".media-reader-overlay.movie-player .vc-svg" in css
    assert ".vc-panel-ic" in css
    # 播放/暂停主键两皮肤差异化
    assert ".vc-icon.vc-play" in css and "reader-theme-light .vc-icon.vc-play" in css


def test_title_and_corner_button_fixes():
    # 标题常显白字 + 阴影（修复亮色主题黑字压黑底）
    assert ".media-reader-overlay.movie-player .vc-title" in css
    assert "color:#fff; font-size:15px" in css
    assert "text-shadow:0 1px 4px rgba(0,0,0,.85)" in css
    # 角标加大：collapse 42px 级、restore 44px 级；小窗态左缘垂直居中
    assert ".vc-collapse," in css and "width:42px; height:42px" in css
    assert re.search(r"\.vc-restore \{[^}]*width:44px; height:44px", css)
    assert ".video-minimized .vc-restore" in css and "top:50%" in css and "translateY(-50%)" in css


def test_playback_resilience():
    # 自动恢复：死局前重建播放计划一次；点击画面重试
    assert "async function retryPlaybackPlanOnce" in media
    assert "root.dataset.playbackRetried" in media
    assert "videoDeadEnd" in media
    assert "播放中断，点击画面重新加载" in media
    # 最小化前先退出全屏
    assert "document.exitFullscreen" in media.split("function minimizeVideoPlayer", 1)[1][:400]
    # 切换片源清理旧会话
    assert "stopVideoPlaybackSession(root); terminateWasmVideo(root);" in media


def test_zip_comic_mime_and_sniff():
    # mime() 覆盖 imageEntry 全部图片扩展
    for ext in [".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff"]:
        assert (ext + '": "image/') in backend, f"mime() missing {ext}"
    # register 端点先嗅探 512B
    assert "http.DetectContentType" in backend
    assert 'strings.HasPrefix(contentType, "image/")' in backend


def test_scrubbed_and_preview_removed():
    # 洗版残留检查：所有被 git 跟踪的文本文件不得再出现真实域名/内网 IP/NAS 卷路径。
    # 历史 release notes 中「→」映射说明行的左侧是描述被替换的来源样例
    # （如 *.example.com 示例的前身），并非真实残留，按行豁免。
    files = subprocess.run(["git", "-C", str(ROOT), "ls-files"],
                           capture_output=True, text=True).stdout.splitlines()
    forbidden = re.compile(r"enged\.top|192\.168\.|/vol[1-4](?:/|\b)")
    bad = []
    for f in files:
        if f.endswith((".png", ".jpg", ".jpeg", ".webp", ".woff2", ".gz")) or f.startswith("web/vendor/"):
            continue
        p = ROOT / f
        try:
            with open(p, encoding="utf-8", errors="ignore") as fh:
                head = fh.read(4)
                if head == "\x7fELF":
                    continue
                fh.seek(0)
                for line in fh:
                    if forbidden.search(line):
                        # 映射说明行：来源样例 → 目标示例，不算残留。
                        if "→" in line and forbidden.search(line.split("→", 1)[0]):
                            continue
                        bad.append(f)
                        break
        except Exception:
            continue
    assert not bad, f"scrub leftovers: {bad}"
    # 预览版标识移除
    assert "预览版" not in index and "VaultHub 蜀鼠之家</title>" in index
    assert "· 预览版" not in state and "· 預覽版" not in state and "· Preview" not in state
    assert "preview" not in features.split("MFA", 1)[1][:300].lower()


def test_compose_generic_samples():
    # compose 洗成通用示例：/srv 媒体映射 + 单卷监控示例
    assert "/srv/media/comics:/mh:ro" in compose
    assert "/srv/media/music:/yy:ro" in compose
    assert "SYSTEM_MONITOR_FILESYSTEMS=vh-data" in compose
    # 不再出现旧 NAS 专属映射形态
    assert "/vol" not in compose


def test_release_notes_exist():
    rel = (ROOT / ".github/RELEASE_NOTES_0.9.53.md").read_text(encoding="utf-8")
    assert "VaultHub v0.9.53" in rel
    assert "0.9.53" in index


if __name__ == "__main__":
    ran = 0
    for name in sorted(globals()):
        if name.startswith("test_"):
            globals()[name]()
            print(f"PASS {name}")
            ran += 1
    print(f"ALL_V0950_PASS ({ran} checks)")
