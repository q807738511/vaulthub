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
assert 'v0.9.56' in HTML
# v0.9.90：镜像主仓库迁到 Docker Hub
assert 'docker.io/q807738511/vaulthub:latest' in COMPOSE
import re as _re
assert _re.search(r'vaulthub:v0\.9\.\d+', COMPOSE)  # v0.9.42 起 compose 不写当前版本号，只留固定版回滚注释（版本号随发布推进，故只断言存在一个固定版引用）
# v0.9.30：两端摘要统一按 registry HEAD + OCI Accept 读取。
assert 'docker-content-digest' in SYNC.lower()
assert 'skopeo copy --all --preserve-digests' in SYNC
print('PASS: v0.9.56 series watched state follows persistent metadata')
