#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
media = (root / "tests" / "fixtures" / "media-api_legacy.c").read_text()

# Audio page must be a real local music library, not only a flat file list.
required = [
    'audioPageSize',
    'setAudioPageSize',
    '<option value="20"',
    '<option value="50"',
    '<option value="100"',
    'scrapeAudioMetadata',
    'audioMetadataCache',
    'renderAudioAlbums',
    'renderAudioArtists',
    'audio-bottom-player',
    'audioPrevious',
    'audioNext',
    'audioStop',
    'showAudioDetails',
    'audioCover',
    'manualAudioMetadata',
    'audioLoopButton',
    'cycleAudioLoop',
    'setAudioLoop',
    'toggleAudioMaximize',
    'parseLyrics',
    'seekLyric',
    'audioFavoriteButton',
    "setAudioView('favorites')",
    'buildEbookChapters',
    'ebook-chapters',
    'changeEbookFontSize',
    'toggleEbookFontStyle',
]
for marker in required:
    assert marker in html, f"missing audio feature: {marker}"

assert 'loadLocalFiles("audio"' in html
assert 'group === "audio" ? audioPageSize' in html, "audio list still uses fixed page size"
assert 'Bangumi' in html and 'api.bgm.tv' in html, "comic cover scraper lacks Bangumi source"
assert 'mediaFileUrl(lib, path)' in html, "audio reader does not use stable query-parameter file URL"
assert 'encodeURIComponent(String(path))' in html, "reader path is not percent-encoded in query transmission"
assert 'serve_file_query' in media, "media API lacks stable query file reader"
assert 'textContent = activeAudio && isAudioFavorite(activeAudio.libId, activeAudio.path) ? "♥" : "♡"' in html, "player favorite button does not sync with favorite list"
assert 'audioLoopMode === "single"' in html, "single-track loop mode missing"
assert 'audioLoopMode === "random"' in html, "random play mode missing"
assert 'bar.classList.toggle("show", document.getElementById("view-audio")?.classList.contains("active"))' in html, "player is not restricted to the audio view"
assert 'viewerShell(group, lib, path, body, url, { chapters, ebook: true, doc: true })' in html, "ebook reader does not render chapter sidebar and typography toolbar"
print("PASS: audio controls, metadata views, Bangumi source, and stable ebook URLs are present")
