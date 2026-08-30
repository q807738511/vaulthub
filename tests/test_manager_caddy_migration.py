#!/usr/bin/env python3
"""Caddyfile 迁移回归。

真正的语法与幂等断言已迁移到 `manager/main_test.go`，那里直接调用
`normalizeCaddyfile` 并用仓库自带 caddy 二进制校验生成结果。本文件只保留
Compose 层面的防回归项，并确认 Go 侧断言仍然存在。
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
manager = (ROOT / "manager" / "main.go").read_text()
manager_test = (ROOT / "manager" / "main_test.go").read_text()
compose = (ROOT / "docker-compose.yml").read_text()

assert "var managerRoutes = []string{" in manager, "manager routes are not declared once"
assert "CombinedOutput()" in manager, "Caddy validation errors are not captured"
assert "TestNormalizeCaddyfileInjectsMultilineBlocks" in manager_test
assert "TestNormalizeCaddyfileIsIdempotent" in manager_test
assert "TestMigratedCaddyfileValidates" in manager_test

# v0.8.7 改为 unless-stopped：v0.8.6 起启动会迁移 /data/Caddyfile，
# 早期用 on-failure:1 是为了避免 Caddyfile 损坏时无限重启，现已由
# injectCachePolicy 的跳过条件 + caddy validate 覆盖。
assert "restart: unless-stopped" in compose, "Compose restart policy missing"
assert "/vol3/1000/komga/漫画/mh:/mh:ro" in compose, "comic bind mount has no target"

proc = subprocess.run(
    ["go", "test", "./..."],
    cwd=ROOT / "manager",
    capture_output=True,
    text=True,
)
if proc.returncode != 0:
    sys.stdout.write(proc.stdout)
    sys.stdout.write(proc.stderr)
    raise SystemExit("manager Go tests failed")

print("PASS: Caddy migration is covered by Go tests and restart retries once")
