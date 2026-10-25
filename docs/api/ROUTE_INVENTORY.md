# VaultHub API 路由清单（v1 契约冻结基线）

> 基于 main 分支 2026-10-24 快照逐文件整理。目的：在开发移动 APP 之前，把现有 HTTP 接口固化为对外契约。
> 配套文件：[openapi.yaml](openapi.yaml)（规范草稿）、[CONTRACT_TESTS.md](CONTRACT_TESTS.md)（契约测试清单）。
> 所有 JSON 字段名、状态码均以当前源码为准（handler 位置标注为 `文件:行号`）。

---

## 1. 架构与鉴权模型

```
客户端 ──► Caddy :8088（唯一入口）
             ├─ /api/health /api/login /api/logout /api/auth/mode
             │  /api/account /api/system/runtime /api/admin/*   ──► manager  127.0.0.1:9099（认证/守护）
             ├─ /api/system/*                                    ──► media-go 127.0.0.1:9100（系统监控）
             ├─ /api/media/subtitles/search|download（精确匹配）──► subtitle-api 127.0.0.1:9120
             ├─ /api/media/*（兜底）                             ──► media-go 127.0.0.1:9100（媒体核心）
             ├─ /api/glances/* /api/mp/*                         ──► NAS 外部服务（不属于本契约）
             ├─ @host comic/kavita/book/plex/emby/jellyfin/...   ──► NAS 外部服务（按域名分流）
             └─ 其余                                             ──► WebUI 静态文件
```

**会话模型**（manager 持有，`manager/main.go`）：

- 登录成功设置 Cookie **`vh_session`**（`Path=/; HttpOnly; SameSite=Lax`，HTTPS 时加 `Secure`）。
- sid = 24 字节 crypto/rand 的 48 位小写 hex；TTL 仅两档：30 天（默认）/ 60 天（`keep_days>=60`）。
- **每次读取会话都滑动续期**；会话表持久化到 `/data/sessions.json`，落盘时按到期时间保留最近 256 条。
- 单管理员账号（无多用户）；must-change 受限会话只能访问 `/api/account`、`/api/system/runtime` 等白名单。
- 登录失败 5 次/客户端 IP → 锁 5 分钟（429）。
- open 模式：`require()` 全放行，任意凭据可登录。

**media-go / subtitle-api 的鉴权**：

- media-go 的 `readAuth`/`writeAuth`（`media-go/main.go:624/631`，实现完全相同）取请求的 `vh_session` Cookie，回环调用 `GET http://127.0.0.1:9099/api/session/check`（3s 超时），**只看返回状态码：200 = 有效**。media-go 自己不存会话。
- subtitle-api 自身通过 `sessionOK()` 探针校验会话（**v1.0.6 起生效**）：携带调用方 Cookie 回环探测 `GET /api/media/files?id=__vh_auth_probe__`，仅 401 判未登录（有效会话返回 400 invalid id），网络故障放行。内嵌轨部分（转发给 media-go）另受会话约束。

---

## 2. 路由总表

鉴权一栏：`公开` = 无需登录；`会话` = 需 `vh_session`；`受限会话可用` = must-change 会话也可访问；`loopback` = 仅容器内回环可达。★ = 移动 APP MVP 依赖。

### 2.1 manager（9099）

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| ANY | /api/health | 公开 | 存活探测 | main.go:790 |
| POST ★ | /api/login | 公开 | 登录，设 Cookie | main.go:556 |
| ANY | /api/logout | 公开 | 注销（吊销当前会话） | main.go:622 |
| GET ★ | /api/auth/mode | 公开 | 认证模式（**返回用户名**） | main.go:633 |
| POST | /api/account | 会话（受限可用） | 改密/用户名/模式 | main.go:655 |
| GET | /api/session/check | loopback + 会话 | **跨服务会话验证**（内部契约） | main.go:798 |
| ANY | /api/system/runtime | 会话（受限可用） | 进程/子进程状态 | main.go:824 |
| ANY | /api/admin/docker/scan | 会话（受限 403） | Docker 容器扫描 | main.go:897 |
| GET/POST | /api/admin/caddyfile | 会话（受限 403） | 读写 Caddyfile | main.go:834 |
| GET/POST | /api/admin/caddy/config | 同上 | 同一 handler 的别名 | main.go:834 |

