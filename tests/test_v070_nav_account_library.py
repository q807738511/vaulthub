#!/usr/bin/env python3
"""Contract tests for the v0.7.0 UI restructure.

1. Index build progress is observable (percent/scanned/elapsed + polling UI)
2. The sidebar no longer duplicates the three resource categories
3. Library management/add lives in 系统设置, and the sidebar "add module" button is gone
4. System settings + About + sign-out moved into the account avatar menu, plus avatar settings
5. The top bar has no 首页/资料库 buttons; its right side only shows library/home info
6. Home "recently added" cards open the reader/player directly
7. Local libraries and external services are both sources under 媒体库增加
"""
import pathlib
import re
import sys
import os

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, os.path.dirname(__file__))
from _frontend import frontend_source as _fs

html = _fs()
index = (ROOT / "index.html").read_text(encoding="utf-8")
state = (ROOT / "web" / "js" / "01-state.js").read_text(encoding="utf-8")
media = (ROOT / "web" / "js" / "02-media.js").read_text(encoding="utf-8")
features = (ROOT / "web" / "js" / "03-features.js").read_text(encoding="utf-8")
boot = (ROOT / "web" / "js" / "04-boot.js").read_text(encoding="utf-8")
home = (ROOT / "web" / "js" / "05-home.js").read_text(encoding="utf-8")
css = (ROOT / "web" / "css" / "main.css").read_text(encoding="utf-8")
backend = (ROOT / "media-go" / "main.go").read_text(encoding="utf-8")

# ---------------------------------------------------------------- 1. build progress
# The backend must publish machine-readable progress, not just a state string.
for field in ['Percent int', 'Elapsed int64', 'Now     int64']:
    assert field in backend, f"index status must expose {field} for the progress UI"
assert '`json:"percent"`' in backend and '`json:"elapsed"`' in backend, \
    "percent/elapsed must be serialised for the frontend"
assert 's.Scanned * 100 / s.Total' in backend, "percent must be derived from scanned/total"
assert 'if s.Running && p >= 100' in backend, \
    "a running scan must never report 100% so the UI keeps polling"
# A scan already in flight with no rows yet must still report indexing.
assert 'if total == 0 && busy {' in backend, \
    "an in-flight scan with no rows yet must report indexing, not an empty list"
assert '"scanning": true' in backend, "the files payload must flag an active scan"

# The frontend must render a real progress block and poll it.
assert "function buildProgressHtml(" in media, "build progress block renderer missing"
assert "function startBuildProgressWatch(" in media, "build progress polling missing"
assert "function stopBuildProgressWatch(" in media, "build progress polling must be stoppable"
assert "function cancelLibraryBuild(" in media, "the user must be able to cancel a stuck build"
assert "/api/media/index/cancel?id=" in media, "cancel must call the backend cancel endpoint"
assert '"/api/media/index/status"' in media, "progress must be polled from index/status"
assert re.search(r'setInterval\(async \(\) => \{[\s\S]{0,1200}?\}, 2000\)', media), \
    "build progress must refresh on a short interval"
assert 'target.innerHTML = buildProgressHtml(lib);' in media, \
    "the indexing placeholder must be replaced by the progress block"
assert "正在后台建立低速索引，请稍后刷新" not in media, \
    "the old unmonitorable 'refresh later' placeholder must be gone"
for key in ["buildProgress", "buildScanned", "buildElapsed", "buildCancel", "buildWaiting"]:
    assert key in state, f"build progress copy must be translatable: {key}"
assert ".build-progress" in css and ".bp-bar" in css, "progress block needs styling"
assert ".bp-bar.indeterminate" in css, \
    "phase 1 has no total yet, so an indeterminate bar is required"

# ---------------------------------------------------------------- 2. sidebar dedupe
nav = index[index.index('<aside class="sidebar"'):index.index('</aside>')]
# The three category groups and their duplicate category entries must be gone.
for gone in ['data-nav-group="book"', 'data-nav-group="video"', 'data-nav-group="audio"',
             'data-module="comic"', 'data-module="movie"', 'data-module="audio"',
             'id="libNavComic"', 'id="libNavMovie"', 'id="libNavAudio"']:
    assert gone not in nav, f"sidebar must not still contain {gone}"
assert 'data-nav-group="library"' in nav, "sidebar needs one flat 媒体库 group"
assert 'id="libNavAll"' in nav, "sidebar needs a single flat library list host"
# Only home and PT stay as fixed sidebar entries.
assert nav.count('data-module=') == 2, "only 首页 and PT 管理 may remain as fixed modules"
# The flat list is built from the user-entered library names.
assert 'const host = document.getElementById("libNavAll");' in home, \
    "renderHomeLibraryNav must fill the flat list"
