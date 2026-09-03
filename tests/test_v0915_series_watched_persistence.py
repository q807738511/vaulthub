#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
SYNC = (ROOT / ".github/workflows/sync-dockerhub-to-ghcr.yml").read_text(encoding="utf-8")

assert 'watched: !!meta.watched' in JS, "剧集聚合未保存首集持久化 watched 状态"
assert 'watched: show.watched' in JS, "剧集紧凑缓存未保存 watched 状态"
assert 'watched:show.watched' in JS, "剧集详情 hero 未接收持久化 watched 状态"
assert 'toggleMovieReadState' not in JS, "影视已读旧状态不应恢复"
assert 'v0.9.40' in HTML
assert 'ghcr.io/q807738511/vaulthub:v0.9.40' in COMPOSE
assert 'v0.9.40' in COMPOSE
# v0.9.30：两端摘要统一按 registry HEAD + OCI Accept 读取。
assert 'docker-content-digest' in SYNC.lower()
assert 'skopeo copy --all --preserve-digests' in SYNC
print('PASS: v0.9.40 series watched state follows persistent metadata')