### 2.2 media-go（9100）— 系统/库/索引

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| GET | /api/system/metrics | 会话 | CPU/内存/磁盘/温度监控 | main.go:2162 |
| GET ★ | /api/media/libraries | **公开（注意）** | 库列表（含磁盘路径） | main.go:1105 |
| POST | /api/media/libraries | 会话 | 新增库（触发索引） | main.go:1105 |
| DELETE | /api/media/libraries | 会话 | 删除库 | main.go:1105 |
| GET/PUT/POST | /api/media/settings | 会话 | 运行配置读写（密钥不回明文） | main.go:930 |
| GET | /api/media/hardware | **公开** | 转码硬件探测 | main.go:3107 |
| GET | /api/media/index/status | **公开（注意）** | 各库索引/扫描状态 | main.go:1584 |
| POST | /api/media/index/rebuild | 会话 | 重建索引（202） | main.go:1527 |
| POST | /api/media/index/cancel | 会话 | 取消扫描 | main.go:1560 |
| GET ★ | /api/media/files | 会话 | 文件分页列表（SQLite 索引，ETag/304） | main.go:1679 |

### 2.2b 别名与 canonical（v1.0.7 定稿）

同一 handler 的多个注册名保留兼容，但契约只认 canonical；新增客户端一律用 canonical 列。

| canonical | 别名 | handler | 说明 |
|---|---|---|---|
| `/api/media/archive/zip` | `/api/media/archive`、`/api/media/zip`、`/api/media/archive/zip/register` | `archive` | 漫画压缩包列表/登记；`register` 为旧客户端别名 |
| `/api/admin/caddyfile` | `/api/admin/caddy/config` | `caddy` | Caddyfile 读写 |

### 2.3 media-go — 播放（APP 核心）

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| GET/HEAD ★ | /api/media/file | 会话 | 原文件直出（Range/206/304 完整支持） | main.go:1798 |
| GET/HEAD | /api/media/file/{id}/{path…} | 会话 | 旧版路径式直出（兼容层） | main.go:1824 |
| GET ★ | /api/media/compat | 会话 | 转码兼容流（live frag-MP4 / 缓存 mp4） | main.go:3960 |
| GET | /api/media/probe | **公开（注意）** | ffprobe 探测 | main.go:2262 |
| GET ★ | /api/media/weak/probe | 会话 | 下行网速探测（确定性随机字节流） | audio_stream.go:347 |
| GET/POST | /api/media/network/speed | 会话 | 刮削网络测速（白名单域名） | network.go:193 |
| POST ★ | /api/media/playback/plan | 会话 | **播放决策**（客户端能力上报） | playback.go:192 |
| POST ★ | /api/media/playback/sessions | 会话 | 创建播放会话（≤64 并发） | playback.go:280 |
| POST ★ | /api/media/playback/sessions/{id}/{stop\|progress} | 会话 | 心跳/停止（2 分钟无心跳回收） | playback.go:330 |
| GET ★ | /api/media/streams | 会话 | 音轨/字幕轨列表 | main.go:2320 |
| POST | /api/media/tasks/cancel | 会话 | 取消转码任务 | main.go:3030 |
| GET | /api/media/disc/playlists | 会话 | 原盘（蓝光/DVD）播放列表 | disc_playlist.go:319 |

