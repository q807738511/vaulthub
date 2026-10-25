# 03 · API 参考（P0）

所有路径都相对 `http://<vault-hub-host>:8088`。除标注「公开」外均需
`Cookie: vh_session=...`。JSON 错误恒为 `{"ok":false,"error":"..."}`。

---

## 1. 认证

### GET /api/auth/mode — 公开

```json
{"ok":true,"mode":"password","username":"admin","has_password":true,
 "must_change":false,"session_default_days":30,"session_long_days":60}
```

`mode: "open"` 表示免密模式（任意凭据可登录）。客户端可用它做「记住用户名」的默认值。

### POST /api/login — 公开

```http
POST /api/login
Content-Type: application/json

{"username":"admin","password":"***","keep_days":30}
```

```http
HTTP/1.1 200 OK
Set-Cookie: vh_session=<48 hex>; Path=/; HttpOnly; SameSite=Lax
Content-Type: application/json

{"ok":true,"idle_timeout_seconds":2592000,"session_days":30,"must_change":false}
```

- `keep_days >= 60` → 60 天，其余 → 30 天（滑动续期）。
- 失败：`401 invalid credentials`；5 次/5 分钟 → `429 too many login attempts`。
- `must_change:true` 时后续只能访问 `/api/account`，需先改密。

### POST /api/logout — 公开（带 Cookie 时吊销之）

`{"ok":true}`，并下发过期 Cookie。

---

## 2. 库与文件

### GET /api/media/libraries

```json
{"libraries":[
  {"id":"lib-movie","name":"电影","type":"movie","path":"/media/movies"},
  {"id":"lib-book","name":"书房","type":"book","path":"/media/books","paths":["/media/books2"]}
]}
```

`type`：`movie` / `series` / `audio` / `musicvideo` / `book` / `comic`。
`paths` 是扩展路径（多存储），扫描时按相对路径合并。

> 自 v1.0.7 起需会话；未登录 401（此前匿名可读且含磁盘路径）。

### GET /api/media/files

| 参数 | 说明 |
|---|---|
| `id` | 库 ID（必填） |
| `limit` | 每页条数，默认 200，最大 1000 |
| `offset` | 偏移 |

```json
{"files":[{"path":"Dune.2021.2160p.mkv","size":18446744073,"mtime":1792729110}],
 "total":612,"has_more":true,"limit":200,"offset":0,
 "status":"ready","version":"55023c13a8e3f183ea1d0ab06f82e6db"}
```

- `status`：`ready` / `indexing`；索引中时结果可能不完整，客户端应轮询或显示进度。
- `version`：索引版本，变了说明有文件增删，应清空本地列表缓存并重拉。
- `path` 是**相对库根**的路径，后续所有接口都用它原样回传。

### GET / HEAD /api/media/file

| 参数 | 说明 |
|---|---|
| `id` / `path` | 库 + 相对路径 |

直接返回文件字节，支持 `Range`：

```http
GET /api/media/file?id=lib-movie&path=Dune.2021.2160p.mkv
Range: bytes=0-1048575

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1048575/18446744073
Accept-Ranges: bytes
```

带 `If-None-Match` 可拿到 `304`（ETag 由文件 mtime+size 派生）。
越界路径（`../`、绝对路径、反斜杠）→ `404 invalid media path`。

### GET /api/media/cover

| 参数 | 说明 |
|---|---|
| `id` / `path` | 指向**图片文件本身**（同目录 sidecar，如 `Dune.2021.2160p.jpg`） |
| `w` | 可选，缩略宽度（列表建议 `320`，详情 `640`） |

返回图片字节，`ETag`/`304` 可用。找不到 → `404 cover not found`。
**该端点保持公开**（分享场景依赖直链），但需知道库 ID 与 sidecar 路径。

---

## 3. 播放（详见 04 篇）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/media/playback/plan` | 播放决策，返回 `layer/mode/url/...` |
| GET | `/api/media/compat` | 转码流（`live` 或 `cache`，见响应头 `X-VaultHub-Compat`） |
| POST | `/api/media/playback/sessions` | 建会话（转码任务 + 心跳） |
| POST | `/api/media/playback/sessions/{id}/progress` | 心跳 |
| POST | `/api/media/playback/sessions/{id}/stop` | 结束（返回 `precache_cancelled`） |
| GET/PUT/DELETE | `/api/media/playback/progress` | 播放进度（继续观看） |

### GET /api/media/streams

