#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).parents[1]
HTML = (ROOT / "index.html").read_text()
JS = (ROOT / "web/js/02-media.js").read_text()
HOME = (ROOT / "web/js/05-home.js").read_text()
GO = (ROOT / "media-go/audio_persist.go").read_text()
CACHE = (ROOT / "media-go/audio_cache.go").read_text()
STREAM = (ROOT / "media-go/audio_stream.go").read_text()
MAIN = (ROOT / "media-go/main.go").read_text()

checks = {
    "library table separates scrape state": "刮削读取" in HTML and "homeScrapePill(lib)" in HOME,
    "real scrape status endpoint": '"/api/media/audio/scrape/status"' in MAIN and "audioScrapeStatus" in GO,
    "manual commit endpoint": '"/api/media/audio/metadata/commit"' in MAIN and "commitAudioMetadata" in JS,
    "source sidecar": '.vaulthub.json' in GO and 'generated_by' in GO,
    "query hints UI": all(x in HTML for x in ["audioMetadataQueryTitle", "audioMetadataQueryArtist", "audioMetadataCountry", "audioMetadataSource"]),
    "field locks": all(x in HTML for x in ["audioLockTitle", "audioLockArtist", "audioLockAlbum", "audioLockCover", "audioLockLyrics"]),
    "country/source passed": "country:payload.country" in JS and "source:payload.source" in JS,
    "failed scrape truthful": 'status:"not_found"' in JS and 'status:"failed"' in JS,
    "server and source persistence": "writeAudioMetadataSidecar" in GO and "INSERT OR REPLACE INTO audio_metadata" in GO,
    "memory metadata cache": "let audioMetadataMemory = null" in JS and "if (audioMetadataMemory) return audioMetadataMemory" in JS,
    "dead HEAD removed": 'if r.Method == http.MethodHead' not in STREAM[STREAM.index("func (a *App) weakProbe"):],
    "ffmpeg trusted path": "trustedFFmpegPath()" in STREAM and "boundedErrorBuffer" in STREAM,
    "vault env not restored": "VaultHub.env" not in GO and "vaulthub.env" not in GO,
    # 审查/自查修复的守卫（v0.9.72 收尾）：
    "status freshness uses real file": "audioFileUnchanged" in GO and "fi.Size() == size && fi.ModTime().Unix() == mtime" in GO,
    "status snapshot invalidated on writes": "audioScrapeStatusTTL" in GO and "invalidateAudioScrapeStatus(l.ID)" in GO and "invalidateAudioScrapeStatus(l.ID)" in CACHE,
    "legacy write upserts without erasing": "ON CONFLICT(lib,path) DO UPDATE" in CACHE and "INSERT OR REPLACE INTO audio_metadata" not in CACHE,
    "cache read never drops null rows": "coalesce(m.artist,'')" in CACHE and '"scan_errors": scanErrs' in CACHE,
    "sidecar path mutex": "audioSidecarLock" in GO and "audioSidecarLocks" in GO,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL"), name)
if failed:
    raise SystemExit(f"{len(failed)} checks failed: {failed}")
print(f"PASS v0.9.72 contracts: {len(checks)}/{len(checks)}")
