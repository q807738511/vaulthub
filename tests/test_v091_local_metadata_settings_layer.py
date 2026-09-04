from pathlib import Path
root=Path(__file__).resolve().parents[1]
go=(root/'media-go/local_metadata.go').read_text()
main=(root/'media-go/main.go').read_text()
js=(root/'web/js/02-media.js').read_text()
css=(root/'web/css/main.css').read_text()
html=(root/'index.html').read_text()
for marker in ['stem + ".nfo"','"movie.nfo"','poster.png','fanart.jpg','.srt','localMediaMetadata','safeFile(lib, mediaPath)','commonAllowed']:
    assert marker in go, marker
# v0.9.53 T4：series 库单集元数据必须能读取剧集根目录的 tvshow.nfo 与海报
# （向上回溯 Show 根），因此 tvshow.nfo 现在是 series 分支的合法候选。
assert 'tvshow.nfo' in go
assert 'seriesShowDirs' in go and 'showPosterNames' in go
assert '"episode.nfo"' not in go
assert '"/api/media/metadata"' in main
assert 'a.externalSubtitle' in main
assert '/api/media/metadata?id=${encodeURIComponent(lib.id)}' in js
assert 'meta?.subtitles?.length' in js
# v0.9.30：系统设置改为独立配置页 #view-settings（不再是 dialog 顶层弹窗）。
assert '.settings-view .setpanel' in css
assert '#settingsModal' not in css
assert '<section class="view settings-view" id="view-settings">' in html
assert '<dialog' not in html
assert '.auth-mask { position:fixed; inset:0; z-index:2000;' in css
assert 'v0.9.53' in html
print('PASS: v0.9.53 local NFO/artwork/subtitle and top settings contracts')
