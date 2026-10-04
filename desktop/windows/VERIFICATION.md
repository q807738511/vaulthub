# VaultHub Desktop — 验收报告（v0.1.0.0 · 对接服务端 v0.9.88）

- 被测客户端：`vaulthub-desktop` **v0.1.0.0**（Electron 44.5.1 / Chromium 152）
- 对接服务端：**v0.9.88**（最新 UI），实例 `http://192.168.112.3:8088`
- 验收方式：`scripts/selftest.main.cjs` 在**真实 Electron 进程**中执行
  （先跑接口契约，再加载真实渲染层驱动 UI 与阅读/播放链路）
- 结果：**71 项检查，通过 70，失败 1**
- 耗时：约 59.8 秒 · 截图 19 张

复现命令：

```powershell
$env:VH_BASE="http://192.168.112.3:8088"; $env:VH_USER="admin"; $env:VH_PASS="<口令>"
$env:VH_OUT="$PWD\selftest-out"
Remove-Item env:ELECTRON_RUN_AS_NODE
& node_modules\electron\dist\electron.exe scripts\selftest.main.cjs `
    --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required
```

---

## 1. 逐项结果

| # | 结果 | 检查项 | 证据 |
|---|---|---|---|
| 1 | ✅ | healthz 经网关可达 | 200 ok |
| 2 | ✅ | POST /api/login 200 | {"idle_timeout_seconds":2592000,"must_change":false,"ok":true,"session_days":30} |
| 3 | ✅ | 网关持有 vh_session | Cookie 已捕获并持久化 |
| 4 | ✅ | GET /api/media/libraries | 5 个库: audio-1ydt060[audio], book-1ke0ua1[book], comic-1rfyw87[comic], movie-ovd5kd[movie], series-1cux2hw[series] |
| 5 | ✅ | 列表 audio (audio-1ydt060) | total=14 version=83baf0b3684d11f271647034a0ccef7e etag=有 bytes=1541 |
| 6 | ✅ | 列表 audio If-None-Match → 304 | status=304 bytes=0 |
| 7 | ✅ | 列表 book (book-1ke0ua1) | total=184693 version=75e28dbadd545b6d600274acf084f31f etag=有 bytes=7821 |
| 8 | ✅ | 列表 book If-None-Match → 304 | status=304 bytes=0 |
| 9 | ✅ | 列表 comic (comic-1rfyw87) | total=1022 version=147c58bc874b5e720db2a1798c660c63 etag=有 bytes=9926 |
| 10 | ✅ | 列表 comic If-None-Match → 304 | status=304 bytes=0 |
| 11 | ✅ | 列表 movie (movie-ovd5kd) | total=687 version=e42400870602ef685d75abfaa203f94c etag=有 bytes=11359 |
| 12 | ✅ | 列表 movie If-None-Match → 304 | status=304 bytes=0 |
| 13 | ✅ | 列表 series (series-1cux2hw) | total=974 version=c15719d0a76d3c7b30b9c0b620b202f9 etag=有 bytes=7744 |
| 14 | ✅ | 列表 series If-None-Match → 304 | status=304 bytes=0 |
| 15 | ✅ | 封面缩略图 w=320 | 200 image/jpeg 37607B cache=private, max-age=31536000, immutable |
| 16 | ✅ | POST /api/media/playback/plan | mode=direct layer=direct_play container=mp4 v=hevc 3840x1512 reason=浏览器支持当前封装、视频和音频编码 |
| 17 | ✅ | GET /api/media/file Range 206 | 206 content-range=bytes 0-2047/5873528546 bytes=2048 |
| 18 | ✅ | 音频流 Range 206（带 bitrate） | 206 bytes=1024 type=audio/mpeg |
| 19 | ✅ | 音频流缺 bitrate → 400 | 400 {"error":"bitrate required","ok":false} |
| 20 | ✅ | 漫画 register 页清单 | 200 total=4 entries=4 |
| 21 | ✅ | 漫画页 w=800 缩略 | 200 image/jpeg 194534B |
| 22 | ✅ | PUT 阅读进度 | 200 {"progress":37.5,"page":42,"total":120,"updated_at":1791079867} |
| 23 | ✅ | GET 阅读进度读回一致 | progress=37.5 page=42 total=120（响应为 {id,items} 映射） |
| 24 | ✅ | DELETE 阅读进度生效 | DELETE=200 条目已移除=true |
| 25 | ✅ | GET /api/media/settings | bytes=688 |
| 26 | ✅ | GET /api/media/index/status | running=false libs=5 |
| 27 | ✅ | 找到可播放视频（转码流确有输出） | remux · 394MiB · 首包 65271B/45ms · Files.S01E10.NF.1080p.WEB-DL.AAC2.0.H264-Kan@CHDBits.mkv |
| 28 | ✅ | 渲染层加载并显示登录页 | gate 标题=「登录 VaultHub」 |
| 29 | ✅ | 渲染层通过网关登录 | {"status":200,"body":"{\"idle_timeout_seconds\":2592000,\"must_change\":false,\"ok\":true,\"session_days\":30}\n"} |
| 30 | ✅ | 侧栏渲染出媒体库入口 | 5 / 5 |
| 31 | ✅ | 首页库卡片渲染 | 5 张 |
| 32 | ✅ | 侧栏版本号显示 | v0.1.0.0 · 契约 v0.9.83 |
| 33 | ✅ | 浏览「音乐」(audio) | 卡片=1 图片=1/1 音乐tab=5 |
| 34 | ✅ | 浏览「电子书」(book) | 卡片=472 图片=10/61 |
| 35 | ✅ | 浏览「漫画」(comic) | 卡片=394 图片=10/80 |
| 36 | ✅ | 浏览「电影」(movie) | 卡片=2 图片=0/0 |
| 37 | ✅ | 浏览「电视」(series) | 卡片=17 图片=0/0 |
| 38 | ✅ | 剧集视频（H.264 MKV → 音频转码）真实解码 | 时长=1424s 1440x1080 readyState=4 模式=Smart Stream · Remux |
| 39 | ✅ | 剧集播放器展示服务端决策 | Smart Stream · Remux · mkv · h264 1440x1080 · aac · 2319 kbps · 浏览器支持音视频编码，仅转换容器封装 |
| 40 | ✅ | 视频播放进度真实推进 | currentTime=1.13s 已缓冲=18.4s paused=false |
| 41 | ✅ | 拖动进度（转码流 seek） | seek 后 currentTime=62.37s readyState=4 err=null |
| 42 | ✅ | 点电影卡片可打开播放器 | 电影库卡片=2 |
| 43 | ✅ | 播放器取得播放 URL 并开始加载 | src=http://127.0.0.1:11077/api/media/compat?hw=cuda&id=movie-ovd5kd&mode=full_transcode&path=[五个扑水的少年].Water.Boys. |
| 44 | ✅ | 播放器展示服务端播放决策与理由 | 模式=Smart Stream · 完整转码 · CUDA · mp4 · hevc 3840x1512 · aac · 7103 kbps · 视频编码不兼容，转换为 H.264/AAC |
| 45 | ❌ | 电影（4K HEVC / 全转码）真实解码 | 服务端全转码未输出可播放数据（readyState=0）—— 服务端限制，非客户端缺陷 |
| 46 | ✅ | 漫画页真实解码 | 1761x2500 位置=4 / 4 |
| 47 | ✅ | 漫画阅读进度已同步服务端 | 进度已同步到服务端 |
| 48 | ✅ | 电子书正文渲染且中文可读 | 85269 字符, 汉字 26886, 替换符 0 |
| 49 | ✅ | 文本编码探测正确（无乱码替换符） | 替换符 0 个；开头「全文\色情小说合集\txt\list1【0.8G】 ├小说已分类 │ ├A 乱伦 │ │ ├A 待分类乱伦篇 │ │ │ ├《小镇情欲多」 |
| 50 | ✅ | 音乐视图五个 tab | 专辑 / 歌手 / 歌单 / ♥ 喜欢 / 曲目 |
| 51 | ✅ | 音乐播放条出现 | 堀江由衣 (ほりえ ゆい) - Love Destiny — 未知歌手 · 未分类 |
| 52 | ✅ | 音频流地址已设置 | src=http://127.0.0.1:11077/api/media/audio/stream?id=audio-1ydt060&path=堀江由衣 (ほりえ ゆい) - Love Destiny.ogg&bitrate=1 |
| 53 | ✅ | 音频真实解码并推进播放 | currentTime=0.42s 时长=273.5s paused=false readyState=4 |
| 54 | ✅ | 明暗主题切换 | data-mode=light |
| 55 | ✅ | 搜索返回结果 | 命中卡片=79 · 共 79 条匹配 |
| 56 | ✅ | 设置页渲染 | 9 个分组 |
| 57 | ✅ | 画质档位已落到 <html>（data-quality） | data-quality=original --vh-quality-color=1 gray=false |
| 58 | ✅ | 顶栏可循环切换画质档位 | data-quality=high 色彩=1 灰度=false 存储=high |
| 59 | ✅ | 档位文案与色彩变量同步 | 画面清晰度：高清 · 转码 1600px · 完整色彩（点击切换） |
| 60 | ✅ | 漫画默认右到左翻页（v0.9.88 rtl:true） | 关闭 (Esc) \| 上一页（→ 方向） \| 下一页（← 方向） \| 缩小 \| 放大 \| 适应窗口 / 放大 \| 阅读模式：单页 / 双页 / 连续滚动 \| 翻页方向：右到左（日式） \| 页码跳转 |
| 61 | ✅ | 漫画工具栏含模式/方向/跳转控件 | 9 个控件 · 位置=4 / 4 |
| 62 | ✅ | 漫画页脚显示取图宽度策略 | [かわもりみさき] 淫乳主婦の不貞願望 奥さんと彼女と❤2 [彩页汉化].zip · 10.9 MB · 共 4 页 · 服务端转码 1200px |
| 63 | ✅ | 切换模式写回 vaulthub_comic_prefs | {"saveData":"auto","mode":"double","rtl":true,"fit":"width","width":1600,"__vh_wt":1791079922353} |
| 64 | ✅ | TXT 按章切分并生成目录 | 章节=1 目录项=1 首章「全文」 |
| 65 | ✅ | 章节正则覆盖 第X章/Chapter N/N. 标题 三类 | 4 章：第一章 / Chapter 2 / 3. 小标题 / 第二卷 |
| 66 | ✅ | 章节偏移可用于目录跳转 | offsets=3,13,27,38 |
| 67 | ✅ | 电子书字号范围 12–32 | 共 21 档：12…32 |
| 68 | ✅ | 刮削面板字段来自服务端 | scraper_mode=tmdb region=cn 阈值=70% |
| 69 | ✅ | 刮削缓存参数已回显 | cache_dir=/data/transcode-cache（面板共 21 个字段） |
| 70 | ✅ | 密钥只显示已设置/未设置 | TMDB=已设置；留空保留 · 代理=已配置 http://192.168.112.3:7890；留空保留 |
| 71 | ✅ | 设置页含独立「画面清晰度」页 | 5 个档位可选 |

---

## 2. 本次迭代新增的验收点（v0.9.88 对齐）

| 能力 | 断言要点 |
|---|---|
| 画质档位 | `<html data-quality>` 已落值；顶栏可循环切换（original → high）；`--vh-quality-color` 与档位文案同步 |
| 漫画规则 | 默认**右到左**（工具栏显示「上一页（→ 方向）」「翻页方向：右到左（日式）」）；工具栏 9 个控件（单页/双页/滚动、缩放、方向、跳页）；页脚显示取图策略（如「服务端转码 1200px」，由档位驱动） |
| 漫画偏好键 | 切换模式后写回 **`vaulthub_comic_prefs`**，值与 v0.9.88 一致：`{saveData, mode, rtl, fit, width}` |
| 电子书章节 | TXT 渲染出 `.ebook-chapter-title` 与目录项；章节正则对「第一章 / Chapter 2 / 3. 小标题 / 第二卷」四类样本全部命中，偏移可用于跳转 |
| 电子书字号 | 工具条提供 **12–32 共 21 档**（对齐 v0.9.88 的 clamp） |
| 刮削配置 | 面板 21 个字段全部来自服务端 `/api/media/settings`；`scraper_mode=tmdb`、`scrape_region=cn`、阈值 70%、`cache_dir` 均正确回显 |
| 密钥处理 | 只显示「已设置；留空保留」，不回显密钥本体 |

---

## 3. 截图证据（`selftest-out/`）

| 文件 | 大小 | 内容 |
|---|---|---|
| `01-login-gate.png` | 106 KB | |
| `02-home.png` | 43 KB | |
| `03-lib-audio.png` | 141 KB | |
| `03-lib-book.png` | 1243 KB | |
| `03-lib-comic.png` | 1216 KB | |
| `03-lib-movie.png` | 80 KB | |
| `03-lib-series.png` | 188 KB | |
| `04-player-series.png` | 757 KB | |
| `04-player-movie.png` | 38 KB | |
| `05-comic-reader.png` | 1693 KB | |
| `06-book-reader.png` | 67 KB | |
| `07-audio.png` | 154 KB | |
| `08-light-theme.png` | 155 KB | |
| `09-search.png` | 706 KB | |
| `10-settings.png` | 47 KB | |
| `11-comic-v0988.png` | 777 KB | |
| `12-ebook-chapters.png` | 75 KB | |
| `13-settings-scrape.png` | 90 KB | |
| `14-settings-quality.png` | 90 KB | |

---

## 4. 唯一失败项的结论

**现象**：电影库仅有的 2 个可播文件均为 **4K HEVC**，服务端判定需要 `full_transcode`，
`/api/media/compat` 返回 **200 但 0 字节**（`hardware=off` 亦同），客户端 25 s 内拿不到可播数据。

**已排除客户端因素**：
- 同一播放器用**剧集 H.264 MKV**（`mode=remux`）时约 2 秒达到 `readyState=4`，
  分辨率 1440×1080、时长 1424 s，可正常播放并 seek 到 62 s —— 播放链路本身是通的。
- 客户端已按服务端返回的 `url` 播放，并把 `mode`/`reason` 用 v0.9.88 的文案展示给用户。

**结论**：这是**服务端转码能力问题**（该实例声称 `hardware=cuda`，但 4K HEVC 全转码无输出），
不是客户端缺陷。客户端已加「加载守卫」：超时后显示服务端理由并提供「改用直出/转码重试」。

---

## 5. 环境与运维提示

- 本次验收期间服务端 `media-go` 曾掉线约 25 分钟：`/healthz` 返回 200，但所有 `/api/media/*`
  返回 **502 且响应体为空**。客户端已能区分这种情况，提示「服务器已响应，但媒体后端不可用」
  而不是误报成地址填错；自检脚本也会给出可读原因而非 JSON 解析崩溃。
- 安装包未做代码签名，首次运行可能触发 SmartScreen 提示。
