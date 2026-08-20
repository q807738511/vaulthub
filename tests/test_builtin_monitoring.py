#!/usr/bin/env python3
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
source = (ROOT / "media-api.c").read_text()
html = (ROOT / "index.html").read_text()
compose = (ROOT / "docker-compose.yml").read_text()

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
    'SYSTEM_MONITOR_ENABLED:',
    'SYSTEM_MONITOR_INTERFACE:',
    'SYSTEM_MONITOR_FILESYSTEMS:',
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
assert 'FROM alpine' in dockerfile and 'gcc' in dockerfile and 'media-api.c' in dockerfile, "Dockerfile does not compile media API from source"
dockerignore = (ROOT / ".dockerignore").read_text()
assert 'vaulthub-manager.c' not in dockerignore, "Docker build context excludes manager source"

for forbidden in [
    '/api/4/cpu', '/api/4/mem', '/api/4/network', '/api/4/fs', '/api/4/sensors',
    'id="glancesUrl"', 'saveGlances()', 'settings.glancesUrl',
    'data-i18n="mpHint"',
]:
    assert forbidden not in html, f"legacy UI/API reference remains: {forbidden}"

print("PASS: built-in environment-configured monitoring replaces Glances UI calls")