### 2.4 media-go — 音频

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| GET/HEAD ★ | /api/media/audio/stream | 会话 | MP3 转码流（bitrate 白名单 64–320k 七档） | audio_stream.go:131 |
| GET/PUT/POST/DELETE | /api/media/audio/cache | 读会话/写会话 | 音频元数据缓存 | audio_cache.go:120 |
| GET | /api/media/audio/cache/stats | 会话 | 缓存统计 | audio_cache.go:256 |
| GET | /api/media/audio/lyrics | 会话（save=1 需写） | 歌词查询（本地→LRCLIB→lyrics.ovh→网易云） | audio_lyrics.go:608 |
| POST | /api/media/audio/lyrics/batch | 会话 | 批量歌词（≤50 条，429 串行闸门） | audio_lyrics.go:683 |
| GET | /api/media/audio/scrape/status | 会话 | 音频库刮削进度 | audio_persist.go:186 |
| GET | /api/media/audio/metadata | 会话 | 在线音频元数据（iTunes/MusicBrainz） | audio_metadata.go:486 |
| POST/PUT | /api/media/audio/metadata/commit | 会话 | 提交元数据（sidecar + SQLite 双写） | audio_persist.go:253 |
| GET | /api/media/audio/artist | 会话 | 艺人信息/头像 | audio_metadata.go:1025 |

### 2.5 media-go — 阅读（APP 核心之二）

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| GET ★ | /api/media/cover | **公开** | 封面/海报图片（支持 w 缩略、ETag/304） | cover_persist.go:296 |
| POST | /api/media/cover | 会话 | 下载远程图写 sidecar | cover_persist.go:172 |
| GET ★ | /api/media/archive、/api/media/zip、/api/media/archive/zip、/api/media/archive/zip/register | 会话 | ZIP/CBZ 条目列表（**4 个别名同一 handler**） | main.go:1901 |
| GET ★ | /api/media/archive/zip/page | 会话 | 漫画页图片（w/q 转码 + ETag/304） | page_handler.go:153 |
| GET ★ | /api/media/archive/zip/cover | 会话 | 漫画封面缩略图 | page_handler.go:198 |
| GET ★ | /api/media/pdf/info | 会话 | PDF 页数（poppler） | pdf_pages.go:245 |
| GET ★ | /api/media/pdf/page | 会话 | PDF 页图（page 从 1 起） | pdf_pages.go:281 |
| GET ★ | /api/media/pdf/cover | 会话 | PDF 封面 | pdf_pages.go:374 |
| GET ★ | /api/media/document/epub | 会话 | EPUB 章节纯文本 | document_epub.go:545 |
| GET/PUT/POST/DELETE ★ | /api/media/reading/progress | 会话 | **阅读进度（服务端持久化）** | reading_progress.go:102 |

### 2.6 media-go — 字幕

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| GET | /api/media/subtitles/search | 会话 | **生产环境被 Caddy 遮蔽**（分流到 subtitle-api；直连 9100 时生效） | main.go:3147 |
| GET ★ | /api/media/subtitles/extract | 会话 | 内嵌轨抽 WebVTT（`track` 从 0 起） | main.go:2943 |
| GET ★ | /api/media/subtitles/proxy | 会话 | 外挂字幕（.srt/.ass 等）转 WebVTT | main.go:2976 |

