## VaultHub 蜀鼠之家 v0.9.89

### 0. 生产事故修复（v0.9.88 刮削结果库并发写导致全站 502）
- **根因**：`scrape_store.go` 把共享 map 拿到锁外读/写 —— `scrapeCacheGet` 锁外遍历、`scrapeCachePost` 锁外写 `lib.Items[path]`、`scrapeCacheDelete` 锁外 `delete`。前端批量写回（生产库 454 条）与界面 GET 并发时，Go 运行时抛 `fatal error: concurrent map read and map write`（不可 recover），整个 media-api 进程退出。
- **放大器**：manager 只 start 一次子进程、无守护；后端死了没人拉起，容器里的 Caddy 仍活着并把请求反代到 `127.0.0.1:9100` → `connection refused` → 全站 `/api/*` **502**（客户看到「媒体库没了」「新建报 502」）。**媒体库数据没有丢**。
- **修复**：共享 map 只在 `scrapeCacheMu` 内访问（深拷贝 + 三个全程持锁操作）；manager 增加子进程守护（退避 1s→30s 自动拉起、`child_restarts` 计数、关停时先停守护）。
- **验证**：新增真实并发回归用例；把 v0.9.88 旧实现换回来跑同一用例，0.026 秒即 fatal，修复版全部通过。

### 1. 阈值改为「辅助刮削」
- 命中口径 = 最低识别字符占比（覆盖率）≥ 阈值；综合分只用于挑候选。
- 匹配不足不再判失败：新增 `review`（待确认）状态，保留文件名展示、不进自动重试（不反复联网），手动改名后单条重刮即可。
- 文案修正：不再出现「最高 0%」。

### 2. 刮削结果 NFO 本地化
- 新增 `POST/GET /api/media/nfo`：把刮削结果写成 Kodi / Emby / Jellyfin 通用 NFO 到媒体文件旁（读取端早已支持读），原子写、0600 同级安全校验、**不覆盖非本程序写的 NFO**。
- 刮削命中后串行本地化（图片 + NFO），下次进库直接读本地，不再整库重复刮削。
- `movie.nfo` 只在单文件目录写：扁平库里读端会让 `movie.nfo` 对整个目录生效，实测会把一部片的信息串到同目录的 ISO 上；只写 `<文件名>.nfo` 即可安全读回。

### 3. 数据本地化 + 标题层级
- `POST /api/media/cover` 支持 `role`：poster / fanart / backdrop / logo 落成读取端认得的 sidecar，图片真正进媒体目录。
- 一级标题 = 刮削标题；原文件名收进「媒体信息编辑」新增只读字段「原文件名称」（悬停卡片也可看）。物理文件永不改名。

### 测试
- Go：新增并发回归 + NFO 写入/回读/边界 + manager 守护用例；`go vet` / `go test` 全绿。
- Node 行为测试 + Python 契约测试覆盖阈值辅助口径、review 状态、NFO 请求、图片本地化、原文件名回填。
- **升级后请 Ctrl+Shift+R 强制刷新**（前端资源版本号已更新为 ?v=0.9.89）。
