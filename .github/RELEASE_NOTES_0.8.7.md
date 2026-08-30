# VaultHub v0.8.7 · 侧栏切库、顶栏标题与 compose 精简

本版修三件用户报告的问题，并把部署配置拆成「常用项 + 固定项」两个文件。

## 1. 侧栏点「电子书」不再跳回漫画

**根因**：漫画库与电子书库同属一个视图 `data-view="comic"`（音乐与 MV 同属 `audio`），
而 `switchView()` 用 `querySelector('.nav-item[data-view="comic"]')` 取节点 ——
这个选择器永远返回文档里排在前面的那一个。用户侧栏顺序是「漫画 848 / 电子书 185.7k」，
所以点电子书后高亮始终落回漫画，看起来像是又跳回了漫画。

**修复**：
- 侧栏每个媒体库条目新增唯一 `data-nav-key="<视图>:<库ID>"`（外连服务同样带）。
- `switchView(v, libId)` 新增第二个参数，按 `data-nav-key` 精确匹配；
  匹配不到时退回「该视图下没有 `data-lib-id` 的固定条目」，最后才退回原行为。
- 匹配用 `dataset` 直接比较而不是拼接 CSS 选择器，媒体库 ID 含引号时也不会选歪。
- `openHomeLibrary()` 把 `libId` 传给 `switchView()`。

真实浏览器实测（1440×900 Chrome 151）：点漫画→高亮漫画、列出漫画文件；
点电子书→高亮电子书、标题变「电子书」、列出电子书文件且不再含漫画文件；
再切回漫画同样正确；全程只有 1 个条目高亮。

## 2. 媒体标题不再覆盖顶栏按钮

用户截图框住的是**顶栏那个账户/设置按钮**被媒体标题压住。这里有两个独立缺陷。

### 2a. 浮层整条盖住了顶栏（主因）

`.media-reader-overlay` 是 `position:fixed; top:0; z-index:300`，而 `.topbar` 是
`position:fixed; height:52px; z-index:80` —— 浮层直接盖在整条顶栏之上，长文件名标题
就压在账户按钮上面。账户菜单是进入系统设置的唯一入口，被盖住等于设置进不去。

实测（`elementFromPoint` 命中测试，24 种「视口 × 侧栏展开折叠 × 播放器/阅读器」组合）：

```
修复前：16 / 24 组合下账户按钮点不到，最上层元素 = media-reader-title
        · 侧栏折叠时浮层 left 从 236px 缩到 60px，标题左边缘 72px 直接盖住 145px 的按钮
        · ≤768px 时浮层 left:0，标题左边缘 12px，按钮在 62px，同样被盖
修复后：0 / 24
```

**修复**：浮层改为 `top:var(--topbar-h)`（窄屏 `inset:var(--topbar-h) 0 0 0`），
不再覆盖顶栏；`min-height` 从 `100vh` 改为 `0`，正文与视频区高度同步扣掉顶栏
（`calc(100vh - var(--topbar-h) - 51px)` / `- 54px`），避免底部被裁。

### 2b. 阅读器自身顶栏里标题挤压按钮

`.media-reader-title` 只有 `min-width:0` 和省略号，没有 `flex` 收缩规则和最大宽度；
`.media-actions` 继承了全局 `margin-top:8px` 且允许换行，长文件名会把
「设置 / 标记已读 / 关闭」推到第二行。

**修复**：
- 标题：`flex:1 1 auto` + `min-width:0` + `max-width:calc(100% - 190px)`，超长省略号。
- 顶栏按钮组：`flex:0 0 auto` + `margin-top:0` + `flex-wrap:nowrap`。
- 播放器顶栏只有关闭按钮，标题放宽到 `calc(100% - 60px)`。
- 窄屏（≤768px）收紧到 `calc(100% - 150px)` / `calc(100% - 52px)`。

真实几何测量（`getBoundingClientRect`，jsdom 量不出重叠所以必须用真实浏览器）：

| 场景 | 标题右边缘 | 最左按钮左边缘 | 结论 |
|------|-----------|---------------|------|
| 视频播放器 1440px | 1368.0 | 1392.0 | 不重叠 |
| 电子书阅读器 1440px | 1194.3 | 1206.3 | 不重叠 |
| 漫画阅读器 1440px | 1194.3 | 1206.3 | 不重叠 |
| 电子书阅读器 640px | 394.3 | 406.3 | 不重叠 |
| 真实 TXT 阅读器 | 1065.3 | 1077.3 | 不重叠 |

