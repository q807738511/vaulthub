# 05 · 库浏览、书刊阅读与音频

## 1. 库类型与界面映射

| 库 `type` | 内容 | 客户端主界面 |
|---|---|---|
| `movie` | 单文件影片 | 海报网格 + 详情 |
| `series` | 剧集（目录/文件命名约定） | 剧集 → 季 → 集 |
| `audio` | 音乐（专辑/歌手目录） | 专辑墙 → 曲目列表 |
| `musicvideo` | MV | 网格 |
| `book` | EPUB / PDF / TXT | 书架 → 阅读器 |
| `comic` | CBZ/ZIP 图片归档 | 书架 → 翻页阅读器 |

文件列表 `GET /api/media/files?id=&limit=&offset=` 返回的相对路径即是后续所有接口的 `path`。

## 2. 封面/海报

```
GET /api/media/cover?id=<lib>&path=<与媒体同目录的图片>&w=320
```

约定：sidecar 与媒体**同目录同基名**或常见命名（`poster.jpg`、`folder.jpg`、`cover.jpg`）。
客户端不要在本地猜文件名：列表页先尝试一次 `cover`，404 就显示占位图；
`w=320`（网格）/`w=640`（详情）两档足够。

> 该端点公开（无需会话），但需要知道库 ID 与 sidecar 路径，不能用来遍历库外文件。

## 3. 电子书（EPUB）

```
GET /api/media/document/epub?id=lib-book&path=三体.epub
```

```json
{"title":"三体","chapters":[{"title":"第一章 科学边界","text":"..."}],
 "count":42,"bytes":812345,"truncated":false}
```

- 服务端把 EPUB **拆成章节纯文本**返回，不返回原始 XHTML/CSS/图片。
  客户端渲染纯文本 + 章节导航即可；需要排版就自己做（字号/行距/主题）。
- `truncated:true`：超出服务端解析上限，末尾章节缺失，需提示用户。
- 进度：`page` 用章节序号（0 起），`total=count`，`progress=page/total*100`。

## 4. 漫画 / 图片归档

```
GET /api/media/archive/zip?id=lib-comic&path=进击的巨人 第01卷.cbz
→ {"entries":[{"name":"第01话","raw":"001.jpg","size":812345,
                "url":"/api/media/archive/zip/register?id=..&path=..&entry=001.jpg"}],"total":120}
```

- `entries` 已按**自然序**排序（2 在 10 前），直接当页序。
- 取页：`GET /api/media/archive/zip/page?id=&path=&entry=<raw>&page=<n>`
  （`page` 可选，用于切页时的预取与缓存键）。
- 封面：`GET /api/media/archive/zip/cover?id=&path=`。
- 进度：`page` = 当前页索引，`total` = `entries.total`。

## 5. PDF

```
GET /api/media/pdf/info?id=&path=        → {"pages":318,"encrypted":false,"page_base":"..."}
GET /api/media/pdf/page?id=&path=&page=3&w=1600&q=85   → JPEG
GET /api/media/pdf/cover?id=&path=       → JPEG
```

- 一页一图；`w` 控制渲染宽度（阅读器按窗口宽度取 1×/2× 两档即可）。
- `encrypted:true`：服务端渲染不出内容，客户端直接提示「该 PDF 已加密」。
- 进度：`page` = 页索引（0 起），`total=pages`。

## 6. 阅读进度

```
PUT /api/media/reading/progress?id=lib-book&path=三体.epub
{"progress":42.5,"page":12,"total":200}
```

- 服务端钳制 `progress` 0–100、`page` 0–total；`NaN` → 400。
- 读整库：`GET ...?id=lib-book` → `{"items":{path:{...}}}`，书架用这个显示「已读 42%」。
- 释放条目：`DELETE ...?id=&path=` → `{"removed":true|false}`（幂等）。
- 写入节律：翻页后 2 秒内写一次即可，不要每页都写（JSON 全量落盘）。

## 7. 音频（音乐库）

| 场景 | 接口 |
|---|---|
| 曲目列表 | `GET /api/media/files?id=lib-music` + 目录结构解析 |
| 播放 | `GET /api/media/audio/stream?id=&path=&bitrate=320k` |
| 歌词 | `GET /api/media/audio/lyrics?id=&path=`（P1，见 openapi） |
| 元数据 | `GET /api/media/audio/metadata?id=&path=`（P1） |

- 桌面端做音乐库时，建议按「专辑目录 → 曲目」两级渲染，`bitrate` 默认 `320k`，
  弱网自动降 `128k`（切换前提示一次转码）。
- 连续播放（无缝切歌）：客户端自己预取下一首的前 256KB 即可，服务端无队列概念。

## 8. 数据量参考

| 库规模 | 文件数 | `/api/media/files` 分页 | 首屏建议 |
|---|---|---|---|
| 小 | < 500 | 200/页，一次拉完 | 全量缓存 |
| 中 | 500–5000 | 200/页 | 首屏 2 页 + 滚动加载 |
| 大 | > 5000 | 200/页 | 虚拟滚动 + 按 `q`/目录过滤（P1） |

索引重建期间 `status=indexing`，此时 `total` 会变，客户端应显示进度条而不是报错。
