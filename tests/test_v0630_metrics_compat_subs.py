#!/usr/bin/env python3
"""Contract tests for the v0.6.30 fixes: real CPU/network/temperature metrics,
compat stream copy + audio-track mapping, embedded subtitle extraction, and the
settings/Caddy button + About stack updates."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
media = (ROOT / "media-go" / "main.go").read_text()
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
features = (ROOT / "web" / "js" / "03-features.js").read_text()
state = (ROOT / "web" / "js" / "01-state.js").read_text()
media_js = (ROOT / "web" / "js" / "02-media.js").read_text()

# --- Backend: system metrics compute real values ---
for marker in [
    "func readCPU(",              # CPU busy % from /proc/stat delta
    "func hwmonTemps(",           # temperatures from /host/sys/class/hwmon
    "func pickInterface(",        # physical NIC auto-selection
    "syscall.Statfs",             # filesystem capacity
    'strings.HasPrefix(iface, "veth")',
    '"disk_temperatures"',
    '"temperatures"',
    '"swap_used"',
    '"cores"',
]:
    assert marker in media, f"missing metrics backend marker: {marker}"

# --- Backend: compat copies H.264 and maps chosen audio track ---
assert "func probeVideoCodec(" in media, "compat must probe video codec"
assert 'if vc, _ := probeVideoCodec(ctx, p); vc == "h264"' in media, "compat must copy H.264 video"
assert 'vcodec = "copy"' in media
assert '"0:a:%d?"' in media, "compat must map selected audio track"
assert 'audioTrack := r.URL.Query().Get("audio_track")' in media

# --- Backend: embedded subtitle extraction to WebVTT ---
assert "func (a *App) extractSubtitle(" in media
assert '"/api/media/subtitles/extract"' in media
assert '"webvtt"' in media
assert '"subtitle_tracks"' in media

# --- Frontend: monitoring renders new fields ---
assert "renderDiskTemps(" in features, "front-end must render disk temperatures"
assert "cpu.cores" in features and "cpu.temp" in features
assert "swap_used" in features
assert "netInterface" in html

# --- Frontend: settings/Caddy buttons open directly (guard removed) ---
assert "guardProtectedAction(openCaddyModal)" not in html, "Caddy button must not be guard-wrapped"
assert "guardProtectedAction(()=>openModal('settingsModal'))" not in html, "settings button must not be guard-wrapped"
# v0.6.30.Branch-update relocated the Caddy editor into the settings modal as a
# tab, so the standalone toolbar button is gone. The entry point must still be
# reachable without a guard wrapper: openCaddyModal() opens settings on the
# Caddy tab, and the settings modal itself opens from the top bar.
assert "function openCaddyModal(" in state, "openCaddyModal must still exist as the Caddy entry point"
assert "switchSetTab('caddy')" in html, "settings modal must expose the Caddy tab"
assert 'onclick="openModal(\'settingsModal\')"' in html
# Dead Caddy fields removed
assert 'id="caddyToken"' not in html, "obsolete Caddy token field must be removed"
assert 'id="caddyOrigin"' not in html, "obsolete Caddy origin field must be removed"
assert "caddyApiHeaders" not in state, "obsolete caddyApiHeaders helper must be removed"

# --- Frontend: embedded subtitle option population ---
assert "subtitle_tracks" in media_js, "player must consume embedded subtitle tracks"

# --- About/sidebar version must be at least 0.6.30 (later releases bump it) ---
# Read the version out of the About row and the sidebar footer specifically, so
# unrelated v0.6.x mentions in code comments cannot satisfy this assertion.
import re as _re
index_html = (ROOT / "index.html").read_text(encoding="utf-8")
_shown = _re.findall(r'class="ver">v(\d+)\.(\d+)\.(\d+)', index_html)
_shown += _re.findall(r'data-i18n="aboutVer">[^<]*</span><b>v(\d+)\.(\d+)\.(\d+)', index_html)
assert len(_shown) >= 2, f"both the sidebar footer and About row must show a version, got {_shown}"
_tuples = [tuple(int(x) for x in v) for v in _shown]
assert len(set(_tuples)) == 1, f"sidebar and About versions must agree, got {_tuples}"
assert _tuples[0] >= (0, 6, 30), f"version must be >= 0.6.30, found {_tuples[0]}"
assert "v0.6.22" not in html, "stale 0.6.22 version string remains"

print("PASS: v0.6.30 metrics, compat copy, embedded subtitles, and UI fixes present")