### 2.7 media-go — 刮削/元数据（管理面，APP 可后置）

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| ANY | /api/media/scrapers | **公开** | 刮削器能力（含运行配置快照） | main.go:3102 |
| GET/POST/DELETE | /api/media/scrape-cache | 读会话/写会话 | 刮削结果缓存（/data/media-scrape-cache.json） | scrape_store.go:438 |
| GET/POST | /api/media/nfo | 读会话/写会话 | NFO 读/写（Kodi/Emby 兼容） | nfo_write.go:497 |
| GET | /api/media/series/plan | 会话 | 剧集命名/分季整理判定 | series_plan.go:41 |
| GET | /api/media/series/missing | 会话 | 本地集号 vs 官方集数 | series_plan.go:105 |
| GET | /api/media/tmdb | 会话 | TMDB 代理（搜索/详情/季） | main.go:3498 |
| GET | /api/media/douban | 会话 | 豆瓣评分（未命中也 200，match:false） | douban.go:591 |
| POST | /api/media/douban/batch | 会话 | 批量豆瓣（≤24 条） | douban.go:625 |
| GET | /api/media/tvdb | 会话 | TVDB 搜索代理 | network.go:245 |
| GET | /api/media/cast/avatar | 会话 | 演员头像（TMDB 代理/本地 .actors/） | main.go:3378 |
| GET ★ | /api/media/metadata | 会话 | 本地元数据（NFO + sidecar + override 合并） | local_metadata.go:681 |
| POST ★ | /api/media/metadata/batch | 会话 | 批量本地元数据（≤500 条） | local_metadata.go:644 |
| PUT | /api/media/metadata/override | 会话 | 手工覆盖（评分/标签/已看的多端同步） | metadata_override.go:154 |
| GET | /api/media/metadata/artwork | 会话 | 媒体目录图片候选 | metadata_override.go:232 |

### 2.8 subtitle-api（9120，经 Caddy 对外）

| 方法 | 路径 | 鉴权 | 用途 | handler |
|---|---|---|---|---|
| ANY | /healthz | 无（Caddy 不转发） | 存活（仅容器内可达） | main.go:377 |
| GET ★ | /api/media/subtitles/search | **服务自身无鉴权** | 聚合字幕搜索（内嵌轨 + 本地 + shooter/zimuku/subhd） | main.go:242 |
| ANY ★ | /api/media/subtitles/download | **无鉴权** | 字幕下载代理（url 必须 https，≤8MiB） | main.go:349 |

---

## 3. APP 核心契约详情（字段级）

> 完整规范见 openapi.yaml，此处只展开 APP 播放/阅读链路必须逐字依赖的部分。

### 3.1 登录（POST /api/login）

```jsonc
// 请求（≤64KiB）
{ "username": "string", "password": "string", "keep_days": 30 }  // keep_days: >=60 → 60，其余 → 30

// 200 响应
{ "ok": true, "idle_timeout_seconds": 2592000, "session_days": 30, "must_change": false }

// 错误：405 非 POST；429 too many login attempts；400 invalid json；401 invalid credentials
```

成功后 `Set-Cookie: vh_session=<48位hex>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<TTL>`。APP 第一版可直接把该 Cookie 当长期 token 使用（服务端会话 30/60 天滑动续期、重启不丢）。

### 3.2 播放决策（POST /api/media/playback/plan）

```jsonc
// 请求
{
  "library_id": "string（必填）",
  "path": "string（必填，库内相对路径）",
  "quality": "auto|original|1080p|720p|480p（大小写不敏感，空串=auto）",
  "hardware": "auto|cpu|vaapi|qsv|cuda（可选）",
  "server_transcode": "off 表示禁用服务端转码（可选）",
  "network_bps": 12500000,   // int64，auto 档限高：<2M→480p <6M→720p <16M→1080p
  "client": {                // 客户端能力上报（全部 bool）
    "mp4": true, "mse": true, "h264": true, "hevc": false, "vp9": true,
    "aac": true, "opus": true
  }
}

// 200 响应
{
  "layer": "direct_play|smart_stream",
  "mode": "direct|remux|audio_transcode|full_transcode",
  "reason": "中文可读原因",
  "url": "/api/media/file?id=..&path=..",        // direct
        // 或 "/api/media/compat?id=..&path=..&hw=..&mode=..[&height=N]"
  "video_action": "copy|h264",
  "audio_action": "copy|aac",
  "hardware": "cpu|vaapi|qsv|cuda|client",
  "max_height": 720,            // omitempty，0=不限
  "disc": "bluray|dvd",         // omitempty，仅原盘
  "media": { "container": "", "video_codec": "", "audio_codec": "",
             "width": 0, "height": 0, "bit_rate": "", "duration": "" },
  "warn": "仅 server_transcode=off 时出现"
}

// 错误：400 invalid playback request；404 invalid media path；422 media probe failed；
//      409 已禁用服务端转码 + 原盘镜像
```

