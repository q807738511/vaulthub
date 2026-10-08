#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
STATE = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
HOME = (ROOT / "web/js/05-home.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")

# 影视库普通列表不能再固定请求 50 条并显示分页；必须自动拉取全量。
assert "group === \"movie\" ? 50 : 100" not in JS
assert "fetchAllLibraryFiles" in JS or "fetchRemainingLibraryFiles" in JS
assert "seriesTruncated" not in JS or "20,000" not in JS

# v0.9.30：主导航「媒体搜索」直接搜索媒体库，不再打开系统设置。
assert "openMediaSearch" in JS
assert "媒体搜索" in HTML or "mediaSearch" in HTML

# v0.9.93：侧栏已彻底移除 —— 影视详情不再需要「临时收起侧栏」，
# 改为断言旧机制确实清干净、且详情页关闭逻辑仍在。
assert "sidebar-hidden" not in STATE and "sidebar-hidden" not in JS
assert "enterMovieDetailSidebarMode" not in STATE and "enterMovieDetailSidebarMode" not in JS
assert "closeMovieDetails" in JS

# 电子书/漫画的常见格式和压缩包格式应统一识别，且书籍不能被误判为电影。
for ext in ("epub", "pdf", "mobi", "azw3", "txt", "cbz", "cbr", "cb7", "cbt"):
    assert f'"{ext}"' in JS, ext
assert "MEDIA_FORMATS.book" in JS and "MEDIA_FORMATS.comic" in JS
assert "archiveLike" in JS

assert "v0.9.56" in HTML
print("PASS: v0.9.56 full movie listing, media search nav, sidebar detail lifecycle and book/comic recognition contracts")
