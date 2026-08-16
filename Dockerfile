# syntax=docker/dockerfile:1

FROM scratch

COPY --chmod=755 caddy /usr/bin/caddy
COPY --chmod=755 vaulthub-manager /usr/bin/vaulthub-manager
COPY --chmod=755 media-api /usr/bin/media-api
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html

ENV NAS_IP=192.168.112.3 \
    DASHBOARD_ORIGIN=https://home.enged.top \
    WEB_ROOT=/srv \
    XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data

EXPOSE 8088
WORKDIR /srv
ENTRYPOINT ["/usr/bin/vaulthub-manager"]
