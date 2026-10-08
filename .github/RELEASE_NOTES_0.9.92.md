# VaultHub 蜀鼠之家 v0.9.92

> 四项客户反馈：影视播放自动铺满整个窗口、离开页面可一键回到正在播放的视频/音乐、
> 电子书栏目不再把 `.cover` 侧车文件当条目列出、缓存目录映射配置实测；
> 同时收掉 v0.9.91 发布前独立审查里遗留的全部非阻塞项（5 项）。

## 1) 影视播放自动占满整个窗口（客户反馈）

**问题**：播放电影/剧集时播放器只占「顶栏以下、侧栏右侧」那一块 ——
`.media-reader-overlay` 的定位是 `top:var(--topbar-h); left:var(--sidebar-w)`，
画面永远要让出一条侧栏和一整条顶栏，大屏上等于浪费三分之一面积。

**改法**：真正的视频播放器（`opts.player`）挂上 `player-fullbleed`，浮层拉到
`inset:0`、`z-index:620`（高于顶栏/侧栏的 600），视频区高度铺满并去掉内边距。

```css
.media-reader-overlay.movie-player.player-fullbleed { top:0; left:0; right:0; bottom:0; z-index:620; }
.media-reader-overlay.movie-player.player-fullbleed .media-video-body { min-height:0; height:100%; padding:0; }
```

- 缩成「停靠小窗」（⌄）时由 `video-minimized.video-controller-docked`（4 个类名）接管，优先级更高，不会被铺满规则顶掉。
- 右上角全屏按钮（浏览器原生全屏）保持原样，与「铺满窗口」互不冲突：铺满是默认形态，原生全屏仍可一键进出。
- PDF/图片/电子书阅读器不受影响（它们不是 `opts.player`）。

## 2) 跨页「正在播放」入口：离开播放页一键回去（客户反馈）

**问题**：「离开当前页面后无法快速回到视频/音乐播放当中，需要重新回到对应页面重新播放」。
音乐元素与视频元素其实都还在 DOM 里（切视图只是 `display:none`，不会销毁），
但界面上没有任何入口能回去 —— 用户只能重新进媒体库、重新点一次。

**改法**：新增与播放器解耦的「正在播放」状态 + 右下角浮标。

- 状态（`vaulthub_active_playback`）记录 `kind/group/libId/path/title/paused`，写 localStorage，
  刷新页面或换设备回来仍在；离开页面后音频/视频继续播放（元素没被销毁）。
- 浮标只在**播放面不可见**时出现（播放器可见时它只是噪音）；显示标题、
  「正在播放 / 已暂停」、播放暂停按钮、「回到播放」、「✕ 停止并收起」。
- 点「回到播放」优先复用**仍然活着的播放元素**（真正的续播，不重建流）：
  视频会顺手取消小窗、恢复控制栏并继续播；元素已被销毁（例如中途重新进过库）才重开播放器，
  此时按 localStorage 里保存的进度续播，**不是从 0 起播**。
- 关闭播放器（✕ / 停靠窗的 ✕）与播放自然结束会清掉该状态，浮标随之收起；
  音乐停在某一首时浮标显示「已暂停」，一键回去接着放。

## 3) 封面/海报 sidecar 不再出现在目录里（客户反馈）

**问题**：「电子书栏目去除 `.cover` 展现在目录，该文件只作为文件封面出现」。
封面落盘（v0.9.56）会写 `<媒体名>.cover.jpg`，v0.9.89 的角色图会写
`<媒体名>-poster.jpg / -fanart / -backdrop / -logo`。旧注释假设「sidecar 不在任何
媒体库扫描格式内」，但漫画/电子书库的格式白名单包含 jpg/png/webp/gif，
于是这些封面文件以「一页/一本」的身份进了书架。

**改法**（服务端 + 前端同一套规则，两处对齐）：

- `media-go/cover_persist.go` 新增 `isMediaSidecarImage(base)`；
- `media-go/scan_walk.go` 的 `skipIndexFile` 命中即跳过索引（对所有库类型生效）；
- `web/js/02-media.js` 的 `supportedLocalMediaFile` 同步拒绝，已有索引无需重建也能立刻干净。