按钮全部落在顶栏内、同一行、尺寸可点，且每个按钮中心的 `elementFromPoint` 都返回按钮自身。

### 2c. 侧栏高亮在 5 秒后自行消失

独立复审又抓出一个同源问题：`initHome()` 每 5 秒调用一次
`renderHomeLibraryNav()` 刷新计数与索引进度，而它用 `host.innerHTML = ...` 整体重建
侧栏。重建出来的节点都不带 `active`，于是**点完媒体库 5 秒后侧栏就什么都不亮了**。
所有既有验证都是「点击 → 立刻断言」，中间没跨过定时器，因此全部漏掉。

**修复**：`switchView()` 把选中键记到 `window.vaultHubActiveNavKey`；
`renderHomeLibraryNav()` 在 `innerHTML` 重建之后按该键重新套用高亮。
同时 `switchView()` 在未显式传 `libId` 时回落到 `localMediaSelection[v]`，
修掉首页「更多 ›」和侧栏事件委托这两条旧调用路径的高亮错位。

实测（真实浏览器，跨过 5 秒定时器）：

```
修复前：点电子书立即=电子书 → 重绘后=(none) → 6.5 秒后=(none)
修复后：点电子书立即=电子书 → 重绘后=电子书 → 6.5 秒后=电子书（始终 1 个高亮）
        切回漫画同样保持；切到首页后媒体库条目正确取消高亮
```

### 2d. 极窄屏关闭按钮被挤出屏幕

电子书阅读器顶栏还有字号工具条（`A- / A+ / 正体`），按钮组固定 350.7px 且
`nowrap`，视口窄于约 375px 时关闭按钮会溢出到屏幕外，320px 下可见宽度为 0
——完全点不到。v0.8.6 靠 `flex-wrap:wrap` 换行（顶栏变高但按钮都在），
改成 `nowrap` 后暴露出来。

**修复**：新增 `@media (max-width:420px)` 断点隐藏字号工具条，标题预留同步收紧。
实测 320/360/370/375/390/414px 下按钮组从 350.7px 降到 221.7px，
关闭按钮可见宽度恒为 36px，顶栏保持单行 53px。

## 3. compose 精简 + VaultHub.env

**新增 `VaultHub.env`**，收纳装好基本不用再动的固定参数：容器内路径
（`MEDIA_ROOT`、`MEDIA_RUNTIME_CONFIG`）、监控挂载点（`SYSTEM_MONITOR_PROC_ROOT/SYS_ROOT`）、
官方 API 地址（`TMDB_API_BASE`、`TMDB_IMAGE_BASE`）、缓存清理策略、字幕 provider 端点、
硬件能力声明（`VAAPI_DEVICE`、`NVIDIA_*`）、`NO_PROXY`。

**`docker-compose.yml` 只保留 7 项常用变量**：`ADMIN_USERNAME`、`ADMIN_PASSWORD`、
`TMDB_API_KEY`、`MEDIA_SCRAPER_MODE`、`MEDIA_CACHE_DIR`、`FFMPEG_HWACCEL`、
`SYSTEM_MONITOR_FILESYSTEMS`，并通过 `env_file` 加载 `VaultHub.env`。

**顺带发现并移除一个死配置**：`PROXY_HOST` 在仓库里没有任何 Go/C/shell 代码读取，
而 TMDB 客户端用的是自带 SSRF 防护的自定义 `http.Transport`，该 Transport 没有设
`Proxy`，所以连标准的 `HTTPS_PROXY` 也不会生效。实测容器内直连
`api.themoviedb.org` 超时、显式带 `https_proxy` 才返回 401 —— 也就是说这台机器确实
需要代理，但配 `PROXY_HOST` 不会有任何作用。留着只会让人误以为已经配好，因此从
compose 移除，并在 `VaultHub.env` 里写明需要在网关/Clash 侧做分流。

**环境变量统一 `KEY=value` 列表写法**。之前示例里混用了 `- KEY: "value"`，
在 `environment` 列表中会被 YAML 解析成映射，compose 直接报错：

```
services.vaulthub.environment.[2]: unexpected type map[string]interface {}
```

