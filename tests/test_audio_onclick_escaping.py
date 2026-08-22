#!/usr/bin/env python3
from pathlib import Path

html = (Path(__file__).resolve().parents[1] / "index.html").read_text()

assert 'function jsArg(value) { return JSON.stringify(String(value)); }' in html, "missing JS string literal encoder for inline handlers"
assert "playAudioFile('${esc(lib.id)}','${esc(file.path)}')" not in html, "file audio play handler still uses HTML escaping as JS escaping"
assert "playAudioFile('${esc(lib.id)}','${esc(group.files[0].path)}')" not in html, "album audio play handler still uses HTML escaping as JS escaping"
assert "playAudioFile('${esc(lib.id)}','${esc(songs[0].path)}')" not in html, "artist audio play handler still uses HTML escaping as JS escaping"
assert "openAudioMetadata('${esc(file.path)}')" not in html, "manual metadata handler still uses HTML escaping as JS escaping"
assert 'onclick="playAudioFile(${jsArg(lib.id)},${jsArg(file.path)})"' in html, "file view play handler does not use safe JS literals"
assert 'onclick="playAudioFile(${jsArg(lib.id)},${jsArg(group.files[0].path)})"' in html, "album card play handler does not use safe JS literals"
assert 'onclick="playAudioFile(${jsArg(lib.id)},${jsArg(songs[0].path)})"' in html, "artist card play handler does not use safe JS literals"
assert 'onclick="openAudioMetadata(${jsArg(file.path)})"' in html, "manual metadata handler does not use safe JS literals"

print("PASS: audio inline handlers use JS-string escaping for apostrophes and special characters")
