FROM golang:1.23-alpine AS go-build
WORKDIR /src/media
COPY media-go/go.mod media-go/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out-media-api .
WORKDIR /src/subtitle
COPY subtitle-api/go.mod subtitle-api/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out-subtitle-api .
WORKDIR /src/manager
COPY manager/go.mod manager/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out-vaulthub-manager .

FROM nvidia/cuda:12.4.1-base-ubuntu22.04
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

ENV NAS_IP=192.168.112.3 \
    DASHBOARD_ORIGIN=https://home.enged.top \
    WEB_ROOT=/srv \
    MEDIA_ROOT=/media \
    SUBTITLE_API_ADDR=127.0.0.1:9120 \
    SUBTITLE_SHOOTER_ENDPOINT= \
    SUBTITLE_ZIMUKU_BASE= \
    SUBTITLE_SUBHD_BASE= \
    ADMIN_TOKEN= \
    ADMIN_USERNAME=ADMIN \
    ADMIN_PASSWORD=ADMIN123 \
    TMDB_API_KEY= \
    TMDB_API_BASE=https://api.themoviedb.org/3 \
    TMDB_IMAGE_BASE=https://image.tmdb.org/t/p

EXPOSE 8088
WORKDIR /srv
ENTRYPOINT ["/usr/bin/vaulthub-manager"]