已用 compose v2.29.7 复现该报错并确认修正后 `docker compose config` 通过，
两个文件合并后解析出 26 个环境变量，值与预期一致。

`VaultHub.env` 里的值写成 `KEY=${KEY:-默认值}` 而不是字面量，这样同目录 `.env`
里的覆盖仍然生效（v0.8.6 时是生效的，写成字面量会被静默忽略）。实测：无 `.env`
时取默认值，`.env` 写 `MEDIA_CACHE_MAX_BYTES=53687091200` 时解析结果被正确覆盖。

`restart` 从 `on-failure:1` 改为 `unless-stopped`：v0.8.6 起启动会迁移
`/data/Caddyfile`，早期限制重启次数是为防 Caddyfile 损坏时无限重启，
现已由 `injectCachePolicy()` 的跳过条件 + `caddy validate` 覆盖。

> 改完 `VaultHub.env` 需要 `docker compose up -d --force-recreate`，
> 单纯 `restart` 不会重新注入环境变量。

## 4. 顺带修掉一个会让 WebUI 永久打不开的隐患

`restart` 改成 `unless-stopped` 后暴露出一个既有缺陷：manager 启动时若发现
`/data/Caddyfile` 无法通过 `caddy validate`，会直接 `log.Fatal` 退出。配上
`unless-stopped` 就是无限崩溃重启 —— WebUI 永远起不来，用户连内置的 Caddy 编辑器
都打不开，没法修回去。用 WebUI 手改 Caddyfile 写错一个指令就会踩到。

实测（人为在 `/data/Caddyfile` 里插一行无效指令后重启容器）：

```
修复前：Status=restarting  ExitCode=1  RestartCount=8   healthz 无响应
修复后：Status=running     RestartCount=0                healthz=ok
        坏文件保留为 /data/Caddyfile.invalid，自动回落到镜像内置配置
        缓存策略标记仍为 2，缓存头矩阵 18/18
```

内置配置本身校验失败仍然是致命错误（那是构建缺陷，容器起来也没有反向代理）。
新增 3 条 manager 测试覆盖：坏的持久化配置回落、坏的内置配置仍致命、
有效的持久化配置不被覆盖也不被隔离。

## 验证

真实容器（`vaulthub:v0.8.7-local`，端口 18733）+ 真实 Chrome 151 headless：

```
真实浏览器端到端（登录/真实媒体库/真实文件列表/真实 TXT 阅读）  22/22
真实浏览器布局几何 + 顶栏 24 组合命中测试                       35/35
侧栏高亮持久性（跨 5 秒重绘定时器）                              9/9
nav-key 边界场景（无 libId / 库已删 / 同 ID 重建 / 引号库名）    14/14
极窄屏矩阵（11 个视口 × 3 种区域，320px 起）                    33/33
电子书顶栏窄屏矩阵（含字号工具条，10 个视口）                    10/10
DOM 契约（jsdom 加载容器真实脚本）                              50/50
缓存头矩阵                                                      18/18
Python 契约                                                     30/30
```

升级路径（v0.8.6 → v0.8.7 复用同一 `/data` 卷，端口 18734）：
缓存策略标记 2、`try_files` 指令 1 条（未重复堆叠）、`@versioned_asset` 1 处、
缓存头矩阵 18/18；重启后各项不变。

后端与静态检查：`go vet`、`go test -race -count=2`（media-go + manager 均 ok，
manager 含 13 条测试）、`CGO_ENABLED=0 go build`、`node --check`（5 个 web/js + worker.js）、
`sh -n`（install.sh / upgrade.sh）、`git diff --check`、容器日志 0 错误。

## 升级

```yaml
image: ghcr.nju.edu.cn/q807738511/vaulthub:v0.8.7
```

**首次升级到 v0.8.7 必须把 `VaultHub.env` 放到 compose 同目录**，否则
`docker compose` 会直接以 `env file ... not found` 拒绝启动（已实测确认）。
`scripts/install.sh` 与 `scripts/upgrade.sh` 会自动投递该文件，
已存在时保留用户改动；`upgrade.sh` 也会把它一起备份并计入 `SHA256SUMS`。

```bash
cd /vol1/1000/Docker/vaulthub
docker compose pull
docker compose up -d --force-recreate
```

v0.8.6 已修好静态资源缓存，本次升级正常刷新即可看到变更，无需强制刷新。
