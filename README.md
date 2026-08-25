# VaultHub 蜀鼠之家 v0.6.18：GPU 加速与完整长文阅读

v0.6.18 在视频音频兼容播放基线上增加 GPU 硬件解码/编码配置，并修复长 TXT 只显示首屏和电子书阅读器主题不同步问题。

## v0.6.18 更新

- Docker Compose 支持 `/dev/dri` 透传，并提供 NVIDIA Container Toolkit 的 `gpus` 配置示例。
- 系统设置新增显卡加速选项：自动、CPU、VAAPI、Intel QSV、NVIDIA CUDA/NVENC。
- `/api/media/hardware` 检测设备和 ffmpeg 编码器；硬件不可用自动回退 CPU。
- `/api/media/compat` 支持 `hw` 参数，响应头 `X-VaultHub-Hardware` 显示实际使用的加速模式。
- 长 TXT 按 Range 分块读取并完整合并，不再只缓存/显示首屏。
- TXT 继续自动识别 UTF-8，失败时回退 GB18030。
- 电子书正文、目录、阅读背景同步系统暗色、亮色和自定义主题；切换主题时已打开阅读器即时更新。

## GPU 配置

Intel/AMD VAAPI 或 QSV：

```yaml
environment:
  FFMPEG_HWACCEL: "auto"
  VAAPI_DEVICE: "/dev/dri/renderD128"
devices:
  - /dev/dri:/dev/dri
```

CPU-only主机请保持默认 Compose 不映射 `/dev/dri`；需要 VAAPI/QSV 时，在服务的 `devices:` 下取消注释并重建容器。

NVIDIA：宿主机安装 NVIDIA Container Toolkit 后，在 Compose 中启用：

```yaml
gpus: all
environment:
  FFMPEG_HWACCEL: "cuda"
  NVIDIA_VISIBLE_DEVICES: "all"
  NVIDIA_DRIVER_CAPABILITIES: "compute,video,utility"
```

硬件设备、权限或 ffmpeg 编码器不可用时会自动回退 CPU，不影响播放。


- 新增 `/api/media/probe`，使用 ffprobe 判定容器和音频编码是否可能被浏览器直接支持。
- 新增 `/api/media/compat`，直连无声或不兼容时输出 H.264 + AAC 的 MP4 兼容流。
- 前端自动判定规则：MKV/AVI/RMVB/WMV/FLV/TS/M2TS/VOB/ISO 等容器直接使用兼容流；MP4/WebM 等先直连，再结合 probe 的音频编码结果自动切换。
- 播放器保留“直连原片”和“音频兼容”手动按钮，直连错误时自动切换兼容流。
- 桌面端视频阅读器不再覆盖左侧边栏，只占用侧栏右侧空间；移动端继续全屏。

## v0.6.16 更新

- 删除 0.6.16 之后引入的转码/画质切换功能，影视播放改回 `/api/media/file` 直连。
- 视频播放器不再自动播放，避免浏览器拦截有声自动播放；加载元数据后强制取消静音并恢复音量。
- 视频阅读窗口铺满当前页面阅读区域，隐藏视频下方提示信息。
- 放开电子书、漫画、PDF/图片阅读窗口高度限制，阅读器按可视窗口拉伸。

## v0.6.15 更新

- 漫画本地库支持：EPUB、MOBI、ZIP、CBZ、PDF、RAR、CBR、7Z、CB7、JPG/PNG 等散图、CPG、LZH、CBL、TAR、CBT。
- 电子书本地库支持：EPUB、PDF、MOBI、AZW/AZW3、CHM、EXE、UMD、JAR/JAD、CAJ、PDG、DJVU、CEB、DOC/DOCX、XPS、TXT。
- 影视栏目新增“本地媒体库 / 外连服务”切换；本地库支持 MP4、MKV、AVI、MOV、WEBM、TS/M2TS、WMV、FLV、MPG/MPEG、RMVB、ISO 等影片文件。
- 影视本地库支持文件名兜底展示、豆瓣默认刮削、`TMDB_API_KEY` 环境变量启用 TMDB 刮削代理。

### TMDB 可选配置

```yaml
environment:
  - TMDB_API_KEY=你的_tmdb_api_key
```

未配置 `TMDB_API_KEY` 时，影视库仍可正常读取和播放，刮削失败会使用文件名展示。


