#!/usr/bin/env python3
"""Contract tests for the v0.6.31 fixes:
1. Sign-out option inside the system settings dialog
2. Caddy config promoted to its own full page, reachable from settings
3. GPU detection actually probes devices + ffmpeg encoders and reports back
4. Session monitoring that warns before add/delete library writes
5. Faster video cache: fragmented-MP4 live streaming + background seekable build
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
media = (ROOT / "media-go" / "main.go").read_text()
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
state = (ROOT / "web" / "js" / "01-state.js").read_text()
features = (ROOT / "web" / "js" / "03-features.js").read_text()
boot = (ROOT / "web" / "js" / "04-boot.js").read_text()
css = (ROOT / "web" / "css" / "main.css").read_text()

# --- 1. Sign out from the settings dialog ---
assert 'data-settab="account"' in html, "settings needs an account tab"
assert 'id="setpanel-account"' in html, "settings needs an account panel"
assert 'onclick="logoutVaultHub()"' in html, "settings needs a sign-out button"
assert "async function logoutVaultHub(" in state
assert "'/api/logout'" in state and "showVaultHubLogin()" in state

# --- 2. Caddy config on a dedicated full page ---
assert 'id="caddyPage"' in html, "Caddy needs its own full page container"
assert 'class="fullpage"' in html
assert 'onclick="openCaddyPage()"' in html, "settings must link to the Caddy page"
assert "function openCaddyPage(" in state and "function closeCaddyPage(" in state
assert ".fullpage.show" in css and ".fullpage-body textarea" in css
# The textarea moved out of the settings panel into the full page.
assert html.count('id="caddyFile"') == 1, "exactly one Caddyfile textarea"

# --- 3. GPU detection is real ---
assert "func detectHardware(" in media, "backend must actually detect hardware"
assert "func ffmpegEncoders(" in media, "must enumerate ffmpeg encoders"
assert "func vaapiDevice(" in media and '"/dev/dri"' in media
assert "func nvidiaPresent(" in media and "/dev/nvidiactl" in media
assert 'h264_nvenc' in media and 'h264_vaapi' in media and 'h264_qsv' in media
assert "detectHardware(r.Context(), r.URL.Query().Get(\"hw\"))" in media, \
    "the hardware endpoint must call the detector, not return a stub"
assert '"selected": "cpu", "available": map[string]bool{"cpu": true, "vaapi": false' not in media, \
    "hardcoded hardware stub must be gone"
assert 'onclick="refreshHardwareStatus(true)"' in html, "detect button must request notification"
assert "async function refreshHardwareStatus(notify)" in state
assert 'id="hardwareDetail"' in html and "nvidia_device" in state and "encoders" in state

# --- 4. Session monitoring guards library writes ---
assert "async function refreshSessionStatus(" in state
assert "async function ensureSessionForWrite(" in state
assert "function renderSessionStatus(" in state
assert 'id="sessionStatusBadge"' in html
# v0.7.0 moved the only add-library entry point into 05-home.js (the old per-group
# modal is gone), so search the whole shipped frontend rather than one split file.
assert 'ensureSessionForWrite(t("writeAddLibrary"))' in html, "add-library must check the session first"
assert 'ensureSessionForWrite(t("writeDeleteLibrary"))' in html, "delete-library must check the session first"
# Session failure copy lives in the tri-lingual dictionary, not inline strings.
assert 'sessionWriteBlocked' in html, "write failures must report an invalid session"
assert 'sessionBad: "登录状态异常"' in state, "zh-CN dictionary needs the invalid-session label"
assert 'caddySaveBlocked' in state and 'writeAddLibrary' in state and 'writeDeleteLibrary' in state
assert "refreshSessionStatus(false)" in boot, "boot must prime the session indicator"
assert "setInterval(() => refreshSessionStatus(false), 60000)" in boot, "session must be polled"

# --- 5. Video cache speed: live fragmented stream + background seekable build ---
assert "func compatArgs(" in media, "shared ffmpeg arg builder"
assert "func (a *App) buildCompatCache(" in media, "background seekable cache build"
assert "+frag_keyframe+empty_moov+default_base_moof" in media, \
    "cache miss must stream fragmented MP4 so playback starts immediately"
assert '"pipe:1"' in media, "live path must pipe instead of writing then serving"
assert "http.Flusher" in media, "must flush fragments as they are produced"
assert '"X-VaultHub-Compat", "live"' in media and '"X-VaultHub-Compat", "cache"' in media
assert "compatBuilds" in media and "compatMu" in media, "dedupe concurrent background builds"
assert 'env("COMPAT_PRECACHE", "1")' in media, "precache must be switchable"
assert "func hwEncodeArgs(" in media, "hardware encoder args for non-H.264 sources"
assert '"-preset", "veryfast"' in media, "software fallback must use a fast preset"

print("PASS: v0.6.31 sign-out, Caddy full page, GPU detection, session monitor, fast video cache")
