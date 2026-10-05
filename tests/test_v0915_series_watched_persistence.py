#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
PUB = (ROOT / ".workflow/publish.yml").read_text(encoding="utf-8")

assert 'watched: !!meta.watched' in JS, "剧集聚合未保存首集持久化 watched 状态"
assert 'watched: show.watched' in JS, "剧集紧凑缓存未保存 watched 状态"
assert 'watched:show.watched' in JS, "剧集详情 hero 未接收持久化 watched 状态"
assert 'toggleMovieReadState' not in JS, "影视已读旧状态不应恢复"
assert 'v0.9.56' in HTML
assert 'docker.io/q807738511/vaulthub:latest' in COMPOSE
assert 'vaulthub:v' in COMPOSE  # v0.9.42 起 compose 不写当前版本号，只留固定版回滚示例
# v0.9.90：镜像主仓库迁到 Docker Hub，GHCR 摘要对齐那套逻辑随 sync 工作流一并作废，
# 改为约束新发布流水线必须推 Docker Hub、发行版必须带读回校验。
assert 'repository: docker.io' in PUB
assert 'scripts/ci-release.sh' in PUB
print('PASS: v0.9.56 series watched state follows persistent metadata')