- 新增本地媒体库设置：名称、类型和多个容器目录路径。
- 媒体源可在“本地媒体库”和原有“外连服务”之间切换。
- 本地音乐支持浏览器原生播放，本地图片/TXT/PDF 支持直接预览，其他电子书和压缩漫画可下载或由浏览器支持能力打开。
- 本地媒体文件通过 `home.examples.top/api/media/*` 同源访问，浏览器不会连接 NAS 内网 IP。
- 媒体列表接口只返回库配置；文件索引由后台单线程低速任务生成，带临时文件原子替换，避免页面请求阻塞。
- 文件列表使用 `/api/media/files` 分页接口，默认每页 100 条，避免一次性构造巨型 JSON 和浏览器 DOM。
- 扫描会跳过 `@eaDir`、`.cache`、`#recycle`，并按批次休眠降低磁盘 I/O 竞争；索引保存到 `/data/media-index`。
- TXT 预览按 1 MiB Range 分块读取并完整合并；不一次性请求超大正文，同时保证长文末尾和全部章节可读。
- 媒体库路径改为任意容器内已挂载的绝对目录，不再强制要求 `/media` 前缀；仍保留真实路径和符号链接逃逸校验。

- 项目名称改为 `VaultHub 蜀鼠之家`。
- Compose 服务名为 `vaulthub`，容器名为 `VaultHub`。
- ~~本地镜像名为 `vaulthub:0.6.0-local`。~~（旧的本地构建方式，保留兼容；当前推荐直接使用 `ghcr.io/q807738511/vaulthub:latest` 或固定版本标签。）
- 左上角页面名改为 `蜀鼠之家`，图标改为动画中华鼠图标。
- 电子书和漫画合并为 `超漫画`，统一包含 Komga / Kavita / Calibre-Web。
- 新增 WebUI 的 `Caddy 配置` 页面，可读取、保存并热加载容器内 Caddyfile。
- YAML 只保留首次启动预配置；实际 Caddyfile 持久化到 `./data/Caddyfile`。
- 保留 v0.4.2 的 Komga 路由修复和媒体公网自动映射。

## 首次配置

旧的变量化 `.env` 写法仍兼容，但当前家庭 NAS 固定部署不再要求使用：

- ~~`WEBUI_PORT=8088`~~
- ~~`NAS_IP=192.168.112.3`~~
- ~~`DASHBOARD_ORIGIN=https://home.examples.top`~~
- `ADMIN_TOKEN=`（建议保留并设置长随机值）

端口和媒体卷可以直接写在 Compose 中。`NAS_IP`、`DASHBOARD_ORIGIN`、`WEB_ROOT`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 已有镜像默认值；当前环境不变时无需重复声明。`ADMIN_TOKEN` 建议保留，用于保护 Caddy 和媒体库管理接口。

`ADMIN_TOKEN` 留空表示管理配置不鉴权。公网环境建议填写一串长随机密码，WebUI 保存 Caddy 或媒体库配置时输入同一个令牌。

## 本地媒体目录

~~先在 `.env` 中填写 NAS 的宿主机目录：~~（旧的变量化媒体路径方式，仍兼容但不再推荐。）

- ~~`MUSIC_PATH=/vol2/link/音乐`~~
- ~~`COMIC_PATH=/vol3/漫画`~~
- ~~`BOOK_PATH=/vol4/电子书`~~

~~Compose 会把它们只读映射为 `/media/music`、`/media/comics`、`/media/books`。~~

当前推荐直接在 Compose 中配置只读卷。可以映射一个公共媒体根目录：

```yaml
volumes:
  - ./data:/data
  - /media:/media:ro
```

也可以只映射需要的具体目录：

```yaml
volumes:
  - ./data:/data
  - /vol2/link/音乐:/media/music:ro
  - /vol3/漫画:/media/comics:ro
  - /vol3/1000/komga/书画:/media/books:ro
```

宿主机路径写在冒号左边，容器路径写在右边，`:ro` 表示只读。WebUI 只填写容器路径：

```text
/media/music
/media/comics
/media/books
```

同一媒体库可添加多个路径。跨卷时可在 Compose 的 `volumes` 中继续增加只读映射，例如：

```yaml
- /vol5/音乐:/media/music-vol5:ro
```

然后在同一个音乐库中添加 `/media/music-vol5`。为避免泄露容器文件，媒体 API 只接受容器内已挂载的绝对目录。

## 公网接入方案

VaultHub 支持两种公网接入方式：

1. **Cloudflare Tunnel（推荐）**：无需公网 IP，也无需路由器开放 80/443。
2. **传统反向代理**：公网 DNS + 路由器端口转发 + Lucky/NPM；需要可用公网 IP。

