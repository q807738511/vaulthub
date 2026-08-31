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
RUN apt-get update \
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

ENV NAS_IP=192.168.112.3 \
    DASHBOARD_ORIGIN=https://home.enged.top \
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
    SCRAPER_PROXY=

EXPOSE 8088
WORKDIR /srv
ENTRYPOINT ["/usr/bin/vaulthub-manager"]
