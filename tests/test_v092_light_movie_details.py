from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "web/css/main.css").read_text(encoding="utf-8")
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

assert 'function movieHeroArt(meta)' in JS
assert 'poster-art' in JS and 'backdrop-art' in JS and 'no-art' in JS
assert '.movie-detail-hero.no-art' in CSS and 'color:var(--text)' in CSS
assert '.movie-detail-hero.no-art p' in CSS and 'color:var(--text2)' in CSS
assert '.movie-detail-hero.has-art' in CSS and 'color:#fff' in CSS
assert '.movie-detail-hero.has-art p' in CSS and 'rgba(255,255,255' in CSS
assert '.movie-detail-strip article small' in CSS and 'color:var(--text2)' in CSS
assert 'id="topLibStat"' not in HTML and 'id="homeCount"' not in HTML
assert '<section class="view settings-view" id="view-settings">' in HTML
assert 'v0.9.53' in HTML
assert 'ghcr.io/q807738511/vaulthub:latest' in COMPOSE
print('PASS: v0.9.53 light movie details and prior UI fixes')