两种方式的核心规则相同：`home`、`kom`、`yy` 三个域名都必须先进入 VaultHub 的 `8088`，再由容器内 Caddy 按 Host 分流。不要把 `kom` 直接代理到 `25600`，也不要把 `yy` 直接代理到 `4533`，否则会绕过 Caddy 的 iframe 响应头处理。

### 方案一：Cloudflare Tunnel

在 Cloudflare Zero Trust → Networks → Tunnels → Public Hostnames 添加：

```text
home.examples.top  -> HTTP -> 192.168.112.3:8088   # VaultHub 主页
kom.examples.top   -> HTTP -> 192.168.112.3:8088   # Caddy 再转 Komga :25600
yy.examples.top    -> HTTP -> 192.168.112.3:8088   # Caddy 再转 Navidrome :4533
```

Cloudflare 提供公网 HTTPS，Tunnel 到 NAS 使用内网 HTTP。三条记录应属于同一个在线 Tunnel，DNS CNAME 应指向同一个 `<tunnel-id>.cfargotunnel.com`。

验证：

```bash
curl -I https://home.examples.top/
curl -I https://kom.examples.top/
curl -I https://yy.examples.top/app/
curl -sI https://kom.examples.top/ | grep -i content-security-policy
```

最后一条应包含 `frame-ancestors https://home.examples.top`。若返回 522，先检查该域名的 Public Hostname 是否指向 `192.168.112.3:8088`，再确认 DNS 没有指向旧 Tunnel。

### 方案二：公网 DNS + Lucky/NPM 传统反向代理

适合不使用 Tunnel、家里有公网 IPv4，或已正确配置 IPv6 入站访问的环境。IPv4 处于运营商 CGNAT 时不能使用此方案，除非先申请公网 IP。

访问链路：

```text
浏览器 HTTPS :443
  -> 公网 DNS（home/kom/yy 指向家庭公网 IP）
  -> 路由器 TCP 443 端口转发
  -> Lucky 或 Nginx Proxy Manager
  -> http://192.168.112.3:8088
  -> VaultHub 内置 Caddy 按 Host 分流
```

#### 1. DNS 解析

在域名 DNS 服务商添加三条记录：

```text
A     home  -> 家庭公网 IPv4
A     kom   -> 家庭公网 IPv4
A     yy    -> 家庭公网 IPv4
```

若公网 IP 会变化，先在 Lucky/路由器配置 DDNS。使用 IPv6 时创建 AAAA 记录，并确认 NAS、代理和防火墙都允许 IPv6 443 入站。若 DNS 托管在 Cloudflare，传统源站模式可使用橙云代理，但它不等于 Tunnel，源站仍需开放 443。

#### 2. 路由器端口转发

```text
公网 TCP 443 -> Lucky/NPM 所在主机的 TCP 443
公网 TCP 80  -> Lucky/NPM 所在主机的 TCP 80（证书 HTTP 验证或跳转，可选）
```

不要把公网端口转发到 VaultHub 管理 API，也不要开放 `9099`。若运营商封锁 80，可使用 DNS Challenge 申请证书；443 仍需公网可达。

#### 3. Lucky 配置

创建 HTTPS Web 服务监听（通常为 443），申请 `home.examples.top`、`kom.examples.top`、`yy.examples.top` 证书，并建立三个按主机名匹配的子规则：

```text
前端域名 home.examples.top -> 后端 http://192.168.112.3:8088
前端域名 kom.examples.top  -> 后端 http://192.168.112.3:8088
前端域名 yy.examples.top   -> 后端 http://192.168.112.3:8088
```

启用 WebSocket，保留原始 `Host` 请求头，并设置 `X-Forwarded-Proto: https`。不要使用 Lucky 管理端口 `16601` 作为反代入口。

#### 4. Nginx Proxy Manager 配置

分别新建三个 Proxy Host：

```text
Domain Names: home.examples.top / kom.examples.top / yy.examples.top
Scheme:       http
Forward Host: 192.168.112.3
Forward Port: 8088
Websockets:   开启
SSL:          为每个域名申请证书，开启 Force SSL
```

NPM 默认会转发原始 Host；不要在 Advanced 中覆盖成 `Host 192.168.112.3`。三个域名虽然共用同一个目标端口，但 Caddy 会根据原始 Host 分别返回 VaultHub、Komga 和 Navidrome。

#### 5. 安全与验证

