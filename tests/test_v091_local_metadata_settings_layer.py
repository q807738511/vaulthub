from pathlib import Path
root=Path(__file__).resolve().parents[1]
go=(root/'media-go/local_metadata.go').read_text()
main=(root/'media-go/main.go').read_text()
js=(root/'web/js/02-media.js').read_text()
css=(root/'web/css/main.css').read_text()
html=(root/'index.html').read_text()
for marker in ['stem + ".nfo"','"movie.nfo"','poster.png','fanart.jpg','.srt','localMediaMetadata','safeFile(lib, mediaPath)','commonAllowed']:
    assert marker in go, marker
assert '"tvshow.nfo"' not in go and '"episode.nfo"' not in go
assert '"/api/media/metadata"' in main
assert 'a.externalSubtitle' in main
assert '/api/media/metadata?id=${encodeURIComponent(lib.id)}' in js
assert 'meta?.subtitles?.length' in js
assert '#settingsModal {' in css and 'z-index:1300' in css
assert '#settingsModal::backdrop' in css
assert '<dialog class="modal-mask" id="settingsModal">' in html
assert '.auth-mask { position:fixed; inset:0; z-index:2000;' in css
assert 'v0.9.11' in html
print('PASS: v0.9.11 local NFO/artwork/subtitle and top settings contracts')
