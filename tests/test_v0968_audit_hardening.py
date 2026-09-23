#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.69 契约测试：第一轮独立安全审查「非阻塞项」的逐条修复守卫。

每一条都对应审查报告里的一条建议，防止后续改动把它们改回去。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
MEDIA = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
GO_MAIN = (ROOT / "media-go/main.go").read_text(encoding="utf-8")
GO_CACHE = (ROOT / "media-go/page_cache.go").read_text(encoding="utf-8")
GO_HANDLER = (ROOT / "media-go/page_handler.go").read_text(encoding="utf-8")
GO_LYRICS = (ROOT / "media-go/audio_lyrics.go").read_text(encoding="utf-8")
GO_ACACHE = (ROOT / "media-go/audio_cache.go").read_text(encoding="utf-8")
NOTES = (ROOT / ".github/RELEASE_NOTES_0.9.69.md").read_text(encoding="utf-8")
LOG = (ROOT / "Update Log.md").read_text(encoding="utf-8")
NOTES_0967 = (ROOT / ".github/RELEASE_NOTES_0.9.67.md").read_text(encoding="utf-8")

checks = {
    # 1. 受鉴权保护的资源不得标 public（共享缓存可向未登录者重放）
    "转码结果用 private": "private, max-age=31536000, immutable" in GO_HANDLER
        and "public, max-age=31536000, immutable" not in GO_HANDLER,

    # 2. 缓存键纳入归档自身 size/mtime（而非仅条目元数据）
    "归档身份入键": "os.Stat(archivePath)" in GO_HANDLER and "arcSize, arcMod" in GO_HANDLER,

    # 3. 封面必须真缩略：w=0 → 400，不可转码 → 404（不回整张原图）
    "封面拒绝 w=0": 'errJSON(w, 400, "cover requires w>=64")' in GO_HANDLER,
    "封面失败不回原图": 'errJSON(w, 404, "cover unavailable")' in GO_HANDLER
        and 'writeArchiveEntryRaw(w, ze.files[idx[0]], ze.display[idx[0]])' not in GO_HANDLER,

    # 4. leader 路径必须保证结束 job（含 panic）
    "job 一定结束": "defer func() {" in GO_HANDLER and "if rec := recover(); rec != nil {" in GO_HANDLER
        and "a.endPageJob(key, job, file, cached)" in GO_HANDLER,

    # 5. 歌词限定音频库 + 音频扩展名
    "歌词限定音频库": 'l.Type != "audio"' in GO_LYRICS,
    "音频扩展名白名单": "func isAudioMediaPath(" in GO_LYRICS and "audioMediaExts" in GO_LYRICS,
    "识别阶段也校验": 'errJSON(w, 400, "not an audio file")' in GO_LYRICS,

    # 6. sidecar 写入加固
    "sidecar 唯一临时名": "os.CreateTemp(dir," in GO_LYRICS and 'stem+".lrc"' in GO_LYRICS,
    "sidecar 拒绝符号链接": "os.Lstat(final)" in GO_LYRICS and "os.ModeSymlink" in GO_LYRICS,
    "sidecar fsync": "f.Sync()" in GO_LYRICS and "os.Chmod(tmp, 0o644)" in GO_LYRICS,

    # 7. 批量歌词：上限 50 + 总时长预算
    "批量上限 50": "if len(in.Items) > 50 {" in GO_LYRICS,
    "批量时长预算": "context.WithTimeout(r.Context(), 150*time.Second)" in GO_LYRICS
        and "batchCtx.Err()" in GO_LYRICS,

    # 8. 淘汰：锁内摘表、锁外 unlink
    "淘汰锁外 unlink": "victims := make([]string, 0, 8)" in GO_CACHE
        and "go func(paths []string)" in GO_CACHE,

    # 9. 清空整库缓存需显式 all=1
    "清空需 all=1": 'r.URL.Query().Get("all") == "1"' in GO_ACACHE
        and 'errJSON(w, 400, "path or all=1 required")' in GO_ACACHE,

    # 10. 前端 setPlaybackBg 清洗 URL
    "背景 URL 清洗": "bg.style.backgroundImage = `url('${cssUrlValue(imageUrl)}')`" in MEDIA,

    # 版本与发布物
    "HTML版本": 'VAULTHUB_ASSET_VERSION = "0.9.75"' in HTML and HTML.count("?v=0.9.75") >= 7,
    "脚本版本": 'VAULTHUB_SCRIPT_VERSION = "0.9.75"' in STATE,
    "UI角标": "v0.9.75 · 影视详情精修" in HTML,
    "发布说明": "VaultHub 蜀鼠之家 v0.9.69" in NOTES and "非阻塞" in NOTES,
    "更新日志段": "# VaultHub 蜀鼠之家 v0.9.75" in LOG,
    # 历史说明只增不改（v0.9.67 的说明文件必须仍以它自己的标题开头）
    "历史说明未改": NOTES_0967.startswith("# VaultHub 蜀鼠之家 v0.9.67"),
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(f"FAIL: v0.9.69 契约 {len(failed)} 项未通过: {failed}")
print("PASS: v0.9.68 独立安全审查非阻塞项修复契约通过")