- 路由器只开放反向代理的 80/443，不开放 `8088`、`4533`、`25600`、`61208` 或 `9099`。
- 建议在 `home.examples.top` 前增加认证；VaultHub 的 `ADMIN_TOKEN` 必须设置长随机值。
- `DASHBOARD_ORIGIN` 必须保持 `https://home.examples.top`。

```bash
curl -I https://home.examples.top/
curl -I https://kom.examples.top/
curl -I https://yy.examples.top/app/
curl -sI https://kom.examples.top/ | grep -i content-security-policy
```

### 两种方案对比

| 项目 | Cloudflare Tunnel | 传统反向代理 |
|---|---|---|
| 公网 IP | 不需要 | 需要公网 IPv4 或可入站 IPv6 |
| 路由器开放端口 | 不需要 | 需要转发 443，通常还需 80 |
| HTTPS 证书 | Cloudflare 托管 | Lucky/NPM 自行申请和续期 |
| 源站 IP 暴露 | 不暴露 | 通常会暴露 |
| 故障点 | cloudflared、Tunnel DNS | DDNS、端口转发、证书、防火墙 |
| VaultHub/Caddy 配置 | 相同 | 相同 |

当前环境已使用 Tunnel，继续使用方案一最省事。方案二适合作为不依赖 cloudflared 的备用接入方式，两种方案不建议让同一域名同时生效，以免 DNS 流量指向不一致。

## 自动更新容器

项目包含 `.github/workflows/publish-image.yml` 和 `docker-compose.autoupdate.yml`：

```text
GitHub 推送 main 或发布版本标签
  -> GitHub Actions 构建 linux/amd64 镜像
  -> 发布 ghcr.io/q807738511/vaulthub:latest
  -> 版本标签同时发布 ghcr.io/q807738511/vaulthub:0.6.8
  -> 自动创建对应 GitHub Release
  -> NAS Watchtower 每 5 分钟检查
  -> 自动拉取并重启 VaultHub
```

### 第一次配置

1. 推送仓库，等待 GitHub `Actions` 中的 `Build and publish container` 完成。
2. 打开仓库右侧 `Packages` → `vaulthub` → Package settings，将镜像设为 **Public**。公开镜像无需在 NAS 保存 GitHub Token。
3. ~~编辑 `docker-compose.autoupdate.yml`，把 `<github用户名>` 换成你的小写 GitHub 用户名。~~（已废弃，仓库镜像地址已固定为 `ghcr.io/q807738511/vaulthub`。）
4. 如需变量化配置，可复制 `.env.example`；固定部署可直接在 Compose 中写端口和卷映射：

```bash
cp .env.example .env
```

5. 在 NAS 首次切换到自动更新版：

```bash
cd /vol1/1000/Docker/vaulthub
docker compose down || true
docker rm -f VaultHub VaultHub-Watchtower 2>/dev/null || true
docker compose -f docker-compose.autoupdate.yml up -d
```

如果 GHCR 包保持 Private，先使用至少有 `read:packages` 权限的只读 PAT 登录：

```bash
echo '<GitHub只读PAT>' | docker login ghcr.io -u <GitHub用户名> --password-stdin
docker compose -f docker-compose.autoupdate.yml up -d
```

不要把 PAT 写进 Compose 或提交到 GitHub。

### 日常更新与验证

以后只需在 GitHub Desktop 提交并点击 `Push origin`。Actions 发布后，Watchtower 最多等待 5 分钟更新容器；更新时会短暂重启，`.env` 和 `./data/Caddyfile` 不会被覆盖。

```bash
docker ps --filter name=VaultHub --filter name=Watchtower
docker logs VaultHub-Watchtower --tail 50
docker image ls ghcr.io/q807738511/vaulthub
```

### 回滚

每次 Actions 构建还会生成 `sha-xxxxxxx` 标签。需要回滚时，把 Compose 镜像改为对应 SHA 标签：

```yaml
image: ghcr.io/q807738511/vaulthub:sha-0123456
```

然后重新执行：

```bash
docker compose -f docker-compose.autoupdate.yml up -d
```

## 构建验证

```bash
docker compose ps
curl http://127.0.0.1:8088/healthz
curl http://127.0.0.1:8088/api/admin/caddyfile
curl -H "Host: kom.examples.top" http://127.0.0.1:8088/api/v1/libraries
```

`/api/v1/libraries` 未登录时返回 Komga 认证错误是正常的；不应返回 `<title>VaultHub` 或 WebUI HTML。