### 3.3 播放会话与进度（内存态，2 分钟心跳）

```jsonc
// POST /api/media/playback/sessions  → 200
{ "id": "<32位hex，服务端生成>", "library_id": "", "path": "", "mode": "",
  "state": "playing", "position_ms": 0, "duration_ms": 0, "updated_at": 0 }
// 429 too many playback sessions（活跃 ≥64）；会话纯内存，2 分钟无心跳即回收并取消转码

// POST /api/media/playback/sessions/{id}/progress  body（≤16KiB）
{ "position_ms": 0, "duration_ms": 0, "state": "playing" }   // state 可选
// 200 回显完整 session；404 session not found

// POST /api/media/playback/sessions/{id}/stop → 200 { "ok": true, "precache_cancelled": 0 }
// 停止会话并取消该媒体的后台预转码
```

⚠️ **position_ms 只存在内存会话里，不落库** —— 这是当前与 Plex 式「跨设备断点续播」之间唯一的结构性缺口（阅读进度已有持久化，见 3.5）。

### 3.4 文件与流

- `GET /api/media/file?id=&path=` — 原文件直出；`Accept-Ranges: bytes`，支持 Range/206、HEAD、条件请求。越界路径一律 404。
- `GET /api/media/compat?id=&path=&mode=&hw=[&height=][&audio_track=][&sub_track=][&task=][&disc_playlist=]` — 响应头 `X-VaultHub-Compat: live|cache`：live 为实时 fragmented MP4（**不支持 Range/拖动**），cache 为完整产物（支持 Range/拖动）。`sub_track` 设置后强制 full_transcode（图形字幕烧录）。
- `GET /api/media/audio/stream?id=&path=&bitrate=64|96|128|160|192|256|320[&fresh=1]` — MP3 流，支持 Range；拥塞时 503 + `Retry-After: 3`。
- `GET /api/media/weak/probe?kb=8..2048` — `kb*1024` 字节不可压缩随机流，用于实测下行带宽（APP 测速用）。

### 3.5 阅读进度（已持久化，APP 直接复用）

```jsonc
// GET /api/media/reading/progress?id=<libID>
{ "id": "lib1", "items": { "dir/file.cbz": { "progress": 42.5, "page": 12, "total": 200, "updated_at": 1730000000 } } }

// PUT/POST /api/media/reading/progress?id=<libID>&path=<rel>  body（≤8KiB）
{ "progress": 42.5, "page": 12, "total": 200 }   // progress 0-100 服务端钳制；page 0-100000

// DELETE 同 query → { "ok": true, "removed": true|false }（幂等）
```

存储：`/data/media-reading-progress.json`，键 `"<libID>\n<相对路径>"`。**注意 GET 也要求 write 级会话**。漫画页码按前端口径 1 起计数。

### 3.6 漫画/PDF/EPUB 阅读器

- ZIP/CBZ：先 `GET /api/media/archive/zip?id=&path=` 拿 `entries`（自然排序、仅图片，每项含 `name/raw/size/url`）；翻页 = `GET /api/media/archive/zip/page?id=&path=&entry=<raw>[&w=&q=]`（`w=0` 原图，`w>0` JPEG 转码 + immutable 长缓存 + ETag/304）。
- PDF：`GET /api/media/pdf/info` 返回 `{pages, encrypted, page_base}`；页图 `GET /api/media/pdf/page?...&page=<1起>`（越界 404）。
- EPUB：`GET /api/media/document/epub?id=&path=` → `{title, chapters:[{title,text}], count, bytes, truncated}`（纯文本章节，非 XHTML 原文）。
- 封面：`GET /api/media/cover?id=&path=<sidecar相对路径>&v=<mtime秒>[&w=]`（**公开端点**，缩略图带 ETag/304）。