```json
{"audio_tracks":[{"index":0,"stream_index":1,"label":"国语 · zh"}],
 "subtitle_tracks":[
   {"index":0,"label":"简体中文","codec":"subrip","language":"zh","pid":"","kind":"text",
    "text":true,"burn_in":false,"stream_index":3,
    "url":"/api/media/subtitles/extract?id=lib-movie&path=...&track=0"},
   {"index":1,"label":"中文 PGS","codec":"hdmv_pgs_subtitle","language":"zh","pid":"","kind":"bitmap",
    "text":false,"burn_in":true,"stream_index":4,"burn_track":1}
 ]}
```

- 文本轨（srt/ass）→ 用 `url` 拿 WebVTT；**图形轨（PGS/DVD）不能转文本**，
  只能把 `burn_track` 传给 `/api/media/compat` 由服务端烧录进画面。
- `index` 是「同类轨序号」（喂给 `sub_track`/`audio_track`），`stream_index` 是 ffprobe 原始索引。

---

## 4. 字幕

| 端点 | 参数 | 返回 |
|---|---|---|
| `GET /api/media/subtitles/search` | `id`,`path` | 同目录字幕文件列表 +（若配置）在线源结果 |
| `GET /api/media/subtitles/extract` | `id`,`path`,`track` | `text/vtt` 文本字幕 |
| `GET /api/media/subtitles/download` | `url`（仅 https） | 代理下载字幕文件（预览/落地用） |

三者均需会话（v1.0.6 起 subtitle 服务经 `sessionOK` 探针校验）。

---

## 5. 音频

### GET /api/media/audio/stream

| 参数 | 说明 |
|---|---|
| `id`,`path` | 音频文件 |
| `bitrate` | 白名单：`96k` `128k` `192k` `256k` `320k`（也接受 `96` 形式） |
| `fresh` | `1` 时忽略缓存重新转码 |

返回 `audio/mpeg` 流，支持 `Range`；转码拥塞时 `503` + `Retry-After: 3`。
`bitrate` 不在白名单 → `400 invalid bitrate`。

其它音频端点（歌词 `audio/lyrics`、元数据 `audio/metadata`）属 P1，见 openapi。

---

## 6. 阅读

### GET/PUT /api/media/reading/progress

```
GET  ?id=<lib>                    → {"id":"lib-book","items":{"书.epub":{"progress":42.5,"page":12,"total":200,"updated_at":...}}}
PUT  ?id=<lib>&path=<rel>  {"progress":42.5,"page":12,"total":200}
DELETE ?id=<lib>&path=<rel>       → {"ok":true,"id":..,"path":..,"removed":true|false}
```

服务端钳制：`progress` 0–100、`page` 0–total；越界值被夹紧，`NaN` → 400。
（历史原因：读端点同样要求写级会话，客户端按普通会话调用即可。）

### GET /api/media/document/epub

```json
{"title":"三体","chapters":[{"title":"第一章","text":"..."}],
 "count":42,"bytes":812345,"truncated":false}
```

`truncated:true` 表示书过大被截断（服务端上限），客户端应提示。

### GET /api/media/pdf/info | pdf/page | pdf/cover

```
/api/media/pdf/info?id=&path=            → {"pages":318,"encrypted":false,"page_base":"/api/media/pdf/page?id=..&path=.."}
/api/media/pdf/page?id=&path=&page=3&w=1600&q=85   → JPEG 页图
/api/media/pdf/cover?id=&path=           → 封面 JPEG
```

`pages` 为页数；`encrypted:true` 时页面渲染会失败，客户端应给出明确提示。

### GET /api/media/archive/zip | zip/page | zip/cover

```
zip       : ?id=&path=            → {"entries":[{"name":"第01话","raw":"001.jpg","size":812345,
                                     "url":"/api/media/archive/zip/register?id=..&path=..&entry=001.jpg"}],"total":120}
zip/page  : ?id=&path=&entry=001.jpg&page=1   → 单页图片
zip/cover : ?id=&path=                        → 封面图
```

`entries` 已按自然序（2 在 10 之前）排好，直接当页序用。

---

## 7. 分页与缓存约定

- 列表统一 `limit`/`offset`，响应里有 `total` 与 `has_more`。
- 二进制响应带 `ETag`，二次请求用 `If-None-Match` 可省流量（`304`）。
- 所有 JSON 响应带 `Cache-Control: no-store`，**不要**在前端做 HTTP 缓存层；
  需要缓存就缓存解析后的结构，并用 `version` 失效。
