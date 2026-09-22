#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.69 契约测试：P3 加固项的守卫。

背景：v0.9.69 的发布说明曾声称「已为 4 项补契约守卫」，但独立审查用**突变测试**证明：
把这 4 项改动全部回退后，Python 契约与 Go 测试仍然全绿 —— 即守卫并不存在（发布声明不实）。
本文件就是那些守卫，逐条对应一项加固，任何一个被改回去都会让本测试失败。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_TRANS = (ROOT / "media-go/page_transcode.go").read_text(encoding="utf-8")
GO_LYRICS = (ROOT / "media-go/audio_lyrics.go").read_text(encoding="utf-8")
GO_ACACHE = (ROOT / "media-go/audio_cache.go").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.69.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")

checks = {
    # 1. 转码源体积上限与像素上限对齐（96MB → 32MB）
    "源体积上限对齐像素上限": "maxPageSourceBytes = 32 << 20" in GO_TRANS
        and "maxPageSourceBytes = 96 << 20" not in GO_TRANS,

    # 2. 元数据缓存读取上限：SQL 侧 ORDER BY + LIMIT，多取一批判定 truncated
    #    （v0.9.72 起为避免「磁盘已变化的过期行」占满配额，扫描上限改为 limit 的 2 倍）
    "缓存 SQL 侧 LIMIT": "ORDER BY m.path LIMIT ?" in GO_ACACHE
        and "audioCacheScanCap(limit)" in GO_ACACHE,
    "缓存 limit 参数与上限": 'Get("limit")' in GO_ACACHE and "n <= 50000" in GO_ACACHE
        and "limit := 5000" in GO_ACACHE,
    "缓存 truncated 标记": '"truncated": truncated' in GO_ACACHE
        and '"limit": limit' in GO_ACACHE,
    "多取行不入响应": "break" in GO_ACACHE.split("if len(items) >= limit {")[1].split("}")[0],

    # 3. 批量歌词串行闸门（闭包释放：不可被非持有者误释放）
    "批量闸门闭包释放": "func (a *App) beginLyricsBatch() (func(), bool)" in GO_LYRICS
        and "return func() { <-a.lyricsBatchSem }, true" in GO_LYRICS,
    "批量闸门无独立 end": "func (a *App) endLyricsBatch(" not in GO_LYRICS,
    "批量冲突返回 429": 'errJSON(w, 429, "another lyrics batch is already running")' in GO_LYRICS
        and "defer releaseBatch()" in GO_LYRICS,
    "闸门在 load() 内初始化": "lyricsBatchSem = make(chan struct{}, 1)" in GO_MAIN
        and "a.pageCacheDir = env(" in GO_MAIN,

    # 4. 前端：请求带上限、处理 truncated、429 友好提示、文案准确
    "前端请求带 limit": "audio/cache?id=${encodeURIComponent(libId)}&limit=5000" in MEDIA,
    "前端处理 truncated": 'data.truncated' in MEDIA and "仅载入前" in MEDIA,
    "前端 429 友好提示": 'if (res.status === 429) throw new Error("已有歌词刮削任务在进行中，请稍后重试")' in MEDIA,
    "前端配额提示不再武断": "if (!writeAudioMetadata.warned)" in MEDIA
        and "writeAudioMetadata.warned = true" in MEDIA
        and "浏览器本地缓存写入失败" in MEDIA
        and "元数据已改由服务端缓存保存" not in MEDIA,

    # 5. 版本与文档自洽
    "版本串一致": 'VAULTHUB_ASSET_VERSION = "0.9.74"' in (ROOT / "index.html").read_text(encoding="utf-8")
        and 'VAULTHUB_SCRIPT_VERSION = "0.9.74"' in (ROOT / "web/js/01-state.js").read_text(encoding="utf-8"),
    "发布说明含加固项": "v0.9.69" in NOTES and "32MB" in NOTES and "truncated" in NOTES
        and "429" in NOTES,
    "更新日志有本版段": "# VaultHub 蜀鼠之家 v0.9.74" in LOG,
    "历史说明未改": (ROOT / ".github/RELEASE_NOTES_0.9.68.md").read_text(encoding="utf-8").startswith(
        "# VaultHub 蜀鼠之家 v0.9.68"),
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.69 契约 {len(failed)} 项未通过: {failed}")
print("PASS: v0.9.69 P3 加固项（源体积上限/缓存 SQL LIMIT+truncated/批量闸门闭包/前端提示）契约通过")
