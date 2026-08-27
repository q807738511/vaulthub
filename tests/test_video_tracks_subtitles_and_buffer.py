from pathlib import Path

root = Path(__file__).resolve().parents[1]
html = (root / "index.html").read_text(encoding="utf-8")
media = (root / "tests" / "fixtures" / "media-api_legacy.c").read_text(encoding="utf-8")

checks = {
    "custom buffered progress": "video-buffered-range" in html and "updateVideoTimeline" in html,
    "actual time display": "video-time-label" in html and "formatVideoTime" in html,
    "resume position": "saveVideoPlaybackState" in html and "restoreVideoPlaybackState" in html,
    "keyboard does not reload": "handleVideoKeyboard" in html and "event.repeat" in html,
    "subtitle menu": "video-subtitle-menu" in html and "searchVideoSubtitles" in html,
    "subtitle attachment": "attachVideoSubtitle" in html and "video.textTracks" in html,
    "audio track menu": "video-audio-menu" in html and "selectVideoAudioTrack" in html,
    "stream discovery api": "/api/media/streams" in media and "probe_media_streams" in media,
    "subtitle search api": "/api/media/subtitles/search" in media and "subtitle_search" in media,
    "subtitle proxy api": "/api/media/subtitles/proxy" in media and "subtitle_proxy" in media,
    "selected audio mapping": "audio_track" in media and "-map 0:a:%d?" in media,
}
failed = [name for name, ok in checks.items() if not ok]
assert not failed, "missing: " + ", ".join(failed)
print("PASS: video resume, buffer timeline, subtitles, and audio track selection are present")
