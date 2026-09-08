#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "tests" / "fixtures" / "media-api_legacy.c").read_text()
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from _frontend import frontend_source as _fs
html = _fs()
# v0.8.7：硬件能力声明搬到 vaulthub.env，按两个文件合起来校验。
compose = (ROOT / "docker-compose.yml").read_text() + "\n" + (ROOT / "vaulthub.env").read_text()
dockerfile = (ROOT / "Dockerfile").read_text()

# Backend must expose status and accept a safe, explicit accelerator per request.
for marker in [
    '"/api/media/hardware"',
    'hardware_accel_config',
    'X-VaultHub-Hardware:',
    '"auto"', '"vaapi"', '"qsv"', '"cuda"',
    'VAAPI_DEVICE',
]:
    assert marker in source, f"missing GPU backend marker: {marker}"
assert 'hw=' in html and 'settings.hardwareAcceleration' in html
assert 'id="hardwareAcceleration"' in html
assert 'id="hardwareStatus"' in html
assert 'saveHardwareAcceleration()' in html

# Container setup must make both Intel/AMD render devices and NVIDIA runtime discoverable.
for marker in [
    'FFMPEG_HWACCEL=',
    'VAAPI_DEVICE=',
    'NVIDIA_VISIBLE_DEVICES=',
    'NVIDIA_DRIVER_CAPABILITIES=',
]:
    assert marker in compose, f"missing Docker GPU configuration: {marker}"
assert ('libva' in dockerfile and 'mesa-va-gallium' in dockerfile) or 'nvidia/cuda:' in dockerfile or ('debian:trixie-slim' in dockerfile and 'ffmpeg' in dockerfile)
assert 'driver: nvidia' in compose and 'capabilities:' in compose

# Long TXT files must be read through complete bounded ranges, not a single first-screen fetch.
for marker in [
    'fetchCompleteTextFile',
    'Range: `bytes=${offset}-${end}`',
    'Content-Range',
    'TXT_CHUNK_BYTES',
]:
    assert marker in html, f"missing complete TXT reader marker: {marker}"
assert 'fetch(url, { cache: "no-store" })' not in html, "TXT reader still uses one unbounded fetch"

# The reader must inherit the whole active app theme instead of fixed paper colors.
for marker in [
    'reader-theme-dark',
    'reader-theme-light',
    'reader-theme-custom',
    'readerThemeClass()',
]:
    assert marker in html, f"missing synchronized reader theme marker: {marker}"
assert 'color:#30281f; background:#f4ecd8' not in html

print("PASS: GPU acceleration settings and complete theme-synchronized TXT reading are present")
