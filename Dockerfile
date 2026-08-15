FROM scratch

COPY caddy /usr/bin/caddy
COPY vaulthub-manager /usr/bin/vaulthub-manager
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
