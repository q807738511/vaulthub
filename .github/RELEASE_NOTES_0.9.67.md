# VaultHub 蜀鼠之家 v0.9.67：漫画阅读器重构 · 音乐歌词刮削与元数据缓存

v0.9.67 包含两块相对独立的改造：**漫画阅读器**（用户反馈「缓存太慢，好像还是调用的浏览器自带 PDF 阅读器」）
与**音乐歌词刮削 / 刮削源扩展 / 服务端元数据缓存**。全部改动都落在 VaultHub 单容器内部，**不新增任何容器**。

---

## 一、漫画阅读器重构

### 1.1 先说结论：慢在哪（实测，不是猜测）

用户反馈的「像在用浏览器自带 PDF 阅读器」只对 PDF 成立（`02-media.js` 里 PDF 走 `<iframe>`，
确实是浏览器自带阅读器），但真实漫画库 `/MH` 是 **415 个 zip / 237 张封面图 / 1 个 pdf**，
主库走的是「逐页 `<img loading="lazy">`」路径。用探针（与 `media-go` 同一条 `archive/zip`）实测一本 918MB 归档：

| 指标 | 实测值 |
|---|---|
| 归档大小 / 页数 | 918.38 MB / 261 页 |
| 平均每页（解压后） | **3.53 MB** |
| 归档真实格式构成 | **PNG 248 页（95.0%） + JPEG 13 页** |
| 打开 + 解析中央目录（冷 / 热） | 46.2 ms / **0.2 ms**（v0.9.56 的 LRU 已生效） |
| 单页解压（服务端成本） | **33.1 ms/页** |

**所以瓶颈不是解压、也不是 PDF 阅读器**，而是「每页 1.5–3.8MB 原图 + 零预取 + 页面缓存仅 1 小时 +
PNG 无损存档未转码」。据此设计了两层改造。

### 1.2 新增服务端按页转码与首图端点

- `GET /api/media/archive/zip/page?id=&path=&entry=&w=&q=`
  - `w=0`（默认）→ 与旧端点 `archive/zip/register` **行为完全一致**（原样直出）；
  - `w>0` → 解码 → 面积平均降采样 → JPEG 重编码 → **内容寻址磁盘缓存**后下发；
  - 缓存键 `sha1(libId|归档路径|条目|size|mtime|w|q)`，归档一改键即变化（天然不脏数据）；
  - 命中即 `Cache-Control: public, max-age=31536000, immutable` + `ETag`，支持条件请求；
  - 同键并发用进程内 singleflight 合并，避免同一页被并发解码多次；
  - **任何不确定情况一律回落原样直出**（解码失败、像素 >64M、条目 >96MB、转码后反而更大），保证「永远能读」；
  - 响应头 `X-Vaulthub-Page-Cache: hit|miss|off` 便于排障。
- `GET /api/media/archive/zip/cover?id=&path=&w=`（默认 320）→ 归档**第一页缩略图**，供书架卡片当封面。
- 编码策略：**纯 Go 标准库**实现（无第三方依赖、无 cgo）。实测 Go 标准库**没有 WebP 编码器**，
  官方镜像里也没有 `cwebp/magick/convert/ffmpeg/vips`，因此本期输出 JPEG(q82)；WebP 留作后续可选。

实测体积与耗时（真实归档样本）：

| 目标参数 | 单页体积 | 耗时/页（首次） |
|---|---|---|
| 原图直出（w=0） | 1.47–3.75 MB | 33 ms（解压） |
| w=1600 q82 | 0.74–1.03 MB（**39%–56%**） | 370–410 ms（转码，之后命中磁盘缓存 0 成本） |
| w=1280 q78 | 0.40–0.47 MB（**26%**） | ~295 ms |

整本 261 页预估传输：**918 MB → 约 56–95 MB**。

### 1.3 阅读器功能

- **预取窗口**：单页/双页模式常驻当前页 ±3 页（双页 ±6），`fetchPriority=low` 后台预热 → 翻页不等网络；
- **三种模式**：单页 / 双页（見開き）/ 条漫（连续滚动）；
- **阅读方向**：右起（日漫，默认）/ 左起；双页时按方向排布，点击左右半屏语义随之反转；
- **适应方式**：适宽 / 适高 / 原始；工具栏自动隐藏（3 秒无操作淡出，移动鼠标或触摸唤醒）；
- **页码进度**：阅读进度从「滚动百分比」升级为**按页码**记录（`page`/`total` 随进度一起落库），
  旧数据自动按 `total` 换算，书架卡片仍沿用百分比显示；
