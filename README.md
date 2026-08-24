# VaultHub 蜀鼠之家 v0.6.16：影视播放、字幕与刮削增强

v0.6.16 修复本地影视原生播放遇到无声/无画面时的兼容兜底，新增字幕选择并默认开启同名字幕；影视库读取后自动按豆瓣或 TMDB 刮削，无法命中时使用影片片段截图作为封面。

## 变更

## v0.6.22 更新

- 播放器按侧栏剩余宽度和可用视口高度自适应，保持 16:9，桌面端居中显示，移动端自动铺满。
- 修复转码画质播放看似无法缓存的问题：转码输出改为 fragmented MP4，通过响应流边转边播，并在后台同时写入持久缓存。
- Caddy 的 media/system 反代启用 `flush_interval -1`，避免缓冲转码流。


## v0.6.20 更新

- 修复 `media-api` 子进程异常退出后 Caddy 持续报 `dial tcp 127.0.0.1:9100: connect: connection refused` 的问题：管理进程现在会监听子进程退出并自动重启 media API。
- 首次视频转码播放改为边转码边输出，浏览器不再必须等待完整 MP4 缓存文件生成后才开始播放。
- 首次转码仍会写入 `/data/transcode-cache`，转码完成后后续播放继续命中持久缓存并支持 Range。
- 保留 Caddy 作为内置网关；当前 502 根因在 media API 后端进程/播放转码流程，不是 Caddy 性能瓶颈。

## v0.6.19 更新

- 修复线上批量 `502`：`media-api` 原为单线程，请求首次转码/截图时会阻塞 `/api/system/metrics`、`/api/media/libraries` 等轻量接口，Caddy 反代到 `127.0.0.1:9100` 会出现 `i/o timeout`。
- `media-api` 改为每个连接独立线程处理，转码/截图不会阻塞媒体库读取和系统监控接口。
- 转码临时缓存文件名加入线程标识，避免并发请求同一视频/画质时 `.tmp` 文件互相覆盖。
- `listen` backlog 从 32 提高到 128，降低浏览器轮询和首次转码同时发生时的连接堆积。
- 新增并发回归测试：首次 720P 转码运行中，连续请求 `/api/system/metrics` 和 `/api/media/libraries` 均需快速返回 200。

## v0.6.18 更新

- 修复 v0.6.17 影视任意画质无法加载的问题：ffmpeg 输出到 `.mp4.tmp` 临时缓存文件时无法识别封装格式，现已显式指定 `-f mp4`。
- 修复 720P/480P 等画质转码滤镜表达式，正确处理 `scale=-2:min(height\,ih)`。
- 影视播放器默认改为 720P 转码播放，任意访问环境下默认优先保证可播。
- 删除“兼容转码播放”和“外部打开原片”按钮，避免播放入口混乱。
- 画质选择移动到播放器内部右下角，和浏览器原生音量/全屏/菜单区域靠近。
- 画质选择为“原画”时才尝试文件直连；1080P/720P/480P/360P 均使用对应分辨率缓存转码。
- 新增真实视频流回归测试：生成 MP4，经 `/api/media/transcode` 输出 720P/480P，并用 ffprobe 验证 H.264 视频和 AAC 音频流。

## v0.6.17 更新

- 漫画、电子书、影视本地库新增“海报 / 列表”视图切换，分别记忆漫画、电子书和影视的显示方式。
- 阅读器、漫画/电子书/影视播放窗口改为避开左侧侧边栏，不再覆盖导航；移动端仍保持全屏阅读。
- 影视播放新增网络自动识别：内网/localhost 下“原画”使用文件直连；域名反代、Cloudflare Tunnel/穿透访问时自动使用转码流。
- 新增画质档位：原画、1080P、720P、480P、360P；非原画统一走 ffmpeg 转码。
- 新增转码缓存目录 `TRANSCODE_CACHE_DIR`，默认 `/data/transcode-cache`，同一文件/画质二次播放直接命中缓存，提升穿透和反代播放流畅度。

## v0.6.16 更新

- 影视播放器增加“兼容转码播放”：浏览器原生解码 MKV/HEVC/DTS 等失败导致无声或无画面时，会切换到 ffmpeg 转码的 MP4/H.264/AAC 流。
- 新增外挂字幕识别与选择：支持同名 `.vtt/.srt/.ass/.ssa`，SRT 自动转 WebVTT，第一个字幕默认开启。
- 本地影视库读取后自动刮削；刮削源可选豆瓣或 TMDB（TMDB 仍需配置 `TMDB_API_KEY`）。
- 豆瓣/TMDB 无法命中时，后端通过 ffmpeg 截取影片片段截图作为封面兜底，避免只显示空白列表。
- 运行镜像增加 `ffmpeg`，用于视频转码、片段截图和播放兼容兜底。


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
- TXT 预览只读取首个 1MB Range，不再把超大 TXT 全部加载进浏览器内存。
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