assert 'esc(lib.name)' in home, "sidebar entries must show the library name"
assert "libNavEmpty" in home and "libNavEmpty" in state, "empty sidebar needs a translated hint"
# Category labels only survive as scraping-source descriptions inside settings.
settings_block = index[index.index('id="setpanel-library"'):index.index('id="setpanel-caddy"')]
for label in ['navGroupBook', 'navGroupVideo', 'navGroupAudio']:
    assert label in settings_block, f"{label} must still be selectable when configuring a library"

# ---------------------------------------------------------------- 3. library mgmt in settings
assert 'id="mediaLibraryModal"' not in index, "the standalone library modal must be gone"
assert 'function saveMediaLibraries(' not in features, "the old modal save path must be gone"
assert 'renderMediaLibraryConfigList' not in html, "the old modal list renderer must be gone"
assert 'data-settab="library"' in index, "系统设置 needs a 媒体库 tab"
assert 'id="setpanel-library"' in index, "系统设置 needs a 媒体库 panel"
assert 'id="homeLibBody"' in settings_block, \
    "the library table (path management) must live inside the 媒体库 tab"
assert 'id="libKinds"' in settings_block, \
    "the category cards must live inside the 媒体库 tab only"
assert 'onclick="addHomeMediaLibrary()"' in settings_block, "add-library button must be in settings"
assert 'if (key === "library")' in state, "switching to the 媒体库 tab must refresh its data"
# The sidebar add-module button is gone; module settings moved into 外观主题.
assert 'add-board-btn' not in index and 'add-board-btn' not in css, \
    "the sidebar 添加模块 button must be removed"
assert 'onclick="openModuleModal()"' in index, "module settings must still be reachable"
assert 'setModuleOpen' in state, "the module settings entry needs translated copy"
# Every library row keeps rescrape / open / delete actions.
for act in ['rebuildOneLibrary(', 'openHomeLibrary(', 'deleteMediaLibrary(']:
    assert act in home, f"library rows must keep the {act} action"
# Writes are still session-guarded from the new entry point.
assert 'ensureSessionForWrite(t("writeAddLibrary"))' in home, \
    "adding a library must verify the session first"

# ---------------------------------------------------------------- 4. account avatar menu
header = index[index.index('<header class="topbar">'):index.index('</header>')]
assert 'id="accountMenu"' in header, "the top bar needs an account menu"
assert 'onclick="toggleAccountMenu()"' in header, "the avatar must open the menu"
for item in ["openAvatarSettings()", "openAccountMenuItem('settingsModal')",
             "openAccountMenuItem('aboutModal')", "logoutVaultHub()"]:
    assert item in header, f"the account menu must offer {item}"
assert "onclick=\"openModal('settingsModal')\"" not in header, \
    "the standalone settings gear must be gone from the top bar"
assert "onclick=\"openModal('aboutModal')\"" not in header, \
    "the standalone About button must be gone from the top bar"
# Avatar settings: text, colour, uploaded image, persisted locally.
assert 'id="avatarModal"' in index, "avatar settings dialog missing"
for fn in ["function openAvatarSettings(", "function saveAvatarSettings(",
           "function resetAvatarSettings(", "function uploadAvatarImage(",
           "function applyAvatarConfig(", "function loadAvatarConfig("]:
    assert fn in state, f"avatar settings needs {fn}"
assert 'LS_AVATAR = "vaulthub_avatar_v1"' in state, "the avatar must persist per browser"
assert "loadAvatarConfig();" in boot, "the saved avatar must be applied on boot"
assert '.account-menu' in css and '.avatar-shot' in css, "account menu/avatar need styling"
# Signing out must also close the new surfaces.
logout = state[state.index("async function logoutVaultHub()"):]
logout = logout[:logout.index("\n}") + 2]
assert "closeAccountMenu()" in logout and "closeModal('avatarModal')" in logout, \
    "sign-out must close the account menu and avatar dialog"
# Login state is visible in the menu itself.
assert 'id="accountState"' in header and "getElementById('accountState')" in state, \
    "the account menu must show the live session state"

# ---------------------------------------------------------------- 5. top bar / info only
assert 'class="topnav"' not in index, "the horizontal top nav must be removed"
assert 'topnav-item' not in html, "no top-nav items may remain anywhere in the frontend"
assert 'data-i18n="navHome">首页</span></div>' not in header, "no 首页 button in the top bar"
assert 'navLibrary' not in state, "the 资料库 label is obsolete and must be dropped"
assert 'id="tb-info"' in header or 'class="tb-info"' in header, \
    "the top bar right side must be an info area"
info = header[header.index('class="tb-info"'):]
assert '<button' not in info, "the top bar info area must contain no buttons"
for stat in ['id="topLibStat"', 'id="topScanStat"']:
    assert stat in info, f"the info area must show {stat}"
