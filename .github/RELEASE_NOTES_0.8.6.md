# VaultHub v0.8.6 — 前端资源缓存修复

## 修复的核心问题

v0.8.4 和 v0.8.5 已经在服务端删除的界面元素，在浏览器里仍然显示，看起来像"更新没生效"。

真实原因：`index.html` 引用的是无版本号的固定路径（`/web/js/02-media.js`），而静态响应没有 `Cache-Control`，浏览器按启发式规则长期复用了 v0.8.3 时期缓存的脚本。因此：

- 播放器右上角的「设置」按钮（关联异常）仍然出现
- 播放器右上角的「标记已读」按钮仍然出现
- 播放器右上角的「下载」按钮仍然出现
- 书架页右侧的「电子书 / 漫画」切换按钮仍然出现

服务端文件是新的，执行的脚本是旧的。

## 本次改动

### 静态资源版本化

- `index.html` 对 6 个静态资源全部追加 `?v=0.8.6`（`main.css` + 5 个脚本），版本变化即缓存键变化。
- 脚本加载顺序保持 `01-state → 02-media → 03-features → 05-home → 04-boot` 不变。

### Caddy 缓存策略

`/web/*` 由独立的嵌套 `handle` 独占处理，不再参与 SPA 回落：

- 入口页与任意深链：`no-store, must-revalidate`，升级后必定取到新入口页。
- 带 `?v=<语义版本>` 且文件存在：`public, max-age=31536000, immutable`。
- 无版本串 / 空 `?v=` / `?v=latest` / WASM vendor 资产：`public, max-age=300, must-revalidate`。
- `/web/` 下缺失的文件：`404` + `no-store`。此前会回落成 `index.html` 并返回 `200 text/html`，一次漏打包就会让浏览器把 HTML 当成脚本缓存一年。

### 已有安装的自动迁移

容器优先使用持久化的 `/data/Caddyfile`，只更新镜像并不会带来新的缓存头。因此启动时会把缓存策略幂等地迁移进 `/data/Caddyfile`，并移除旧的顶层 `try_files` / `file_server`。文件已带策略标记、已自定义同名 matcher、或没有静态 `root *` 锚点时都会跳过，不覆盖运维改动。

### 运行时版本自查

- `index.html` 声明 `window.VAULTHUB_ASSET_VERSION`，`01-state.js` 声明 `VAULTHUB_SCRIPT_VERSION`。
- `04-boot.js` 启动第一件事调用 `ensureFreshAssets()`：两者不一致时（含旧入口页没有版本号的情况）立即绕过缓存重载一次，并跳过后续初始化，避免旧脚本渲染半个界面。
- 调用点用 `typeof` 守卫。混合缓存下可能出现"新 `04-boot.js` + 旧 `01-state.js`"，裸调用会抛 `ReferenceError` 让整个前端白屏；此时按资源过期处理，同样重载一次。
- 守卫用 URL 上的 `_vh` 参数 + `sessionStorage` 双保险：隐私模式下 `sessionStorage` 抛错时靠 URL 兜底，不会无限刷新。重载保留原有 query 与 hash，版本对齐后再用 `history.replaceState` 把 `_vh` 清掉。
- WASM Worker 及其内部 `importScripts` / `locateFile` 的 vendor 资产也透传版本号。

### 顺带修复的分页文案

- 过滤后本页为空时不再显示 `1-0 / 848` 这种不成立的区间，改为「本页无匹配」。
- 整页书籍都已读时提示「本页书籍都已读完，点击『下一页 →』继续查看未读书籍」，而不是含糊的「当前页没有未读书籍」。

## 验证

50 项真实 DOM 断言全部通过（jsdom 加载运行容器返回的真实 `index.html` 与真实脚本）：

- 播放器顶栏只剩关闭按钮，无设置 / 标记已读 / 下载
- 书架工具条只有一个「已读收藏 ↔ 返回未读」按钮，无电子书/漫画切换
- 侧栏从漫画点到电子书后当前媒体库真的变化
- 海报点击进详情页、右下角未读/已读按钮、详情页顺序与按钮齐全
- 感叹号面板的 FFprobe 元数据格式化
- 刮削与缓存 8 个设置字段齐全且标注环境变量
- 版本落后时强制重载、只重载一次、保留 query/hash、`sessionStorage` 被禁用时不无限刷新、对齐后清理 `_vh`
- `ensureFreshAssets` 缺失时不抛异常并请求重载

18 项缓存头矩阵在三个场景下全部通过：全新安装、从真实 v0.8.5 原地升级、v0.8.6 重启幂等。

其他检查：

- 30 个 Python 契约脚本通过。
- `go vet`、`go test -race -count=2`、`CGO_ENABLED=0 go build`、manager `go test` 通过。
- `caddy validate` 通过。
- Session-only 鉴权、并发配置保存、密钥掩码、私网 TMDB 目标拒绝的 API 实测通过。
- 容器日志 0 错误。

## 升级须知

升级后多数情况会自动生效：新入口页 `no-store`，前端还会自查一次版本。若浏览器这次导航没有校验旧入口页，仍看到旧界面，按一次 `Ctrl+Shift+R` 即可，之后不再需要。
