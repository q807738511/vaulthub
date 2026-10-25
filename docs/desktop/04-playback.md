# 04 · 视频播放：决策、转码、心跳与进度

播放分「决策」与「取流」两步，客户端不要自己猜能不能直连 —— 一律先问服务端。

```
POST /api/media/playback/plan  ──► { layer, mode, url, video_action, audio_action, ... }
                                         │
                    ┌────────────────────┴────────────────────┐
             direct_play                                 smart_stream
        GET {plan.url}（Range/206）              GET {plan.url}（/api/media/compat）
```

## 1. 播放决策

```http
POST /api/media/playback/plan
Content-Type: application/json

{
  "library_id": "lib-movie",
  "path": "Dune.2021.2160p.mkv",
  "quality": "auto",            // auto | original | 1080p | 720p | 480p
  "hardware": "auto",           // auto | cpu | nvenc | qsv | vaapi
  "server_transcode": "auto",   // auto | off（off = 只准直连/重封装，禁转码）
  "network_bps": 8000000,       // 可选：实测下行带宽 bit/s，仅 auto 档用于限高
  "client": { "mp4": false, "mse": true, "h264": true, "hevc": true,
              "vp9": false, "aac": true, "opus": false }
}
```

`client` 描述**本机播放器**能力，不是浏览器能力 —— 客户端要按自己的解码器如实上报：

| 字段 | 含义 |
|---|---|
| `mp4` | 能播 MP4/M4V 封装（大多数桌面播放器为 true） |
| `mse` | 有 MSE 或等价的流式封装拼接能力 |
| `h264` / `hevc` / `vp9` | 视频解码器支持 |
| `aac` / `opus` | 音频解码器支持（MP3 服务端默认视为支持） |

响应：

```json
{
  "layer": "smart_stream", "mode": "remux",
  "reason": "浏览器支持音视频编码，仅转换容器封装",
  "url": "/api/media/compat?id=lib-movie&path=Dune.2021.2160p.mkv&mode=remux",
  "video_action": "copy", "audio_action": "copy",
  "hardware": "auto", "max_height": 0,
  "media": {"container":"mkv","video_codec":"hevc","audio_codec":"truehd",
            "width":3840,"height":2160,"bit_rate":"...","duration":"..."},
  "warn": "禁用服务端转码时该源可能无法播放"
}
```

判决表（`quality=auto`）：

| 条件 | layer / mode | 取流 |
|---|---|---|
| 封装与音视频都兼容 | `direct_play` / `direct` | 原文件，Range 可拖 |
| 编码兼容、封装不兼容 | `smart_stream` / `remux` | `/compat`，视频音频均 copy |
| 视频兼容、音频不兼容 | `smart_stream` / `audio_transcode` | `/compat`，音频转 AAC |
| 视频不兼容 | `smart_stream` / `full_transcode` | `/compat`，转 H.264/AAC |
| 显式 `720p` 且源高 >720（或未知） | `smart_stream` / `full_transcode` | `/compat&height=720` |
| `server_transcode=off` + 原盘 ISO | **409** | 客户端提示需开启转码 |
| `server_transcode=off` + 普通文件 | `direct_play` + `warn` | 原文件；播不了由本地解码器负责 |

`quality=auto` 且带 `network_bps` 时会按带宽限高（<2M → 480p，<6M → 720p，<16M → 1080p）。

## 2. 取流

### 2.1 直连：GET /api/media/file

必须支持 `Range`（边下边播、拖动都靠它）：

```http
Range: bytes=1048576-
HTTP/1.1 206 Partial Content
Content-Range: bytes 1048576-18446744072/18446744073
Accept-Ranges: bytes
```

### 2.2 转码：GET /api/media/compat

| 参数 | 说明 |
|---|---|
| `id`,`path` | 同 plan |
| `mode` | `direct` / `remux` / `audio_transcode` / `full_transcode`（用 plan 里给的，不要自造） |
| `height` | 144–4320，限高转码（显式画质档） |
| `sub_track` | 0–255，**图形字幕**轨序号（burn-in） |
| `audio_track` | 音轨序号 |
| `hw` | 硬件加速偏好 |
| `task` | 可选，任务 ID（传了就登记为可取消任务，`stop` 会话时能中断转码） |

注意两条服务端规则：`mode` 不在 `remux|audio_transcode|full_transcode` 内时按
`audio_transcode` 处理；只要带了 `sub_track`（≥0）就**强制** `full_transcode`（烧录必须重编码）。

响应头决定形态：

```
X-VaultHub-Compat: cache    → 可拖动（Accept-Ranges: bytes，内容为缓存 mp4）
X-VaultHub-Compat: live     → 原生 Range 不可用；拖动要带 ss=<秒> 重新请求（v1.0.8）
```

**cache 与 live 是服务端自动判定的**（同一个 `(库,路径,模式,高,音轨,字幕,硬件)` 组合）：

| 情况 | 响应 | 能否拖动 |
|---|---|---|
| 该组合的可 seek 副本**已完整落盘** | `X-VaultHub-Compat: cache` + `Accept-Ranges: bytes` | 能 |
| 尚未落盘（首次播 / 换画质 / 换音轨 / 开烧录） | `X-VaultHub-Compat: live` + `Accept-Ranges: none`，分块 fMP4 | 只能靠 `ss=`（v1.0.8） |

`live` 播放时服务端会**同时后台转出一份可 seek 的副本**，但这份预转码绑定「有人正在看」：
最后一个观看者断开就会被取消（实测：curl 拉完即断，缓存不会落盘，下次仍是 live）。
因此客户端要拿到 cache 形态，前提是**播放期间保持播放会话与连接**。

