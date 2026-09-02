#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
source = (root / "tests" / "fixtures" / "media-api_legacy.c").read_text()

comic_required = ["epub", "mobi", "zip", "cbz", "pdf", "rar", "cbr", "7z", "cb7", "jpg", "jpeg", "png", "cpg", "lzh", "cbl", "tar", "cbt"]
book_required = ["epub", "pdf", "mobi", "azw", "azw3", "chm", "exe", "umd", "jar", "jad", "caj", "pdg", "djvu", "ceb", "doc", "docx", "xps"]
movie_required = ["mp4", "mkv", "avi", "mov", "m4v", "webm", "ts", "m2ts", "wmv", "flv", "mpg", "mpeg", "rmvb", "iso"]

assert "const MEDIA_FORMATS" in html, "frontend lacks centralized media format lists"
for ext in comic_required:
    assert f'"{ext}"' in html, f"comic format missing from frontend list: {ext}"
for ext in book_required:
    assert f'"{ext}"' in html, f"ebook format missing from frontend list: {ext}"
for ext in movie_required:
    assert f'"{ext}"' in html, f"movie format missing from frontend list: {ext}"

# v0.7.0 moved library management into 系统设置 → 媒体库 and now builds the subtype
# <select> from mediaTypesForGroup()/mediaTypeName() instead of hardcoding options,
# so assert the data contract that produces 电影 / 电视剧集 rather than the old markup.
assert 'mediaTypesForGroup(group)' in html, "subtype options must be derived from the group"
assert 'group === "movie" ? ["movie","series"]' in html, "movie group must offer movie+series subtypes"
assert 'typeMovie: "电影"' in html, "movie subtype label missing from the zh-CN dictionary"
assert 'typeSeries: "电视剧集"' in html, "series subtype label missing from the zh-CN dictionary"
# v0.9.30: 子类型下拉随路径/库名称/添加按钮搬进各自的大类卡片，
# 每个大类都有独立的 id（homeLibType-comic / -movie / -audio）。
for g in ("comic", "movie", "audio"):
    assert f'id="homeLibType-{g}"' in html, f"the {g} library card must expose its own subtype select"
assert 'mediaTypesForGroup(group).includes(lib.type)' in html, "movie local libraries are not selectable"
assert 'setMediaMode(\'${esc(group)}\',\'local\')' in html or "本地媒体库" in html, "media source mode bar missing"
assert 'if (group === "movie") return "external"' not in html, "movie mode is still forced to external"
assert 'renderMovieLibrary' in html, "movie local library renderer missing"
assert 'scrapeMovieMetadata' in html, "movie scraper pipeline missing"
assert 'movie.douban.com/j/subject_suggest' in html, "Douban default scraper missing"
assert '/api/media/tmdb?query=' in html, "TMDB proxy scraper call missing"
assert 'TMDB_API_KEY' in source, "backend does not gate TMDB scraping on TMDB_API_KEY"
assert 'tmdb_enabled' in source, "backend does not expose scraper status"
assert '||!strcmp(lib.type,"movie")' in source, "backend rejects movie library type"

for ext in [".mp4", ".mkv", ".webm", ".azw3", ".djvu", ".cb7", ".cbt", ".cbl"]:
    assert ext in source, f"backend MIME support missing for {ext}"

print("PASS: expanded comic/ebook formats and local movie scraping/playback markers are present")
