# VaultHub API 契约测试清单

> 目的：把「移动 APP 与网页共同依赖的稳定面」变成可回归的测试。
> 契约的范围 = 路径、HTTP 方法、鉴权要求、状态码、请求/响应 JSON 字段名（语义变更另计）。
> 配套：[ROUTE_INVENTORY.md](ROUTE_INVENTORY.md)（路由全表与字段详情）、[openapi.yaml](openapi.yaml)（规范草稿）。

---

## 0. 分层与落地方式

| 层 | 形式 | 依赖 | 对接现有体系 |
|---|---|---|---|
| L1 静态契约 | 读源码断言（路由注册串、JSON tag、错误文案存在） | 无（不跑服务） | 沿用 `tests/vXXXX_contract.py` 风格，纯 Python 文本断言 |
| L2 运行时契约 | 对运行实例发真实请求 | docker compose 起容器 + 测试夹具 | 沿用 `tests/test_*.py` 行为测试风格，建议新增 `tests/test_api_contract_p0.py` |

- L2 需要注入 `ADMIN_USERNAME/ADMIN_PASSWORD`，并在 `tests/fixtures/` 准备最小媒体夹具（1 个 mp4、1 个 mkv/hevc、1 个 cbz、1 个 pdf、1 个 epub、1 个带 .srt 的视频目录）。
- 进阶：CI 里用 [schemathesis](https://github.com/schemathesis/schemathesis) 拿 openapi.yaml 对运行实例做模糊校验，用 [oasdiff](https://github.com/oasdiff/oasdiff) 在 PR 里检测破坏性变更（Python 侧已有测试基建）。

## 1. 通用断言（每个鉴权端点共享）

- **GEN-01** 无 Cookie 访问 → `401` + `{"ok": false, "error": "login required"}`
- **GEN-02** 所有 JSON 响应 `Content-Type: application/json`，且 writeJSON 路径带 `Cache-Control: no-store`
- **GEN-03** 错误 envelope 恒为 `{ok:false, error:string}`（无额外包装层）
- **GEN-04** 错误文案 `login required`、`invalid media path`、`library not found`、`file not found` 属于契约字符串，改动即破坏 APP

## 2. P0 运行时矩阵 — 认证（manager）

| ID | 断言 |
|---|---|
| AUTH-01 | `POST /api/login` 正确凭据 → 200，`Set-Cookie: vh_session=<48位hex>; Path=/; HttpOnly; SameSite=Lax` |
| AUTH-02 | 登录响应字段齐全：`ok` / `idle_timeout_seconds` / `session_days(30|60)` / `must_change` |
| AUTH-03 | `keep_days>=60` → `session_days=60`；其余（含缺省）→ 30 |
| AUTH-04 | 错误密码 → 401 `invalid credentials`；一次性初始密码二次使用 → 同样 401 |
| AUTH-05 | 同 IP 连续 5 次失败 → 429 `too many login attempts`（成功登录清零） |
| AUTH-06 | `POST /api/logout` 后，旧 Cookie 访问 `/api/media/files` → 401 |
| AUTH-07 | `GET /api/auth/mode` 无需登录 → 200，含 `mode/username/has_password/must_change` |
| AUTH-08 | 容器重启后旧 Cookie 仍有效（sessions.json 持久化；会话表 ≤256 条） |
| AUTH-09 | `GET /api/session/check` 从非回环地址 → 403 `loopback only`（跨服务契约：media-go 只认 200） |
| AUTH-10 | must-change 受限会话：`/api/media/files` → 401，`/api/account` → 200 |

## 3. P0 运行时矩阵 — 播放（media-go）

| ID | 断言 |
|---|---|
| PLAY-01 | plan 上报全兼容 client（mp4+h264+aac）配 mp4 源 → `layer=direct_play`、`mode=direct`、`url` 以 `/api/media/file?id=` 开头 |
| PLAY-02 | client.hevc=false + hevc/mkv 源 → `layer=smart_stream`、`mode ∈ {remux, audio_transcode, full_transcode}`、`url` 以 `/api/media/compat?` 开头 |
| PLAY-03 | `quality=720p` 且源高 >720（或未知）→ `full_transcode` + url 带 `&height=720` |
| PLAY-04 | `network_bps`：<2Mbps→480p、<6Mbps→720p、<16Mbps→1080p、≥16Mbps 不限（auto 档） |
| PLAY-05 | `server_transcode=off` + 原盘 ISO → **409**；普通文件 → direct + `warn` |
| PLAY-06 | 创建会话 → `id` 匹配 `^[0-9a-f]{32}$`、`state=playing`、`updated_at` 为 Unix 毫秒 |
| PLAY-07 | progress 上报 `{position_ms, duration_ms, state}` → 200 回显同值且 `updated_at` 前移 |
| PLAY-08 | stop → `{ok:true, precache_cancelled:int}`；重复 stop → 404 `session not found` |
| PLAY-09 | action 非法（如 `pause`）→ 404 `session action not found` |
| PLAY-10 | 会话 >2 分钟无心跳后被 GC（progress → 404）且关联转码任务被取消 |
| PLAY-11 | `GET /api/media/file` 带 `Range: bytes=0-1023` → **206** + `Content-Range` |
| PLAY-12 | path 越界（`../`、绝对路径、反斜杠）→ 404；不存在的库 → 404 |
| PLAY-13 | compat 响应头 `X-VaultHub-Compat ∈ {live, cache}`；live 形态 `Accept-Ranges: none` |
| PLAY-14 | streams：文本字幕轨含 `url`（指向 extract），图形轨（PGS/DVB）含 `burn_track`、无 `url` |
| PLAY-15 | `audio/stream`：`bitrate=96k` → 200 `audio/mpeg`；`bitrate=100` → 400；拥塞 → 503 + `Retry-After: 3` |
| PLAY-16 | `weak/probe?kb=64` → 65536 字节 + 头 `X-Vaulthub-Probe-Bytes: 65536`；`kb=4` → 400 |

## 4. P0 运行时矩阵 — 阅读（media-go）

| ID | 断言 |
|---|---|
| READ-01 | PUT progress `{progress:42.5, page:12, total:200}` → GET 整库回读一致 |
| READ-02 | progress 越界（150 / -1 / NaN）→ 150 钳到 100、-1 钳到 0、NaN → 400 |
| READ-03 | DELETE 幂等：首次 `removed:true`，再次 `removed:false`（均 200） |
| READ-04 | 容器重启后进度仍在（`/data/media-reading-progress.json` 持久化） |
| READ-05 | archive/zip entries：仅图片扩展名、自然排序（`img2` 先于 `img10`）、每项含 `name/raw/size/url` |
| READ-06 | archive page `entry=<raw>&w=400` → 200 图片 + `X-Vaulthub-Page-Cache` 头；`w=10` → 400 |
| READ-07 | pdf `page=1` → 200 JPEG；`page=0` / `page>pages` → 404；`pdf/info` 的 `page_base` 可直接拼 `&page=N` |
| READ-08 | epub → `chapters[]` 每项含 `title/text`，`truncated` 字段存在 |
| READ-09 | cover：公开访问 200；缩略（w>0）带 `ETag`，`If-None-Match` 命中 → 304 |
| READ-10 | 漫画页码语义：Web 前端按 **1 起**计数（契约文档化，服务端只钳 0≤page≤total） |

## 5. P0 运行时矩阵 — 字幕 / 库 / 元数据

| ID | 断言 |
|---|---|
| SUB-01 | `subtitles/search` → 200 且 `providers` 数组至少含 `embedded`、`local` |
| SUB-02 | `subtitles/download` `url=http://...` → 400（**必须 https**）；`url` 缺失 → 400 |
| SUB-03 | `subtitles/extract?track=0` → `Content-Type: text/vtt; charset=utf-8`，正文以 `WEBVTT` 开头 |
| SUB-04 | `subtitles/proxy` 指向 .srt → 成功转 VTT；指向 .txt → 400 `unsupported subtitle format` |
| LIB-01 | `libraries` GET → `{libraries:[{id,name,type,path}]}`，type 枚举六类 |
| LIB-02 | files 分页：`offset/limit/has_more` 语义正确；`q` 忽略大小写子串过滤 |
| LIB-03 | files 响应带 `ETag`，`If-None-Match` 命中 → **304 无 body** |
| LIB-04 | `metadata?id&path` → 含 `title/genres/cast/poster/watched` 字段（海报墙与详情页数据源） |
| LIB-05 | `metadata/batch` ≤500 条 → `{items: {<path>: metadata}}`，非法 path 静默跳过 |

## 6. L1 静态契约检查（无服务运行，纯源码断言）

沿用 `vXXXX_contract.py` 的做法，对以下字符串/结构做存在性断言（示例）：

```python
MEDIA = (ROOT / "media-go" / "main.go").read_text(encoding="utf-8")
PLAYBACK = (ROOT / "media-go" / "playback.go").read_text(encoding="utf-8")
MANAGER = (ROOT / "manager" / "main.go").read_text(encoding="utf-8")

# 路由注册面（新增/改名必须显式改契约文档）
check("playback plan 路由", 'mux.HandleFunc("/api/media/playback/plan"' in MEDIA)
check("播放会话路由", 'mux.HandleFunc("/api/media/playback/sessions/"' in MEDIA)
check("阅读进度路由", 'mux.HandleFunc("/api/media/reading/progress"' in MEDIA)

# 关键 JSON tag（APP 逐字依赖）
check("能力上报字段", all(t in MEDIA for t in ['json:"mp4"', 'json:"mse"', 'json:"h264"',
      'json:"hevc"', 'json:"vp9"', 'json:"aac"', 'json:"opus"']))
check("plan 响应字段", all(t in MEDIA for t in ['json:"layer"', 'json:"mode"', 'json:"url"',
      'json:"video_action"', 'json:"audio_action"']))
check("进度字段", all(t in PLAYBACK for t in ['json:"position_ms"', 'json:"duration_ms"', 'json:"state"']))
check("画质枚举", "480p" in PLAYBACK and "original" in PLAYBACK)
check("会话上限 64", "too many playback sessions" in PLAYBACK)
check("心跳 2 分钟", "-2 * time.Minute" in PLAYBACK)  # v1.0.7 勘误：源码写作 `-2 * time.Minute`（playback.go GC cutoff）

# 跨服务契约：media-go 只认 manager 的 200
check("回环校验", "/api/session/check" in MEDIA and "StatusCode == http.StatusOK" in MEDIA)
check("错误文案", '"error": "login required"' in MEDIA)
```

## 7. 安全回归清单（当前无鉴权面 —— 任何变更必须显式决策）

以下端点按当前源码**无需登录**即可访问。若日后补鉴权属于契约变更，需同步更新 openapi.yaml 与 APP；若维持现状，也应有测试固化「这是有意的」：

| 端点 | 当前行为 | 风险点 |
|---|---|---|
| GET /api/media/libraries | 匿名返回全部库配置 | **泄露磁盘路径** |
| GET /api/media/index/status | 匿名返回库名/扫描状态 | 泄露库名与文件规模 |
| GET /api/media/probe | 匿名 ffprobe 任意库内文件 | 元数据枚举 + CPU 消耗 |
| GET /api/media/cover | 完全公开（可能服务于分享场景） | 图片资源匿名可拉 |
| GET /api/media/hardware、/api/media/scrapers | 匿名返回运行配置快照 | 基础设施信息泄露 |
| GET /api/media/subtitles/search、/download（subtitle-api） | 服务自身零校验 | download 是开放 https 抓取代理（SSRF 面：仅限 https 任意目标，≤8MiB） |

建议新增测试 `SEC-01~06`：对上述端点断言「无 Cookie 时的当前行为」，使任何变化（收紧或放宽）都会在测试里显式失败一次。

## 8. 优先顺序建议

1. 先写 L1 静态契约（半天级，立刻防住字段改名/路由漂移）。
2. 再写 P0 运行时矩阵（认证 + 播放 + 阅读三节，覆盖 APP MVP 依赖）。
3. P1/P2 端点（settings、index/*、刮削面、admin/*）在 APP 对应功能立项时补。
4. openapi.yaml 进 CI 做 diff（oasdiff breaking 检查），作为人工评审的兜底。