- **页码跳转**：工具栏页码输入框回车即跳转；
- **键盘**：`←/→`、`PgUp/PgDn`、空格、`Home/End`（输入框内不劫持）；
- **省流模式**：`省流·自动 / 开 / 关`。自动模式下仅在 `navigator.connection.saveData` 或 2g/3g 时启用转码；
  **局域网/4g 默认关闭**——因为原图直出更快（服务端只需 33ms 解压），转码只在弱网才有净收益。

### 1.4 为什么没有引入第三方阅读器组件

调研了常被推荐的几个方案，结论是**都不适合本项目的约束**（不新增容器 + 真正解决慢）：

| 方案 | 核实结果 | 结论 |
|---|---|---|
| Comic-Reader | 无同名权威项目（能力实为 zip.js/JSZip 解包） | 不采纳 |
| PageFlip / StPageFlip | 真实（MIT，3D 翻页） | 仅动画，解决不了单页 3.5MB 传输 |
| Simple Comic Viewer | 无同名权威项目；最接近的是 `tokagemushi999/manga-viewer` | 值得参考手势/双页实现 |
| Smanga / Kavita | 真实，但都是**独立服务**（要新增容器） | 违反约束 |
| NowenReader | 未查到该项目 | 不采纳 |

---

## 二、音乐歌词刮削 · 刮削源扩展 · 元数据缓存

### 2.1 现状问题（代码实证）

刮削是**服务端代理**（`/api/media/audio/metadata`），源链原本为 `iTunes(TW/US) → MusicBrainz`，
返回 `{title, artist, album, cover, provider}` —— **没有歌词字段**；且元数据只存浏览器 localStorage，
换浏览器/清缓存即全丢并重新联网刮削。歌词此前**连「同名 .lrc」和「内嵌标签」都读不到**。

### 2.2 歌词识别（本地优先，零网络）

新增 `media-go/audio_lyrics_local.go`：

1. 同目录 `<名>.lrc`（大小写不限）优先；
2. MP3 内嵌 **ID3v2 USLT**；
3. FLAC/OGG **Vorbis comment `LYRICS` / `UNSYNCEDLYRICS`**；
4. M4A/MP4 **`©lyr` 原子**；
5. 文本编码按标签编码字节与 BOM 判定（UTF-8 / UTF-16LE/BE / Latin-1），避免中文歌词乱码。

### 2.3 在线歌词源链（含真实可达性实测）

| 源 | 实测（从生产容器直连） | 采用 |
|---|---|---|
| **LRCLIB** `/api/get` | 200 / 0.85s，返回 `syncedLyrics` + `plainLyrics` | ✅ 主源 |
| LRCLIB `/api/search` | 中文检索首次 **503**，重试即命中（`稻香/周杰倫`） | ✅ 主源（带指数退避 ≤3 次） |
| lyrics.ovh | 英文 200/0.9s；**中文 404** | ✅ 纯文本兜底（英文向） |
| **NetEase（未公开接口）** | 200 / 0.14s，带时间轴歌词 + `tlyric` 翻译 | ⚠️ **默认关闭**，`VAULTHUB_LYRICS_NETEASE=1` 开启 |
| api.synclrc.com | **完全不可达** | ❌ 不采纳 |
| geci.me | 301，旧 API 已失效 | ❌ 不采纳 |
| Deezer | 从 NAS **超时 12s** | ❌ 不采纳 |

源序：**本地 → LRCLIB(get/search) → lyrics.ovh →（可选）NetEase**；全局节流 ≥900ms/次，
对 503/429 指数退避；无效内容（「暂无歌词」「纯音乐」、去除时间轴后无正文）会被过滤，不会写入。

### 2.4 歌词填充与持久化

- 命中后写入媒体库**同目录 `<名>.lrc`**（原子写：临时文件 + rename，0644）——
  **不改音频文件内嵌标签**：重写原文件风险高（大文件重排、失败即损坏），而 `.lrc` 是行业通用格式
  （Navidrome/Emby/Plex 同规则），删除即回滚；
- 写入路径必须通过既有媒体库白名单校验（与封面落盘同一套），拒绝越界；
- 播放器播放某曲时若其无歌词，自动补一次（本次会话每曲仅一次，失败静默）；
- 「手动适配歌曲信息」弹窗新增 **🎵 在线刮削歌词** 与 **🎼 批量刮削本库歌词**（每批 ≤50 首）按钮；
- 歌词来源在界面标注（本地 .lrc / 内嵌标签 / LRCLIB / lyrics.ovh / 网易云 / 手动）。

### 2.5 刮削源扩展（提高命中率）

- `scrapeAudio` 源链扩为：**iTunes → MusicBrainz →（可选）NetEase 搜索**；
- MusicBrainz 命中但无封面时，按 release MBID 补 **Cover Art Archive** 封面直链；
- 网易云源默认关闭（未公开接口可能变更/封禁、存在 ToS 争议），开启方式 `VAULTHUB_LYRICS_NETEASE=1`。

