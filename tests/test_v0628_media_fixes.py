#!/usr/bin/env python3
"""阶段 2 修复回归契约：媒体写接口鉴权、ZIP 名称解码、TMDB 环境变量、
音乐视频播放判定、Caddyfile 迁移幂等。"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
media_go = (ROOT / "media-go" / "main.go").read_text()
manager = (ROOT / "manager" / "main.go").read_text()
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
# v0.8.7：部署配置拆成 docker-compose.yml（常用项）+ vaulthub.env（固定项），
# 按两个文件合起来校验。
compose = (ROOT / "docker-compose.yml").read_text() + "\n" + (ROOT / "vaulthub.env").read_text()

# 1. 媒体库写接口必须经过会话鉴权，且 ADMIN_TOKEN 为空时不得放行。
assert "func writeAuth(" in media_go
assert "func managerSessionOK(" in media_go
assert "if !writeAuth(r) {" in media_go
assert "if !auth(r) {" not in media_go, "写接口不能再使用 fail-open 的 auth()"
assert '"/api/session/check"' in media_go
assert "m.sessionCheck" in manager
assert "ip.IsLoopback()" in manager, "session/check 必须限制为回环调用"

# 2. ZIP 条目名解码、图片过滤和自然排序。
assert "func decodeZipNames(" in media_go
assert "utf8.ValidString" in media_go
assert "SHIFT-JIS" in media_go and '"GBK"' in media_go
assert "func imageEntry(" in media_go
assert "func naturalLess(" in media_go
assert 'Raw  string `json:"raw"`' in media_go
assert "entry.raw || entry.name" in html, "前端必须用原始 ZIP 名请求条目"

# 3. TMDB 密钥必须来自容器环境变量，不能被硬编码空值覆盖。
# v0.8.7 统一 KEY=value 写法；密钥仍必须来自环境变量而不是硬编码空值。
assert 'TMDB_API_KEY=${TMDB_API_KEY:-}' in compose
assert 'TMDB_API_KEY=""' not in compose
assert "tmdb_image_base" in media_go and "tmdb_image_base" in html

# 4. 剧集与电影分别刮削，TMDB 优先、豆瓣兜底。
assert 'endpoint = "search/tv"' in media_go
assert '"search/movie"' in media_go
assert 'lib?.type === "series" ? "series" : "movie"' in html
assert "TMDB · 剧集" in html and "TMDB · 电影" in html

# 5. 音乐视频库按视频扩展名判定可播放。
assert 'lib?.type === "musicvideo" ? MEDIA_FORMATS.movie : MEDIA_FORMATS.audio' in html

# 6. Caddyfile 迁移必须幂等，避免重复 handle 块导致的配置膨胀。
assert "var managerRoutes = []string{" in manager
assert "only genuinely missing manager routes are inserted" in manager
assert 'strings.Contains(s, x+" {")' in manager

print("PASS: media write auth, zip decoding, TMDB env, series scraping and idempotent Caddy migration")
