#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
html = (root / "index.html").read_text()
media = (root / "media-api.c").read_text()

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
]
for marker in required:
    assert marker in html, f"missing audio feature: {marker}"

assert 'loadLocalFiles("audio"' in html
assert 'group === "audio" ? audioPageSize' in html, "audio list still uses fixed page size"
assert 'Bangumi' in html and 'api.bgm.tv' in html, "comic cover scraper lacks Bangumi source"
assert 'mediaFileUrl(lib, path)' in html, "audio reader does not use stable query-parameter file URL"
assert 'encodeURIComponent(String(path))' in html, "reader path is not percent-encoded in query transmission"
assert 'serve_file_query' in media, "media API lacks stable query file reader"
print("PASS: audio controls, metadata views, Bangumi source, and stable ebook URLs are present")
