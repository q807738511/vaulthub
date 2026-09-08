#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.59 契约测试：音频/视频播放期间保持前端与服务端登录会话。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
FEATURES = (ROOT / "web/js/03-features.js").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.59.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")

checks = {
    "版本资源": 'VAULTHUB_ASSET_VERSION = "0.9.59"' in HTML,
    "脚本版本": 'VAULTHUB_SCRIPT_VERSION = "0.9.59"' in STATE,
    "静态缓存串": HTML.count("?v=0.9.59") >= 6,
    "五分钟保活周期": "MEDIA_KEEPALIVE_MS = 5 * 60 * 1000" in STATE,
    "具名幂等 source": "const mediaKeepAliveSources = new Set()" in STATE,
    "保活刷新前端 idle": "markVaultHubActivity();" in STATE,
    "保活滑动服务端会话": "fetch('/api/system/runtime'" in STATE and "credentials: 'same-origin'" in STATE,
    "保活响应鉴权处理": "await handleProtectedResponse(res)" in STATE,
    "音频播放启动": 'addEventListener("play", startAudioSessionKeepAlive)' in MEDIA,
    "音频停止与错误释放": "stopAudioSessionKeepAlive();" in MEDIA and 'addEventListener("error", stopAudioSessionKeepAlive)' in MEDIA,
    "音频切歌幂等": 'mediaKeepAliveStart("audio")' in MEDIA and 'mediaKeepAliveStop("audio")' in MEDIA,
    "视频实际播放启动": 'addEventListener("playing", () => mediaKeepAliveStart("video"))' in MEDIA,
    "视频结束错误释放": 'addEventListener("ended", () => mediaKeepAliveStop("video"))' in MEDIA and 'addEventListener("error", () => mediaKeepAliveStop("video"))' in MEDIA,
    "视频关闭释放": 'function stopVideoPlaybackSession(root) {\n  mediaKeepAliveStop("video");' in MEDIA,
    "关闭播放器调用停止会话": "stopVideoPlaybackSession(root)" in FEATURES,
    "发布说明": "VaultHub v0.9.59" in NOTES and "媒体播放期间会话保活" in NOTES,
    "更新日志": "VaultHub 蜀鼠之家 v0.9.59" in LOG and "长时间播放" in LOG,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.59 契约 {len(failed)} 项未通过")
print("PASS: v0.9.59 音频/视频媒体播放会话保活契约通过")
