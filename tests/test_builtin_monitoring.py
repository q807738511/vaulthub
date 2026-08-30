#!/usr/bin/env python3
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
source = (ROOT / "tests" / "fixtures" / "media-api_legacy.c").read_text()
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
# v0.8.7：固定环境变量搬到 VaultHub.env，compose 只留常用项。
# 部署配置按「两个文件合起来」校验，写法统一为 KEY=value。
compose = (ROOT / "docker-compose.yml").read_text() + "\n" + (ROOT / "VaultHub.env").read_text()

required_source = [
    '"/api/system/metrics"',
    'SYSTEM_MONITOR_ENABLED',
    'SYSTEM_MONITOR_PROC_ROOT',
    'SYSTEM_MONITOR_SYS_ROOT',
    'SYSTEM_MONITOR_INTERFACE',
    'SYSTEM_MONITOR_FILESYSTEMS',
]
required_html = [
    'fetchJson("/api/system/metrics")',
    '内置监控',
]
dockerfile = (ROOT / "Dockerfile").read_text()
manager = (ROOT / "vaulthub-manager.c").read_text()
caddyfile = (ROOT / "Caddyfile").read_text()

required_compose = [
    'SYSTEM_MONITOR_ENABLED=',
    'SYSTEM_MONITOR_INTERFACE=',
    'SYSTEM_MONITOR_FILESYSTEMS=',
    '/proc:/host/proc:ro',
    '/sys:/host/sys:ro',
]
for item in required_source:
    assert item in source, f"missing backend monitoring support: {item}"
for item in required_html:
    assert item in html, f"missing frontend monitoring support: {item}"
for item in required_compose:
    assert item in compose, f"missing compose monitoring example: {item}"
assert 'handle /api/system/*' in caddyfile, "default Caddyfile misses system route"
assert 'handle /api/system/*' in manager, "persisted Caddyfile migration misses system route"
assert ('AS go-build' in dockerfile and 'GO_IMAGE=golang:1.23-alpine' in dockerfile) and 'media-go/main.go' in dockerfile and 'out-media-api' in dockerfile, "Dockerfile does not compile Go media API"
dockerignore = (ROOT / ".dockerignore").read_text()
assert 'vaulthub-manager.c' not in dockerignore, "Docker build context excludes manager source"

for forbidden in [
    '/api/4/cpu', '/api/4/mem', '/api/4/network', '/api/4/fs', '/api/4/sensors',
    'id="glancesUrl"', 'saveGlances()', 'settings.glancesUrl',
    'data-i18n="mpHint"',
]:
    assert forbidden not in html, f"legacy UI/API reference remains: {forbidden}"

print("PASS: built-in environment-configured monitoring replaces Glances UI calls")
