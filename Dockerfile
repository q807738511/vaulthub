# syntax=docker/dockerfile:1

# 基础镜像写成构建参数，便于断网/国内网络指向镜像站。
# v0.9.89：默认值改为国内镜像 —— Gitee Go（personal 版）的 build@docker
#   插件字段只有 repository/username/password/tag/dockerfile/artifacts/isCache，
#   没有「构建参数」项，无法从流水线传 --build-arg；海外/自定义构建仍可
#   用 --build-arg 覆盖回来。
ARG GO_IMAGE=docker.m.daocloud.io/library/golang:1.23-alpine
ARG RUNTIME_IMAGE=docker.m.daocloud.io/library/debian:trixie-slim
# GOPROXY：proxy.golang.org 在中国大陆不可达，默认走 goproxy.cn。
ARG GOPROXY=https://goproxy.cn,direct

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
# v0.9.95：这里原先只 COPY main.go —— 新增 .go 文件（例如本版的一次性初始密码
# 模块）会漏拷，镜像构建直接 undefined 失败。改成 *.go（与 media-go 一致），
# 以后加文件不用再记得改 Dockerfile。*_test.go 只是被拷进构建阶段，不进二进制。
COPY subtitle-api/*.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out-subtitle-api .
WORKDIR /src/manager
COPY manager/go.mod ./
# v0.9.95：同上，改 *.go（本版新增 manager/v0995_initial_password.go）。
COPY manager/*.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out-vaulthub-manager .

# Runtime: Debian trixie matches the Feiniu/Debian NAS host and ships ffmpeg 7.x
# with NVENC/VAAPI/QSV encoders that dlopen the vendor libraries at runtime, so
# hardware transcoding still works once nvidia-container-toolkit injects them —
# no CUDA base image needed on GPU-less hosts.
FROM ${RUNTIME_IMAGE}
# v0.9.50：apt 源参数化。
# v0.9.89 修正：这里原先只用了 ${APT_MIRROR:-} 却从未 ARG 声明，外部传
#   --build-arg APT_MIRROR=... 会被判为「未消费」而静默不生效；现补上声明，
#   默认走阿里云源（Gitee Go runner 在国内），传空值仍可回到官方源。
ARG APT_MIRROR=http://mirrors.aliyun.com/debian
RUN if [ -n "${APT_MIRROR:-}" ]; then \
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g; s|http://security.debian.org/debian-security|${APT_MIRROR}-security|g" /etc/apt/sources.list; \
    fi \
 && apt-get update \
 # v0.9.77：poppler-utils 提供 pdftoppm/pdfinfo —— PDF 漫画在服务端光栅化翻页，
# 不再把 .pdf 交给浏览器内置 PDF 阅读器（客户反馈的问题）。
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl ffmpeg poppler-utils \
 && rm -rf /var/lib/apt/lists/*
COPY caddy /usr/bin/caddy
COPY --from=go-build /out-media-api /usr/bin/media-api
COPY --from=go-build /out-subtitle-api /usr/bin/subtitle-api
COPY --from=go-build /out-vaulthub-manager /usr/bin/vaulthub-manager
RUN chmod 755 /usr/bin/caddy /usr/bin/vaulthub-manager /usr/bin/media-api /usr/bin/subtitle-api
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY web /srv/web
# v1.0.6：三份《界面规格之 … 影音播放器界面元素详解》随镜像发布，
# 外观面板里的「查看元素清单」可直接打开原文（/docs/specs/<spec>.md）。
COPY docs/specs /srv/docs/specs
# v1.0.7：APP 契约三件套（/docs/api/openapi.yaml 等）。
COPY docs/api /srv/docs/api

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
    ADMIN_PASSWORD= \
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
