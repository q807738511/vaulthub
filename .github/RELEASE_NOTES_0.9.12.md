# VaultHub v0.9.12

修复 v0.9.10 引入的剧集聚合在大剧集库上的两个真实缺陷。功能范围与 v0.9.11 相同。

## 本次修复（v0.9.12）

- **剧集聚合被分页切成半截**：影视库按 50 条一页取文件，聚合只在当前页的文件上做，一部 8 季 200 集的剧在第 1 页显示成「2 季 · 50 集」，翻到第 2 页又变成「Season 03 / Season 04」，季数集数全是本页局部统计。剧集库现在先按 500 一批把整个库的文件补齐（后端 `limit` 上限 500），再做聚合，分页条改为「已聚合 200 / 200 集」；超过 2 万集时明确提示只聚合前 2 万条。电影库分页行为不变。
- **剧集缓存写爆 localStorage 且静默失败**：`rememberSeriesShow()` 之前把整个 show 对象（`files` 与 `seasonList[*].episodes` 是同一批条目的两份拷贝，外加无法序列化的 `seasons` Map）JSON 化写入，一部 200 集的剧约占 120 KB，多个大库会撞上 5 MB 配额，`setItem` 抛 `QuotaExceededError` 后被空 catch 吞掉，详情页打不开。新增 `seriesShowCacheShape()` 只持久化详情页真正读取的字段，配额不足时退化为内存缓存。

## v0.9.11 的修复（本版本保留）

- 侧栏系统设置按钮不再被折叠按钮覆盖：折叠按钮改用独立 `id="sidebarCollapseButton"`，`toggleBars()` / `loadSidebarRail()` 不再用 `.rail-btn` 泛选择器。
- `.movie-detail-hero` 补 `position:relative`，`::before` 暗化遮罩正确覆盖海报。
- `poster-art` / `backdrop-art` / `has-art` 共享白字 + 阴影 + 加重遮罩，仅有 fanart 的影片在浅色主题下也可读。
- 新增 `cssUrlValue()`，海报地址进 CSS `url()` 前剔除引号、括号、反斜杠与控制字符。
- `readSeriesShow()` 对 `seasonList` / `files` 做 `Array.isArray` 回落。

## v0.9.10 引入的功能（本版本保留）

- **影视详情页背景改用刮削到的海报**：优先 `poster`，其次 `backdrop`，两者都无才回落主题渐变，对应 `poster-art` / `backdrop-art` / `no-art` 三态。
- **系统设置入口迁移到侧边栏底部**：顶栏账户菜单只保留「关于」与「退出登录」；侧栏最下缘、版本号上方新增系统设置按钮，图标与文字随侧栏折叠同步（折叠只留齿轮，宽 27px）。
- **电视剧集按 Plex / Emby 规则聚合**：库列表不再为每一集单独出卡。命名规则以 Plex 为主（根目录=剧名，子目录 `Season 01` / `Season 1`，单集 `剧名 - S01E01 - 标题`），Emby 规则（`剧名 S01E01 标题`）与 `1x01`、`第1季第1集` 作为备选；先聚合主剧集，再在详情页内按季列出单集。

## 镜像

```
ghcr.io/q807738511/vaulthub:v0.9.12
ghcr.nju.edu.cn/q807738511/vaulthub:v0.9.12
docker.io/q807738511/vaulthub:v0.9.12
```
