from pathlib import Path

root = Path(__file__).resolve().parents[1]
html = (root / "index.html").read_text(encoding="utf-8")
go = (root / "subtitle-api" / "main.go").read_text(encoding="utf-8")
dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
caddy = (root / "Caddyfile").read_text(encoding="utf-8")
checks = {
    "Go subtitle service": "subtitle-api/main.go" in dockerfile and "start_subtitle_api" in (root / "vaulthub-manager.c").read_text(),
    "single container build": "FROM golang:1.23-alpine AS go-build" in dockerfile and "COPY --from=go-build" in dockerfile,
    "local subtitle scan": "localProvider" in go and ".srt" in go and ".vtt" in go,
    "provider adapters": "shooter" in go and "zimuku" in go and "subhd" in go and "https://www.shooter.cn/api/subapi.php" in go,
    "safe relative path": "path outside media root" in go and "filepath.Rel" in go,
    "player subtitle menu": "video-subtitle-menu" in html and "searchVideoSubtitles" in html,
    "subtitle route": "127.0.0.1:9120" in caddy and "/api/media/subtitles/search" in caddy,
}
failed = [k for k,v in checks.items() if not v]
assert not failed, "missing: " + ", ".join(failed)
print("PASS: Go subtitle service, local scan, provider adapters, and single-container routing markers are present")