### 2.6 服务端元数据缓存（sqlite）

- 新表 `audio_metadata(lib, path, size, mtime, title, artist, album, cover, lyrics, lyrics_source, provider, checked_at)`，
  复用项目已有的 `modernc.org/sqlite`（**无新依赖**）；
- 读取时 `LEFT JOIN files` 比对 **size + mtime**：文件一改即视为过期不返回（避免读到旧元数据）；
- 前端启动先读整库缓存（毫秒级），只对未命中项发刮削请求 → 换浏览器/清缓存后不再重复联网；
- 歌词单条上限 64 KB。

新增端点：

```
GET    /api/media/archive/zip/page     按页（可选转码）读取
GET    /api/media/archive/zip/cover    归档首图缩略图（书架封面）
GET    /api/media/audio/lyrics         歌词刮削（本地优先，save=1 落盘 .lrc）
POST   /api/media/audio/lyrics/batch   批量歌词（≤200/批，服务端串行节流）
GET    /api/media/audio/cache          整库元数据缓存（已按 size+mtime 过滤过期）
POST   /api/media/audio/cache          单条写入
GET    /api/media/audio/cache/stats    缓存规模与歌词源列表
```

---

## 三、安全与稳健性

本节部分条目来自**独立安全审查**（发布前的第三方复审），发现即修，并补了回归测试：

1. **转码全局并发闸门**：原实现只靠「同键合并」（singleflight），不同页面并发到达时不合并 ——
   审查实测 64M 像素源图单次转码可分配 **~255MiB**，并发请求可打爆容器内存。
   现改为：像素上限 64M → **16M**（≈4000×4000，仍覆盖 4K 扫描页），并加全局闸门
   `min(3, max(2, NumCPU/2))`，队列等待超过 8s 或客户端断开则**放弃转码、回落直出**。
2. **页面缓存不再「自淘汰」**：配额小于单页体积时，`put` 曾把自己刚写入的文件淘汰掉却返回成功，
   调用方随后按缓存路径下发 → 用户拿到 **404**。现保护刚写入的条目，且缓存文件不可读时
   **回落原样直出**而不是报错。
3. **条件请求精确匹配**：`If-None-Match` 原用子串包含判断，形如 `"other<key>junk"` 的无关标签
   会被误判命中并返回 304（客户端永远拿不到页面）。现按 RFC 9110 解析实体标签并精确比较（容忍 `W/`）。
4. **同名并发写不再共享临时文件**：`put` 的临时文件名加随机后缀，避免并发写同一 key 时
   把半成品 rename 到位。
5. **歌词标签解析改为窗口读取**：原实现整文件读入，2GB 的 .mp4 放入音乐库即可打爆内存；
   现按「首窗口 + 尾窗口」各 8MB 读取（覆盖 ID3 头部与 MP4 尾部 moov），内存上限固定。
6. **singleflight 结束窗口**：`endPageJob` 改为先发布结果并关闭 `done`、再摘除表项，
   消除「同键出现第二个 leader（重复解码）」的窗口。

- 新增端点全部沿用既有 `readAuth`/`writeAuth`、媒体库白名单与 `safeFile` 路径校验；
- 归档条目必须命中已解析条目白名单（防 zip-slip / 任意文件读取）；`w`/`q` 越界一律 400；
- 转码缓存写入为原子写，`.tmp` 半成品在重建索引时清理；缓存有独立配额（默认 4GB）与 LRU 淘汰；
- 歌词 sidecar 写入同样受媒体库白名单约束，且不触碰音频文件本身。

## 四、验证

- 新增契约测试 `tests/test_v0967_comic_reader_and_lyrics.py`；全量 Python 契约测试通过；
- Go：`page_cache`/`page_transcode`/`lyrics` 等新增单测通过；`go vet` 与既有测试通过；
- 前端：所有改动 JS 通过 `node --check`；
- 容器：本地构建后读回静态资源版本与新端点响应头（`X-Vaulthub-Page-Cache`）与真实样本耗时。

## 五、升级

```bash
docker compose pull
docker compose up -d --force-recreate
```

镜像：`q807738511/vaulthub:v0.9.67` / `q807738511/vaulthub:latest`
回滚：`q807738511/vaulthub:v0.9.66`

## 六、可选配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEDIA_PAGE_CACHE_DIR` | `<MEDIA_CACHE_DIR>/page-cache` | 按页转码缓存目录 |
| `MEDIA_PAGE_CACHE_MAX_BYTES` | `4294967296`（4GB） | 缓存上限；**设为 0 即整体关闭转码**（请求 w>0 也直出原图） |
| `VAULTHUB_LYRICS_NETEASE` | `0` | 设为 1 启用网易云歌词与元数据源（未公开接口，自担风险） |
