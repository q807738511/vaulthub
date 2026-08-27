#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
dockerfile = (ROOT / "Dockerfile").read_text()
source = (ROOT / "tests" / "fixtures" / "media-api_legacy.c").read_text()

# The runtime FFmpeg must actually contain NVENC; Alpine's generic ffmpeg does not.
assert "nvidia/cuda:12.4.1-base-ubuntu22.04" in dockerfile
assert "apt-get install" in dockerfile and "ffmpeg" in dockerfile
assert "ffmpeg -hide_banner -encoders" in source
assert "h264_nvenc" in source

# CUDA mode must degrade to CPU decode + NVENC before full CPU encoding.
assert "-c:v h264_nvenc" in source
assert "-hwaccel_output_format cuda" not in source
assert "compat playback unavailable" in source
print("PASS: NVIDIA FFmpeg runtime and safe NVENC fallback markers are present")