裸 `cover.jpg` / `poster.jpg`（媒体库级封面，`local_metadata` 认可）不算 sidecar，不受影响。
封面展示走 `/api/media/cover` 与 `local_metadata` 直读文件，不经过索引，因此不影响封面本身。

## 4) 缓存目录映射：实测 + 修复（客户反馈）

**实测结论**：设置页「缓存目录」（`cache_dir` / `MEDIA_CACHE_DIR`）改名后

- 转码缓存（`<cache_dir>/<sha256>.mp4`）**立刻**写新目录 ✔
- 音频转码缓存（`<cache_dir>/audio-transcode/`）**立刻**写新目录 ✔（按当前 `cacheDir` 现算）
- 分页缓存（`<cache_dir>/page-cache/`）**不会**跟着走 ✘ —— 旧实现只在启动时
  按 `MEDIA_PAGE_CACHE_DIR`（默认 `cache_dir/page-cache`）派生一次，
  运行时改设置后仍写旧目录，用户看到的是「设置改了，磁盘没变化」。

**修复**：运行时应用配置时若 `cache_dir` 变了，且没有显式配置
`MEDIA_PAGE_CACHE_DIR`，则重新派生 `pageCacheDir` 并丢弃旧的 pageCache 实例
（下次取用按新目录重建，旧目录里的分页缓存不迁移）。显式配置 `MEDIA_PAGE_CACHE_DIR`
时以它为准，不被覆盖。

## 5) v0.9.91 审查遗留项收尾

| # | 级别 | 问题 | 处理 |
|---|------|------|------|
| 1 | 中 | 缓存淘汰可能删掉正在播放的条目 —— 播放中拖动进度条正好赶上清理窗口，同一条转码产物被删掉再重转一次 | 命中缓存即 `Chtimes` 刷新 mtime（LRU 里始终最新）；淘汰与单条目上限改用「活跃窗口」`cacheActiveWindow = 30min`，30 分钟内被播放命中的条目不淘汰 |
| 2 | 低 | `cleanCache` 在「配额=0 且过期时间=0」时函数入口就 `return`，`cache_bytes / cache_files / cache_cleaned_at` 永不刷新（设置页显示 0/未清理） | 收集完条目再判断是否清理，两种早退路径都写用量快照；目录不可读时也落一次快照 |
| 3 | 低 | 下滑翻页失败后 120ms 就解锁，而 `loadLocalFiles` 失败不推进 offset/hasMore，用户停在底部继续滚会把同一失败请求打成连发 | `mediaAutoPage` 的忙标记保持到这一页真正取回；失败进入 4s 冷静期（`MEDIA_SCROLL_FAIL_COOLDOWN_MS`），并加 8s 兜底避免 busy 被永久钉住 |
| 4 | 文档 | 公开 Release Notes / Update Log 写入主机绝对容量与分卷占用（属内网运维细节） | v0.9.91 与 v0.9.92 的公开文档改为相对口径（「已用超过 80%」「约为配额的 1.5 倍」），不再出现主机容量与分卷路径 |
| 5 | 测试 | 旧版本用例的标语断言是「版本前缀计数」（`count("v0.9.9x · ") == 3`），三处文案不一致也能通过；`test_v0960` 有 `"X" in HTML or "X" in HTML` 冗余子句 | 5 处断言升级为「整串完全一致」（`len == 3 and len(set) == 1`）；删掉冗余 `or` |

## 6) 验证

- `go vet ./...` 干净；`go test ./...` / `go test -run V0991|V0992` 全绿。
- 全量回归：**108 通过 / 0 失败**（含新增 `tests/test_v0992_contract.py`、
  `tests/v0992_behavior.js`，以及版本断言、标语断言升级后的全部旧用例）。
- 真实容器验证：一次性容器跑起 `q807738511/vaulthub:latest` 候选镜像后逐项实测 ——
  `server_transcode=off` 的计划改写、缓存目录切换后转码/分页缓存落点、
  封面 sidecar 不入索引（含重新扫描）、跨页浮标与铺满窗口的前端断言。
- 浏览器验证：真实浏览器里播放视频 → 浮层铺满窗口；切到别的库 →
  浮标出现 → 点「回到播放」直接续播（元素仍在，不重建流）。
