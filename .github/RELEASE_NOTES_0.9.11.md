# VaultHub v0.9.11

在 v0.9.10 的基础上修复真实浏览器验证中发现的三处缺陷，并保留 v0.9.10 的全部新功能。

## 本次修复（v0.9.11）

- **侧栏系统设置按钮被折叠按钮覆盖**：`toggleBars()` / `loadSidebarRail()` 之前用 `document.querySelector(".rail-btn")` 取节点，会命中侧栏里排在前面的系统设置按钮，把它的 ⚙ 图标与「系统设置」文字整体替换成 ⇤。折叠按钮改为独立 `id="sidebarCollapseButton"`，两处逻辑改用 `getElementById`。
- **详情页海报遮罩定位错误**：`.movie-detail-hero::before` 是 `position:absolute; inset:0`，但 hero 自身不是定位元素，暗化遮罩会相对更外层祖先定位，海报上的标题与简介失去对比度保护。hero 补上 `position:relative`。
- **backdrop-art 分支缺样式**：只有 `poster-art` 写了白字与遮罩规则，仅有 fanart 没有 poster 的影片会退回主题文字色，在浅色主题下几乎不可读。`poster-art` / `backdrop-art` / `has-art` 现共享白字 + 阴影 + 加重遮罩。
- **海报地址进 CSS 前硬化**：新增 `cssUrlValue()`，剔除引号、括号、反斜杠与控制字符。`esc()` 只做 HTML 实体转义，浏览器解析 `style` 属性时会把 `&#39;` 还原成单引号，足以闭合 `url('…')` 注入任意 CSS 声明；海报地址来自本地 NFO / TMDB / 豆瓣，均属外部内容。
- **剧集缓存读回加固**：`JSON.stringify` 会把 `seasons`（Map）序列化成 `{}`，`readSeriesShow()` 现只依赖数组字段 `seasonList` / `files`，并对旧缓存缺字段回落空数组。

## v0.9.10 引入的功能（本版本保留）

- **影视详情页背景改用刮削到的海报**：优先 `poster`，其次 `backdrop`，两者都无才回落主题渐变；三态分别对应 `poster-art` / `backdrop-art` / `no-art`。
- **系统设置入口迁移到侧边栏底部**：顶栏账户菜单只保留「关于」与「退出登录」；侧栏最下缘、版本号上方新增系统设置按钮，图标与文字随侧栏折叠同步（折叠只留齿轮，宽 27px）。
- **电视剧集按 Plex / Emby 规则聚合**：库列表不再为每一集单独出卡。命名规则以 Plex 为主（根目录=剧名，子目录 `Season 01` / `Season 1`，单集 `剧名 - S01E01 - 标题`），Emby 规则（`剧名 S01E01 标题`）与 `1x01`、`第1季第1集` 作为备选；先聚合主剧集，再在详情页内按季列出单集。

## 镜像

```
ghcr.io/q807738511/vaulthub:v0.9.11
ghcr.nju.edu.cn/q807738511/vaulthub:v0.9.11
docker.io/q807738511/vaulthub:v0.9.11
```
