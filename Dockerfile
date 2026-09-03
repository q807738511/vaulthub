# syntax=docker/dockerfile:1

# Base images are build args so air-gapped/China networks can point them at a
# mirror (e.g. docker.m.daocloud.io/library/...) without editing this file.
ARG GO_IMAGE=golang:1.23-alpine
ARG RUNTIME_IMAGE=debian:trixie-slim
# GOPROXY lets the Go build fetch modernc.org/sqlite where proxy.golang.org is
# blocked. CI leaves it at the default; local NAS builds pass goproxy.cn.
ARG GOPROXY=https://proxy.golang.org,direct

FROM ${GO_IMAGE} AS go-build
ARG GOPROXY
ENV GOPROXY=${GOPROXY} GOFLAGS=-mod=mod CGO_ENABLED=0 GOOS=linux GOARCH=amd64
WORKDIR /src/media
# Copy module metadata first for layer caching, then download deps.
COPY media-go/go.mod media-go/go.sum ./
RUN go mod download
COPY media-go/*.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out-media-api .
WORKDIR /src/subtitle
COPY subtitle-api/go.mod ./
COPY subtitle-api/main.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out-subtitle-api .
WORKDIR /src/manager
COPY manager/go.mod ./
COPY manager/main.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out-vaulthub-manager .

# Runtime: Debian trixie matches the Feiniu/Debian NAS host and ships ffmpeg 7.x
# with NVENC/VAAPI/QSV encoders that dlopen the vendor libraries at runtime, so
# hardware transcoding still works once nvidia-container-toolkit injects them —
# no CUDA base image needed on GPU-less hosts.
FROM ${RUNTIME_IMAGE}
# v0.9.50：apt 源参数化 —— 海外 CI（GitHub Actions）默认用官方源；
# 中国大陆构建传 --build-arg APT_MIRROR=http://mirrors.aliyun.com/debian 提速。
RUN if [ -n "${APT_MIRROR:-}" ]; then \
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list; \
    fi \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY caddy /usr/bin/caddy
COPY --from=go-build /out-media-api /usr/bin/media-api
COPY --from=go-build /out-subtitle-api /usr/bin/subtitle-api
COPY --from=go-build /out-vaulthub-manager /usr/bin/vaulthub-manager
RUN chmod 755 /usr/bin/caddy /usr/bin/vaulthub-manager /usr/bin/media-api /usr/bin/subtitle-api
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY web /srv/web

# v0.9.50：以下默认值与 vaulthub.env 模板逐键对齐。env 文件变为可选覆盖层，
# 缺失/过期时容器仍按这些内置默认值运行；需要覆盖时再放本地 vaulthub.env/.env。
ENV NAS_IP=192.0.2.10 \
    DASHBOARD_ORIGIN=https://home.example.com \
    WEB_ROOT=/srv \
    MEDIA_ROOT=/media \
    SUBTITLE_API_ADDR=127.0.0.1:9120 \
    SUBTITLE_SHOOTER_ENDPOINT= \
    SUBTITLE_ZIMUKU_BASE= \
    SUBTITLE_SUBHD_BASE= \
    ADMIN_USERNAME=ADMIN \
    ADMIN_PASSWORD=ADMIN123 \
    TMDB_API_KEY= \
    TMDB_API_BASE=https://api.themoviedb.org/3 \
    TMDB_IMAGE_BASE=https://image.tmdb.org/t/p \
    TVDB_API_KEY= \
    TVDB_API_BASE=https://api4.thetvdb.com/v4 \
    SCRAPER_PROXY= \
    TZ=Asia/Shanghai \
    SYSTEM_MONITOR_ENABLED=true \
    SYSTEM_MONITOR_PROC_ROOT=/host/proc \
    SYSTEM_MONITOR_SYS_ROOT=/host/sys \
    SYSTEM_MONITOR_INTERVAL=3 \
    SYSTEM_MONITOR_INTERFACE= \
    MEDIA_RUNTIME_CONFIG=/data/media-runtime.json \
    MEDIA_READING_PROGRESS=/data/media-reading-progress.json \
    MEDIA_SCAN_MAX_DEPTH=32 \
    MEDIA_CACHE_MAX_BYTES=30737418240 \
    MEDIA_CACHE_MAX_AGE_HOURS=168 \
    MEDIA_CACHE_CLEANUP_INTERVAL_HOURS=24 \
    FFMPEG_HWACCEL=auto \
    VAAPI_DEVICE=/dev/dri/renderD128 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

EXPOSE 8088
WORKDIR /srv
ENTRYPOINT ["/usr/bin/vaulthub-manager"]
