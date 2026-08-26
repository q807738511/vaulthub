FROM alpine:3.22 AS build
RUN apk add --no-cache build-base linux-headers
WORKDIR /src
COPY media-api.c vaulthub-manager.c /src/
RUN gcc -Os -static -s -Wall -Wextra -Werror -pthread media-api.c -o /out-media-api \
 && gcc -Os -static -s -Wall -Wextra -Werror -pthread vaulthub-manager.c -o /out-vaulthub-manager

FROM golang:1.23-alpine AS go-build
WORKDIR /src
COPY subtitle-api/go.mod subtitle-api/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out-subtitle-api .

FROM nvidia/cuda:12.4.1-base-ubuntu22.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 caddy /usr/bin/caddy
COPY --from=build --chmod=755 /out-vaulthub-manager /usr/bin/vaulthub-manager
COPY --from=build --chmod=755 /out-media-api /usr/bin/media-api
COPY --from=go-build --chmod=755 /out-subtitle-api /usr/bin/subtitle-api
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html

ENV NAS_IP=192.168.112.3 \
    DASHBOARD_ORIGIN=https://home.enged.top \
    WEB_ROOT=/srv \
    MEDIA_ROOT=/media \
    SUBTITLE_API_ADDR=127.0.0.1:9120 \
    SUBTITLE_SHOOTER_ENDPOINT= \
    SUBTITLE_ZIMUKU_ENDPOINT= \
    SUBTITLE_SUBHD_ENDPOINT= \
    ADMIN_TOKEN= \
    TMDB_API_KEY=

EXPOSE 8088
WORKDIR /srv
ENTRYPOINT ["/usr/bin/vaulthub-manager"]
