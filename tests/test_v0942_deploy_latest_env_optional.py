#!/usr/bin/env python3
"""VaultHub v0.9.54 deployment contracts: latest-follow + optional env file.

Asserts against the real repo files:
  * docker-compose.yml tracks the mutable GHCR `latest` tag (release-time
    alias of the pinned version tag) with pull_policy: always;
  * compose loads vaulthub.env via `path` + `required: false`, so a missing
    env file can no longer abort `docker compose up`;
  * publish-image.yml moves GHCR `latest` ONLY on version-tag pushes
    (refs/tags/), never on plain main commits;
  * Dockerfile ENV bakes defaults aligned with the vaulthub.env template
    (spot keys incl. TZ / MEDIA_SCAN_MAX_DEPTH / VAAPI_DEVICE / cache bytes),
    so the image runs with sane values even with no env file;
  * the v0.9.54 release notes exist and frontend/JS carry version 0.9.54.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
env_tpl = (ROOT / "vaulthub.env").read_text(encoding="utf-8")
dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
wf = (ROOT / ".github/workflows/publish-image.yml").read_text(encoding="utf-8")
index = (ROOT / "index.html").read_text(encoding="utf-8")
state = (ROOT / "web/js/01-state.js").read_text(encoding="utf-8")
release = (ROOT / ".github/RELEASE_NOTES_0.9.54.md").read_text(encoding="utf-8")


def test_compose_tracks_ghcr_latest():
    assert "image: ghcr.io/q807738511/vaulthub:latest" in compose
    assert "pull_policy: always" in compose


def test_compose_env_file_optional():
    assert "env_file:" in compose
    assert "path: ./vaulthub.env" in compose
    assert "required: false" in compose
    # 不再出现旧的列表式 env_file（文件缺失会拒绝启动的写法）
    assert "    env_file:\n      - ./vaulthub.env\n" not in compose


def test_ci_moves_latest_only_on_tags():
    # latest 只跟随 refs/tags/ 推送
    assert "value=latest,enable=${{ startsWith(github.ref, 'refs/tags/') }}" in wf
    # 普通 main 提交不再驱动 latest
    assert "enable={{is_default_branch}}" not in wf


def test_dockerfile_bakes_template_defaults():
    # 与 vaulthub.env 模板逐键对齐的抽查键
    for keyval in [
        "TZ=Asia/Shanghai",
        "MEDIA_SCAN_MAX_DEPTH=32",
        "VAAPI_DEVICE=/dev/dri/renderD128",
        "MEDIA_CACHE_MAX_BYTES=30737418240",
        "MEDIA_CACHE_MAX_AGE_HOURS=168",
        "MEDIA_CACHE_CLEANUP_INTERVAL_HOURS=24",
        "FFMPEG_HWACCEL=auto",
        "MEDIA_RUNTIME_CONFIG=/data/media-runtime.json",
        "MEDIA_READING_PROGRESS=/data/media-reading-progress.json",
        "NVIDIA_VISIBLE_DEVICES=all",
        "NVIDIA_DRIVER_CAPABILITIES=compute,video,utility",
        "SYSTEM_MONITOR_PROC_ROOT=/host/proc",
        "SYSTEM_MONITOR_SYS_ROOT=/host/sys",
    ]:
        assert keyval in dockerfile, f"Dockerfile ENV missing template default: {keyval}"
    # 模板全部键都能在镜像侧找到默认（Dockerfile ENV 或 compose environment）
    env_block = dockerfile.split("ENV NAS_IP=", 1)[1].split("\n", 1)[0]
    keys = [l.split("=", 1)[0] for l in env_tpl.splitlines()
            if l and not l.startswith("#") and "=" in l]
    assert keys, "vaulthub.env template parsed empty"
    for k in keys:
        present = (k + "=") in dockerfile or (k + "=") in compose
        assert present, f"no image/compose default for template key: {k}"


def test_version_strings():
    assert "0.9.54" in index
    assert 'VAULTHUB_SCRIPT_VERSION = "0.9.54"' in state
    assert "VaultHub v0.9.54" in release


if __name__ == "__main__":
    ran = 0
    for name in sorted(globals()):
        if name.startswith("test_"):
            globals()[name]()
            print(f"PASS {name}")
            ran += 1
    print(f"ALL_V0942_PASS ({ran} checks)")
