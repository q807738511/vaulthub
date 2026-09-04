#!/usr/bin/env python3
from pathlib import Path

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()

assert 'function jsArg(value) { return JSON.stringify(String(value)); }' in html, "missing JS string literal encoder"
assert 'function jsAttrArg(value) { return esc(jsArg(value)); }' in html, "missing HTML-attribute-safe JS literal encoder"
assert "playAudioFile('${esc(lib.id)}','${esc(file.path)}')" not in html, "file audio play handler still uses HTML escaping as JS escaping"
assert "playAudioFile('${esc(lib.id)}','${esc(group.files[0].path)}')" not in html, "album audio play handler still uses HTML escaping as JS escaping"
assert "playAudioFile('${esc(lib.id)}','${esc(songs[0].path)}')" not in html, "artist audio play handler still uses HTML escaping as JS escaping"
assert "openAudioMetadata('${esc(file.path)}')" not in html, "manual metadata handler still uses HTML escaping as JS escaping"
assert 'onclick="playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(file.path)})"' in html or 'onclick="playAudioFile(${jsAttrArg(lib.id)},${jsAttrArg(path)})"' in html, "file view play handler does not use HTML-attribute-safe JS literals"
assert 'openAudioTracks(\'${esc(lib.id)}\',\'album\',${esc(JSON.stringify(album))})' in html, "album card track handler is not HTML-attribute-safe"
assert 'openAudioTracks(\'${esc(lib.id)}\',\'artist\',${esc(JSON.stringify(artist))})' in html, "artist card track handler is not HTML-attribute-safe"
assert 'onclick="openAudioMetadata(${jsAttrArg(file.path)})"' in html or 'onclick="openAudioMetadata(${jsAttrArg(path)})"' in html, "manual metadata handler does not use HTML-attribute-safe JS literals"

print("PASS: audio inline handlers use HTML-attribute-safe JS string escaping")
