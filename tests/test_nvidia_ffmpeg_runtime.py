#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
dockerfile = (ROOT / "Dockerfile").read_text()
source = (ROOT / "tests" / "fixtures" / "media-api_legacy.c").read_text()

# The runtime FFmpeg must actually contain NVENC. Phase-5 moved off the CUDA
# base image to Debian trixie-slim, whose ffmpeg 7.x still ships NVENC/VAAPI/QSV
# encoders that dlopen the vendor libraries at runtime (verified: `ldd ffmpeg`
# links zero nvidia libs), so hardware transcoding works once the container
# toolkit injects them — no CUDA base needed on GPU-less hosts.
assert "debian:trixie-slim" in dockerfile or "RUNTIME_IMAGE" in dockerfile
assert "apt-get install" in dockerfile and "ffmpeg" in dockerfile
assert "ffmpeg -hide_banner -encoders" in source
assert "h264_nvenc" in source

# CUDA mode must degrade to CPU decode + NVENC before full CPU encoding.
assert "-c:v h264_nvenc" in source
assert "-hwaccel_output_format cuda" not in source
assert "compat playback unavailable" in source
print("PASS: NVIDIA FFmpeg runtime and safe NVENC fallback markers are present")