assert 'getElementById("topLibStat")' in home and 'getElementById("topScanStat")' in home, \
    "the info area must be populated with real library/scan data"
# Account block sits before the info area, i.e. on the left.
assert header.index('id="accountMenu"') < header.index('class="tb-info"'), \
    "the avatar/account menu must sit to the left of the info area"

# ---------------------------------------------------------------- 6. home click-to-play
assert 'onclick="openHomeMediaItem(' in home, \
    "home posters must route through openHomeMediaItem"
assert "async function openHomeMediaItem(" in home, "click-to-open handler missing"
assert "function waitForMediaViewer(" in home, \
    "the reader host only exists after switching views, so opening must wait for it"
assert "openHomeLibrary(group, libId);" in home, \
    "opening an item must first switch to that library's view"
assert "playAudioFile(libId, path)" in home, "audio items must go straight to the player"
assert "await openLocalMedia(group, libId, path)" in home, \
    "non-audio items must open the reader/video player"
assert 'onclick="openLocalMedia(' not in home, \
    "the old direct openLocalMedia() call from the home page must be gone"
assert "homeOpenFail" in state, "failures must report a translated message"

# ---------------------------------------------------------------- 7. local + external sources
assert 'data-libsrc="local"' in settings_block and 'data-libsrc="external"' in settings_block, \
    "媒体库增加 must offer both local and external sources"
assert "function setLibrarySource(" in media, "source switch handler missing"
assert 'EXTERNAL_SERVICES_KEY = "vaulthub_external_services_v1"' in media, \
    "external services must be persisted"
for fn in ["function addExternalMediaService(", "function removeExternalMediaService(",
           "function renderExternalServiceList(", "function openExternalService("]:
    assert fn in media, f"external service management needs {fn}"
assert 'id="extLibLan"' in settings_block and 'id="extLibProxy"' in settings_block, \
    "external services need LAN + proxy address fields"
# The per-view embedded server forms are gone from the media views.
for view in ['view-comic', 'view-movie', 'view-audio']:
    block = index[index.index(f'id="{view}"'):]
    block = block[:block.index('</section>')]
    assert 'data-lan-input' not in block, f"{view} must not embed server config any more"
    assert 'addr-box' not in block, f"{view} must not embed an address box any more"
    assert 'media-wide-host' in block, f"{view} must keep its content host"
assert 'function bindSwitches(' not in state, \
    "the embedded LAN/proxy switch wiring is obsolete"
assert 'updateAddr(' not in boot, "boot must not wire the removed address inputs"
# LAN/public switching still exists, now per stored service.
assert "function serviceAccessUrl(svc" in media, "LAN/proxy auto-switch must be preserved"
assert "isPrivateHostname(pageHostname)" in media, \
    "external browsers must fall back to the proxy domain"
# External services also show up in the flat sidebar list.
assert "externalServices.forEach" in home, "external services must appear in the sidebar"

# ------------------------------------------------- login race + reader scroll regressions
# A slow /api/system/runtime probe used to land after an explicit login and re-show the
# mask, so probes must be epoch-guarded.
assert "vaultHubAuthEpoch" in state, "auth probes must be epoch-guarded against stale results"
assert "if (epoch !== vaultHubAuthEpoch) return vaultHubAuthenticated;" in state, \
    "stale probe results must be discarded instead of overwriting the live state"
assert state.count("vaultHubAuthEpoch++") >= 2, "login and logout must both advance the epoch"
# Scrolling the reader into view must not be able to masquerade as a read failure.
assert "function scrollViewerIntoView(" in media, "reader scroll must be isolated"
# The only scrollIntoView call site is inside the helper's guarded line
# (`typeof ... === "function"` + the call itself, hence two textual hits on one line).
scroll_lines = [l for l in media.splitlines() if "scrollIntoView" in l]
assert len(scroll_lines) == 1 and "typeof overlay.scrollIntoView" in scroll_lines[0], \
    f"scrollIntoView must only be called from the guarded helper, found: {scroll_lines}"
reader = media[media.index('if (ext === "txt")'):]
reader = reader[:reader.index("} else {")]
assert reader.index("文本读取失败") < reader.index("scrollViewerIntoView(viewer)"), \
    "scrolling must happen after the try/catch, not inside it"

# ---------------------------------------------------------------- audio favourites/player intact
assert 'id="audioFavoriteButton"' in index, "the player keeps its favourite button"
assert 'onclick="setAudioView(\'favorites\')"' in media, "the 喜欢 tab must remain"
assert '.audio-player { position:fixed' in css and 'transform:translateX(-50%)' in css, \
    "the music player stays centred"

print("PASS: v0.7.0 build progress, sidebar dedupe, settings-hosted libraries, "
      "account avatar menu, info-only top bar, home click-to-play, unified library sources")
