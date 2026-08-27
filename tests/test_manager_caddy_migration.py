#!/usr/bin/env python3
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
manager = (ROOT / "manager" / "main.go").read_text()
compose = (ROOT / "docker-compose.yml").read_text()

for route in [
    "/api/health",
    "/api/login",
    "/api/system/runtime",
    "/api/admin/*",
]:
    multiline = (
        f'handle {route} {{\\n'
        '\\t\\treverse_proxy http://127.0.0.1:9099\\n'
        '\\t}'
    )
    assert multiline in manager, f"Caddy migration route is not a multiline block: {route}"
    assert f'handle {route} {{ reverse_proxy' not in manager, (
        f"invalid single-line Caddy migration route remains: {route}"
    )

assert 'CombinedOutput()' in manager, "Caddy validation errors are not captured"
assert 'restart: "on-failure:1"' in compose, "Compose can still restart forever"
assert '/vol3/1000/komga/漫画/mh:/mh:ro' in compose, "comic bind mount has no target"

print("PASS: Caddy migration emits valid multiline routes and restart retries once")
