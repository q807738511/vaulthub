FROM alpine:3.22 AS build
RUN apk add --no-cache build-base linux-headers
WORKDIR /src
COPY media-api.c vaulthub-manager.c /src/
RUN gcc -Os -static -s -Wall -Wextra -Werror -pthread media-api.c -o /out-media-api \
 && gcc -Os -static -s -Wall -Wextra -Werror -pthread vaulthub-manager.c -o /out-vaulthub-manager

FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl ffmpeg
COPY --chmod=755 caddy /usr/bin/caddy
COPY --from=build --chmod=755 /out-vaulthub-manager /usr/bin/vaulthub-manager
COPY --from=build --chmod=755 /out-media-api /usr/bin/media-api
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html

ENV NAS_IP=192.168.112.3 \
    DASHBOARD_ORIGIN=https://home.enged.top \
    WEB_ROOT=/srv \
    ADMIN_TOKEN= \
    TMDB_API_KEY=

EXPOSE 8088
WORKDIR /srv
ENTRYPOINT ["/usr/bin/vaulthub-manager"]
