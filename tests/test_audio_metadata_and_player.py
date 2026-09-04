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
    # v0.9.53: manual playlists
    'audioPlaylistsCache',
    'openAudioPlaylistPicker',
    'renderAudioPlaylists',
    'createAudioPlaylistFromPicker',
    'deleteAudioPlaylist',
    'loadPlaylistTracks',
    'audioPlaylistFilter',
    "setAudioView('playlists')",
    '♫ 歌单',
    'title="加入歌单"',
    'audioPlaylistModal',
    'audioPlaylistNewName',
    'audioScrapeAttemptedSession',
    'refreshAudioMetadata',
]
for marker in required:
    assert marker in html, f"missing audio feature: {marker}"

assert 'loadLocalFiles("audio"' in html
assert 'group === "audio" ? audioPageSize' in html, "audio list still uses fixed page size"
assert 'Bangumi' in html and 'api.bgm.tv' in html, "comic cover scraper lacks Bangumi source"
assert 'graphql.anilist.co' in html, "comic cover scraper lacks AniList source"
assert 'AbortController' in html and 'COMIC_COVER_TIMEOUT' in html, "cover sources must time out per source"
assert 'mediaFileUrl(lib, path)' in html, "audio reader does not use stable query-parameter file URL"
assert 'encodeURIComponent(String(path))' in html, "reader path is not percent-encoded in query transmission"
assert 'serve_file_query' in media, "media API lacks stable query file reader"
assert 'button.innerHTML = fav ? audioIcon("heartFill") : audioIcon("heart")' in html, "player favorite button must swap heart/heartFill SVG by state"
assert 'audio-fav-on' in html and 'heartFill' in html, "favorite button needs filled-heart state highlight"
assert 'audioLoopMode === "single"' in html, "single-track loop mode missing"
assert 'audioLoopMode === "random"' in html, "random play mode missing"
# v0.9.53: play-mode buttons must live only in the player, not on track/album list headers
assert 'onclick="setAudioLoop(\'random\')"' not in html, "random-play button still shown in track list header"
assert 'onclick="setAudioLoop(\'sequence\')"' not in html, "sequence-play button still shown in track list header"
assert 'onclick="setAudioLoop(\'list\')"' not in html, "list-loop button still shown in track list header"
assert 'bar.classList.toggle("show", document.getElementById("view-audio")?.classList.contains("active"))' in html, "player is not restricted to the audio view"
assert 'viewerShell(group, lib, path, body, url, { chapters, ebook: true, doc: true })' in html, "ebook reader does not render chapter sidebar and typography toolbar"
print("PASS: audio controls, manual playlists, Bangumi+AniList covers, and stable ebook URLs are present")