推荐策略（v1.0.8 起 live 也能拖，别再提示「稍后可拖动」）：

1. 起播按 plan 给的 URL 请求，读 `X-VaultHub-Compat` 决定走哪条 seek 路径；
2. **live 的拖动 = 带 `ss=<秒>` 重新请求**：`GET <url>&ss=173`，服务端从第 173 秒重新起转码
   （关键帧快 seek），响应头 `X-VaultHub-Seek-Start: 173.000` 回显起点；
   - 输出时间戳从 0 开始，客户端要自己记 `offset = ss`，把 `offset + currentTime` 当显示时间；
   - 时长用 plan 里的 `media.duration`（整片秒数）—— live 流的 `video.duration` 只是已到达的
     分片长度（实测 30 秒片子拿到 10.4），拿它当进度条上限会得出错误的可拖范围；
   - 拖动过程中只更新 UI，**松手时**才发一次 `ss` 请求，避免每个像素重起一次 ffmpeg；
3. `cache` 形态（完整文件）用原生 `currentTime`/Range 拖动即可，`ss` 会被忽略；
4. 同一部片子第二次打开通常直接 `cache`（前提是上次有完整观看会话，预转码跑完了）；
5. 切画质 / 换音轨 / 开字幕烧录都会改变缓存键 → 重新进入 `live`，这是预期行为，不要当 bug；
6. 服务端可用 `COMPAT_PRECACHE=0` 关掉预转码（部署方决定），此时永远拿不到 cache ——
   靠 `ss` 拖动依然可用，只是每次 seek 都会重新起一次转码。

参考实现（网页播放器，`web/js/02-media.js`）：`videoIsLiveStream()` 判断形态、
`videoTimelineDuration()` / `videoAbsoluteTime()` 做时间坐标、`restartLiveStream(video, t)` 带 `ss`
重开流、`seekVideoTo()` 给点击/拖动/±10 秒/键盘统一入口。

## 3. 播放会话（重要，别跳过）

建会话的目的：让服务端知道「这台设备正在用这个转码任务」，并驱动预转码与资源回收。

```http
POST /api/media/playback/sessions
{"library_id":"lib-movie","path":"Dune.2021.2160p.mkv","mode":"remux"}

200 {"id":"<32 hex>","library_id":"lib-movie","path":"...","mode":"remux",
     "state":"playing","position_ms":0,"duration_ms":0,"updated_at":1792729110000}
```

- 会话上限 **64 个**，超出 `429 too many playback sessions`。
- **心跳**：每 ≤2 分钟必须发一次，否则会话被 GC，关联转码任务被取消：

```http
POST /api/media/playback/sessions/{id}/progress
{"position_ms":321000,"duration_ms":1800000,"state":"playing"}   // state: playing|paused|ended
```

- 结束：`POST /api/media/playback/sessions/{id}/stop` → `{"ok":true,"precache_cancelled":0}`；
  重复 stop → `404 session not found`（幂等处理，忽略即可）。
- 播放器关闭/切集时务必 stop，否则预转码会继续吃 CPU 直到 GC。

## 4. 进度持久化（继续观看）

会话进度是**内存态**（2 分钟 GC）；跨设备/重启用这个端点：

```http
PUT /api/media/playback/progress?id=lib-movie&path=Dune.2021.2160p.mkv
{"position_ms":321000,"duration_ms":1800000}

200 {"position_ms":321000,"duration_ms":1800000,"completed":false,"updated_at":1792816971}
```

```http
GET /api/media/playback/progress?id=lib-movie
200 {"id":"lib-movie","items":{"Dune.2021.2160p.mkv":{"position_ms":321000,...}}}
```

- 服务端钳制 `position ≤ duration`；时长已知且 ≥95% 自动 `completed:true`。
- 客户端恢复策略建议：`completed` 不续播；离结尾不足 15 秒不续播；用户手动「从头上看」时
  再 `DELETE` 该条（或直接 `PUT 0`）。
- 写入节律：15–30 秒一次 + 暂停/结束/关闭时各一次。不要每帧写。

## 5. 字幕

1. `GET /api/media/streams?id=&path=` 取轨道；
2. 文本轨：`GET track.url` 拿 WebVTT，自己渲染；
3. 图形轨：把 `track.burn_track` 作为 `sub_track` 传给 `/api/media/compat`
   （只有走转码流时才能烧录；`direct_play` 看到的画面没有字幕，客户端需提示用户切画质）。

## 6. 音频播放

```
GET /api/media/audio/stream?id=lib-music&path=Album/01.flac&bitrate=320k
```

- `bitrate` 白名单 `96k|128k|192k|256k|320k`，不在白名单 → 400。
- 支持 `Range`；拥塞 → `503` + `Retry-After: 3`（客户端应暂停重试，不要狂刷）。
- 同一文件不同 `bitrate` 各自缓存，切换档位会触发一次转码，切档前先提示。

## 7. 自检清单（播放器接入完跑一遍）

- [ ] 4K HEVC + TrueHD 的 mkv：`client.hevc=false` → `smart_stream/remux`，能播、能拖（cache 命中后）
- [ ] 同一文件 `client.hevc=true` + `quality=original` → `direct_play`，`Range` 生效
- [ ] 选 720p → `full_transcode` 且 URL 带 `height=720`
- [ ] 暂停 3 分钟再播：会话已 GC（progress 404），客户端自动重建会话
- [ ] 播 30 秒后杀进程重开：`GET playback/progress` 能读回进度并提示继续
- [ ] 图形字幕（PGS）选轨 → `sub_track` 生效，画面有字幕
- [ ] 关闭播放器 → `stop` 发出，服务端转码任务停止（`/api/system/metrics` CPU 回落）