### 3.7 字幕

- `GET /api/media/subtitles/search?id=&path=`（实际由 subtitle-api 服务）→ `{items:[{label,url,provider,...}], count, providers}`；内嵌文本轨的 `url` 指向 extract，图形轨给 `burn_track`（喂给 compat 的 `sub_track`），本地字幕的 `url` 指向 proxy。
- `GET /api/media/subtitles/extract?id=&path=&track=<0起>` → `text/vtt; charset=utf-8`。
- `GET /api/media/subtitles/proxy?id=&path=<字幕文件>` → WebVTT（.srt/.ass/.ssa/.sub 自动转换）。
- `GET /api/media/subtitles/download?url=<必须https>&format=vtt` → 上游字节原样转发（subtitle-api 自身无鉴权）。

---

## 4. 发现的问题与风险（做 APP 前建议决策）

1. **无鉴权端点面比预期大**（按当前代码逐条确认）：
   - `GET /api/media/libraries` — 无需登录即返回全部库配置（**含磁盘路径**）；
   - `GET /api/media/index/status` — 无需登录返回库名与扫描状态；
   - `GET /api/media/probe` — 无需登录可对库内任意文件跑 ffprobe；
   - `GET /api/media/cover`（含缩略）— 完全公开；
   - `GET /api/media/hardware`、`/api/media/scrapers` — 公开返回运行配置快照；
   - subtitle-api 的 `search`/`download` — v1.0.6 起经 `sessionOK()` 探针鉴权（未登录 401；实测生产环境已验证）。
   - 若内网/公网暴露，这是一组可被匿名枚举的面。建议：要么补 `readAuth`，要么在 Caddyfile 里统一加鉴权，并在契约中显式记录最终决定。
2. **播放进度不落库**（见 3.3）：要做「继续观看」需新增持久化端点；建议复用 reading_progress 的存储模式。
3. **`/api/media/subtitles/search` 双注册**：media-go 与 subtitle-api 同路径不同实现，生产以 Caddy 分流为准（subtitle-api 版多了 `providers` 字段与在线源）。契约应只认 subtitle-api 版。
4. **`client` 能力结构是浏览器视角**（mp4/mse/h264/hevc/vp9/aac/opus）：原生播放器需要 av1/dts/truehd/eac3/flac/dolbyVision 等字段——扩展时保持新增字段可选、服务端缺省按 false 处理，即不破坏旧网页端。
5. **兼容流 live 态不支持拖动**（`Accept-Ranges: none`）：APP 端 seek 策略要么等待预转码命中 cache，要么客户端按时间轴重发 compat 请求。
6. **会话 256 条落盘上限**：APP 每台设备一个 Cookie 会话，家庭多设备 + 网页并存时需留意。
7. **别名冗余**：archive/zip 有 4 个注册名、caddyfile 有 2 个 —— v1 契约建议全部保留但标注 canonical，避免 APP 误用。
8. **`/api/session/check` 是隐式跨服务契约**（media-go 只认状态码 200）：改 manager 会话逻辑时必须保住这条约定，建议纳入契约测试。

## 5. 建议的 v1 冻结范围

- **P0（APP MVP，冻结字段名/状态码/语义）**：login、logout、auth/mode、libraries(GET)、files、metadata(+batch)、playback/plan、playback/sessions(+action)、file、compat、streams、audio/stream、weak/probe、reading/progress、archive/zip(+page/cover)、pdf/*、document/epub、cover(GET)、subtitles/search|extract|proxy|download。
- **P1（APP 二期：下载/管理）**：settings、index/*、audio cache/lyrics、override、disc/playlists、tasks/cancel、system/metrics。
- **P2（可变动，APP 不依赖）**：admin/*、scrape-cache、nfo、series/*、tmdb/douban/tvdb、network/speed、audio/metadata(+commit/artist)、cast/avatar、metadata/artwork。
