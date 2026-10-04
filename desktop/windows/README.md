# VaultHub Desktop（Windows）

VaultHub「蜀鼠之家」自建媒体中心的 **Windows 桌面客户端**。

- **客户端版本：`0.1.0.0`**
- **对接服务端契约：v0.9.88（最新 UI）** —— 阅读/播放/画质规则直接对齐服务端
  `web/js/03-quality.js` 与 `web/js/02-media.js`；交接包 `vaulthub-desktop-kit-v1.0-v0.9.83`
  为当时的 v0.9.83 快照，仅作为端点的历史参考。
- 技术栈：Electron 44 + 原生 ES Module 前端（无框架、无构建期打包）
- 安装包：electron-builder → **NSIS `.exe`**
- 联调实例：`http://192.168.112.3:8088`（真实库：电影 / 剧集 / 漫画 / 电子书 / 音乐）

---

## 1. 它做了什么

| 里程碑 | 能力 | 状态 |
|---|---|---|
| M0 | 连接向导、`POST /api/login` 会话、`vh_session` 持久化、401 → 重登、open 模式自动登录 | ✅ |
| M1 | 五类媒体库浏览、封面墙（`cover?w=320`）、无限滚动分页、跨库搜索、`ETag`→`304` 缓存 | ✅ |
| M2 | 视频播放（`playback/plan` 决策 → 直出/转码）、`Range` 拖动、旁挂字幕（srt/ass/vtt→VTT）、本机续播 | ✅ |
| M3 | 漫画（zip/cbz 内页翻页）、电子书（EPUB 章节 / TXT 自动识别 GBK）、**阅读进度写回服务端** | ✅ |
| M4 | 音乐（专辑/歌手/歌单/喜欢/曲目）、音频流（`bitrate` 必填）、歌词（含逐行滚动） | ✅ |
| M5 | NSIS 安装包、版本号对齐服务端契约 | ✅ |

**UI 路线说明**：交接包声称 `source/vaultweb-v0.9.83.tar.gz` 内含 `index.html`，但**实际压缩包里只有
`web/`，没有 `index.html`**（该文件是全部 DOM 骨架所在，被 233 个 JS 引用的元素 id 依赖）。
因此本客户端**没有内嵌原版 Web UI**，而是按 `docs/01a` 的端点契约新建了专用桌面端 UI，
并复用服务端 `main.css` 的 **8 套调色板 × 明暗共 26 个主题令牌**，保证三端观感一致。

---

## 2. 与服务端 v0.9.88 的对齐（本次迭代的核心）

服务端 UI 是**唯一事实来源**。为避免"照文档抄、结果与线上行为不一致"，
本次直接从服务端（线上 `/index.html` + `/web/js/*`，与仓库 `main` 逐字节一致）
提取规则并**逐条移植**，而不是凭文档推测。

### 2.1 画面清晰度档位（`src/renderer/js/quality.js`）

移植自 `web/js/03-quality.js`（v0.9.84 引入，v0.9.88 沿用），函数名保持一致，便于日后同步：

| 档位 | 阅读页转码 | 封面宽度 | 视频 | 音频码率 | 色彩 |
|---|---|---|---|---|---|
| `original` 原画 | 0（原图直出） | 320 | `auto` | — | 100% |
| `high` 高清 | 1600 | 320 | `auto` | — | 100% |
| `smooth` 流畅 | 1200 | 200 | `720p` | 128 kbps | 70% |
| `minimal` 极省 | 900 | 140 | `480p` | 96 kbps | 灰度 |
| `auto` 自动 | 弱网→高清，否则原画 | 同上 | 同上 | 同上 | 同上 |

- 存储键 `vaulthub_quality_level_v1`，顺序 `auto → original → high → smooth → minimal`。
- 「自动」档弱网判定与 v0.9.71 同源：`navigator.connection.saveData` → 2g/3g → 显式测速结论。
- **可逆**：只改 `<html data-quality>` + `--vh-quality-color` + 取图宽度，
  色彩用 `filter: saturate(var(--vh-quality-color))` 实现（`0` 即灰度），
  因此换档不需要任何图片重转，也不可能"改不回来"。
- 顶栏新增档位按钮（点击循环切换），设置页有独立的「画面清晰度」页。

### 2.2 漫画规则（`reader.js` / `state.js`）

对齐 `COMIC_PREFS_KEY = "vaulthub_comic_prefs"` 与 `comicPrefs()`：

- 默认值 `{ saveData:"auto", mode:"single", rtl:true, fit:"width", width:1600 }`
  —— 注意 **`rtl: true`（日式从右到左翻页）**，此前客户端错误地默认成左到右。
- 预取 **后 3 页**（`COMIC_PREFETCH_AHEAD = 3`），翻页不空白。
- 取图宽度由档位决定（`comicTranscodeWidth()`）：显式档位优先；
  「自动」档交回省流判定 —— 弱网 → `prefs.width`(1600)，否则 0（原图直出）。
- 阅读模式扩展为单页 / 双页 / 连续滚动，并把 `mode`、`rtl`、`saveData` 写回同一套偏好键。

### 2.3 电子书规则（`reader.js` / `util.js`）

- 字号默认 **17**、范围 **12–32**（对齐 `changeEbookFontSize` 的 clamp），
  CSS 变量 `--ebook-font-size`；新增 **斜体**开关 `--ebook-font-style`（v0.9.88 新增）。
- TXT 按与 Web 端**同一套正则**切章（`第X章/卷/回/节/部/集/篇`、`Chapter N`、`1. 标题`），
  渲染出 `.ebook-chapter-title` 供目录精确定位跳转（此前只是单块长文，无法按章导航）。
- 阅读进度写回 `PUT /api/media/reading/progress`：`progress` 归一到 0–100，
  `page`/`total` 为 0 时不覆盖服务端已有值（对齐 `saveReadingProgress`）。
- **修复一个真实缺陷**：恢复服务端进度是异步的，恢复完成前 `scrollTop` 仍为 0，
  此前会立刻把进度写回 0% —— 表现为"每次重开都从头开始"。
  现按 v0.9.88 `trackReaderProgress` 的同款做法加 `restoring` 守卫。

### 2.4 影视播放规则（`player.js`）

对齐 `requestPlaybackPlan()`：

- 请求体 `{ library_id, path, quality, hardware, network_bps, client }`，
  其中 `quality` **由画质档位决定**（原画/高清 → `auto`，流畅 → `720p`，极省 → `480p`），
  `network_bps` 上报最近测速结果。
- 能力上报字段对齐 `browserPlaybackCapabilities()`：`mse / mp4 / h264 / hevc / vp9 / aac / opus`
  （判定方式同样是 `canPlayType` **或** `MediaSource.isTypeSupported`），
  桌面端额外补 `webm / av1 / mp3 / flac / vorbis`。
- 播放计划加 **20s 超时**（v0.9.51 的修复），避免探测/转码异常时永久卡在"正在准备播放"。
- 模式文案对齐 `playbackModeLabel()`：
  `Direct Play 原画直放` / `Smart Stream · Remux` / `仅音频转码` / `完整转码`。

### 2.5 刮削参数与配置（设置 → 「刮削与缓存」）

服务端 Web 端的刮削配置**用 `PUT`（不是 POST）**写回 `PUT /api/media/settings`，
字段与 `saveMediaRuntimeSettings()` 一一对应：

| 界面字段 | 服务端字段 | 说明 |
|---|---|---|
| 刮削地区 | `scrape_region` | `auto` / `cn` / `jp` / `us`（TMDB 语言） |
| 标题匹配阈值 | `scrape_min_match` | 界面按 **30–100 百分比**填写，服务端以 **0–1** 存储（默认 70%） |
| 刮削方式 | `scraper_mode` | `auto`(TVDB→TMDB→豆瓣→文件名) / `tmdb` / `douban` / `filename` |
| TMDB API Key | `tmdb_api_key` | 只回显 `tmdb_api_key_masked`；**留空保留**服务端已有值 |
| TMDB API/图片链接 | `tmdb_api_base` / `tmdb_image_base` | |
| TVDB API Key/链接 | `tvdb_api_key` / `tvdb_api_base` | |
| 代理访问 | `scraper_proxy` + `scraper_proxy_set` | 服务端私网保护会拒绝直连私网目标 |
| 缓存与扫描 | `cache_dir` / `cache_max_bytes` / `cache_max_age_hours` / `cache_cleanup_interval_hours` / `page_cache_max_bytes` / `scan_max_depth` | |
| 对外分享地址 | `share_public_base` + `share_public_base_set` | |

- 附带 **网络测速**（`POST /api/media/network/speed`，固定白名单 TMDB/TVDB/通知/GitHub API），
  结果同时用于弱网判定与 `network_bps` 上报。
- 密钥类字段**只在内存中传递**，桌面端不落盘；界面只显示"已设置/未设置"。
- 「演职人员头像刮削插件」在 Web 端是**浏览器本地**设置（`vaulthub_cast_scraper_plugin`，
  服务端无对应字段），桌面端同样只存本机，UI 已注明。

---

## 3. 架构

```
┌───────────────────── Electron ─────────────────────┐
│  渲染层 src/renderer（ES Module，无框架）             │
│    所有请求都是同源相对路径 /api/...                  │
├────────────────────────────────────────────────────┤
│  本地同源网关 src/main/proxy.js (127.0.0.1:随机端口)  │
│    /api/** , /healthz  → 反代到用户配置的服务器        │
│    其它路径            → 渲染层静态资源                │
│    持有 vh_session Cookie（渲染层看不到，落盘加密）     │
├────────────────────────────────────────────────────┤
│  主进程 src/main/main.js + ipc.js + store.js         │
│    配置/会话持久化、连通性自检、日志                    │
└────────────────────────────────────────────────────┘
                        ↓ HTTP(S)
              VaultHub 单一入口 :8088
```

**为什么要有网关**（`src/main/proxy.js`）：

1. 渲染层若直连 `http(s)://<服务器>` 会撞 **CORS**，且 `<video>` / `<img>` 无法携带 Cookie；
2. 服务端**只有 Cookie 会话、没有 API Token**，必须由宿主进程统一持有 `vh_session`；
3. 渲染层因此始终处于**同源**环境，直接用 `/api/...` 即可，无需关闭 `webSecurity`；
4. 反代**透传 `Range` / `ETag` / 状态码**，视频拖动与列表条件请求才能正常工作。

目录：

```
src/
  main/      main.js（生命周期）· proxy.js（网关+CookieJar）· ipc.js · store.js
  preload/   preload.js（contextBridge，暴露 vhHost）
  renderer/  index.html · css/{tokens,app}.css · js/{app,api,state,util,ui,paths}.js
             js/views/{browse,series,player,reader,audio,settings}.js
scripts/     fetch-electron.cjs（拉二进制+校验）· make-icon.py · build-win.ps1
             selftest.main.cjs（端到端自检）· diag*.cjs（诊断）
```

---

## 4. 开发与构建

前置：本机无系统 Node/Rust/Docker，使用 DSH 内置运行时。

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

# 1) 安装依赖（pnpm 默认会拦下依赖的 postinstall）
& $node $pnpm install

# 2) 单独拉取 Electron 二进制（带 SHA256 校验，走 npmmirror）
& $node scripts\fetch-electron.cjs

# 3) 开发运行
& node_modules\electron\dist\electron.exe . --dev

# 4) 打 Windows 安装包（产物在 dist\）
#    注意：脚本需绕过执行策略
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
```

产物：

| 文件 | 大小 | 说明 |
|---|---|---|
| `dist\VaultHub-Desktop-0.9.83-Setup.exe` | 114.87 MiB | NSIS 安装包（非静默、可选安装目录、建桌面/开始菜单快捷方式） |
| `dist\VaultHub-Desktop-0.9.83-Setup.exe.blockmap` | 0.12 MiB | 差分更新用（当前未启用更新通道） |
| `dist\win-unpacked\` | — | 免安装版本，可直接运行 `VaultHub Desktop.exe` |

安装包元信息：ProductName `VaultHub Desktop`，ProductVersion `0.9.83`，无代码签名（未配置证书）。

> ⚠ 打包/运行踩到的 7 个环境与上游坑（已全部在本仓库内规避，`scripts\build-win.ps1` 已固化）：
>
> **运行期**
> 1. Electron 在 Windows 上以**命名管道**做多进程 IPC；受限沙箱会拒绝并导致渲染进程
>    `FATAL: platform_channel.cc Check failed`，表现为 `app.whenReady()` 后立刻崩溃。
> 2. 主机会设 `ELECTRON_RUN_AS_NODE=1`，会让 `electron.exe` 退化成纯 Node；启动前必须清除。
> 3. **不要设 `node-linker=hoisted`**：会让 electron-builder 的 `lru-cache/yallist`
>    解析错版本（`TypeError: Yallist is not a constructor`）。
>
> **打包期**
> 4. electron-builder 26.17.0 的 app-builder-lib 调用了 `@electron/get` 的
>    `ElectronDownloadCacheMode`（**≥3.1 才导出**），但它声明的是 `^3.0.0` → 下载
>    7zip/NSIS/winCodeSign 工具链时抛
>    `TypeError: Cannot read properties of undefined (reading 'ReadWrite')`。
>    → 在 `pnpm-workspace.yaml`（pnpm 11 只认这里，不认 `package.json` 的 `pnpm` 字段）
>    里把 `@electron/get` 顶到 `3.1.0`；Electron 本体另用 `electronDist` 指向本地已校验的解包目录。
> 5. 本机没有全局 `pnpm` 命令，而 electron-builder 要跑 `pnpm list --prod --json`
>    → 用 `.shim\pnpm.cmd` 垫片。**垫片与 `.ps1` 构建脚本必须是纯 ASCII**：
>    `cmd.exe` 按 OEM 代码页、PowerShell 5.1 按 ANSI 读取无 BOM 文件，中文会被读坏并引发
>    解析错误甚至死循环。
> 6. NSIS 编译期用 `!tempfile`，`TEMP` 不可写会报
>    `!tempfile: Unable to create temporary file!` → 构建脚本把 `TEMP/TMP` 指向项目内 `.tmp`。
> 7. **打包后渲染层在 `app.asar` 内**，有两个必须遵守的约束（否则安装包能装、能启动，
>    但窗口一片空白）：
>    - asar 用**正斜杠**索引条目，`path.join` 在 Windows 下产生的反斜杠会查不到文件；
>    - `fs.stat` 对 asar 路径可用，但 **`fs.createReadStream` 会直接 `ENOENT`**，
>      因此静态资源一律用 `fs.readFile` 读入内存再下发（渲染层都是几十 KB 的小文件）。

---

## 5. 端到端自检

`scripts/selftest.main.cjs` 在**真实 Electron 进程**里跑完整链路：先验证接口契约，
再加载真实渲染层驱动 UI（登录 → 逐库浏览 → 播放视频/音频 → 漫画/电子书阅读 → 主题/搜索/设置），
输出 `report.json` 与截图。

```powershell
$env:VH_BASE="http://192.168.112.3:8088"; $env:VH_USER="admin"; $env:VH_PASS="***"
$env:VH_OUT="$PWD\selftest-out"
Remove-Item env:ELECTRON_RUN_AS_NODE
& node_modules\electron\dist\electron.exe scripts\selftest.main.cjs `
    --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required
```

最近一次结果：**56 项，通过 55**。唯一失败项是服务端能力限制（见下 §5.5），已如实记录。

---

## 6. 实测发现（**交接文档未覆盖或有偏差，客户端已按实测适配**）

### 5.1 `GET /api/media/reading/progress` 永远返回整库映射
即使带 `path` 也**不会收窄**，固定返回 `{id, items:{ "<path>": {progress,page,total,updated_at} }}`。
必须自己按 `path` 取值 —— 交接包示例暗示带 `path` 会返回单条，照抄会导致**跨端续读永远读不到**。

写入用 **PUT**（不是 POST），查询参数放 `id`/`path`，数据放 body；`DELETE` 同样按 `id`+`path`。

### 5.2 `GET /api/media/files` 的 `limit` 上限是 500
`limit>500`（如 1000、2000）会被服务端**静默回落到 100**，请求方毫不知情。
客户端因此统一用 `limit=500`，否则一页只拿到 1/8 的数据。

### 5.3 `/api/session/check` 不返回 JSON
它落到 SPA 的 catch-all，返回的是 **HTML**（`<!DOCTYPE html>…`），不能用来判断会话。
判断登录态应使用 `/api/media/settings`：**无 Cookie → 401，有 Cookie → 200**。

> 尤其注意：`/api/media/libraries`、`/api/media/index/status`、`/api/media/probe`、
> `/api/system/metrics`、`/api/media/cover/` 实测**免登录也返回 200**，
> 用它们做鉴权判断会让客户端**未经登录直接进入主界面**（本客户端已修正并加了注释）。

### 5.4 `/api/media/files` 返回的是**原始文件清单**，不是媒体条目
包含 `.cover.jpg` / `.lrc` / `.nfo` / `.part` / `BDMV/STREAM/*.m2ts` 等旁挂与结构文件。
「条目抽取、季集分组、封面匹配」都必须在客户端完成（见 `src/renderer/js/util.js`
的 `extractItems` / `groupSeries` / `groupAudio` / `ImageIndex`）。

封面接口要求 `path` 指向**图片文件**，传视频/压缩包会 404，所以要先在清单里定位
`<同名>.cover.jpg` 或目录内的 `cover/poster/folder.jpg`。

### 5.5 服务端转码：4K HEVC 全转码不产出数据
- `playback/plan` 会返回 `url`（本客户端直接用它，不再自行拼 `/compat`）。
- `mode=remux` / `audio_transcode`（H.264 源）**实测可用**：1080p MKV 约 0.5s 出首包，
  客户端 2 秒内达到 `readyState=4`，1440×1080、时长 1424s，可正常播放与推进。
- `mode=full_transcode`（本库电影均为 4K HEVC）**返回 200 但 0 字节**，
  `hardware=off` 也一样；属于**服务端转码能力问题，不是客户端缺陷**。
- `/api/media/compat` 对 `Range` 请求一律回 **200（非 206）**，即转码流的 seek 不可靠。

客户端据此加固：播放器加了 **加载守卫**，超过 12s（直出）/25s（转码）无数据时
不再无限转圈，而是显示服务端理由并提供「改用直出/转码重试」。

### 5.6 影视库没有本地图源
`/api/media/metadata/artwork` 实测返回 `{"items":[]}`，`metadata` 只有
`provider:"本地文件"` 且无 poster 字段；电影库里仅有的 jpg 位于 `BDMV/META/DL/`（光盘菜单图）。
因此**电影/剧集海报墙会大量显示占位图**，这是库内数据现状，不是渲染缺陷
（漫画库有 `<同名>.cover.jpg`，封面显示正常）。

### 5.7 其它
- `audio/stream` 的 `bitrate` **必填**，缺失 → `400 bitrate required`（与交接文档一致）。
- TXT 电子书服务端统一回 `charset=utf-8`，但**字节常常是 GBK**；客户端做了
  BOM 探测 + UTF-8 fatal 校验 + GBK/BIG5 回退解码。
- `archive/zip/register` 是 **GET**（不是 POST），参数 `id`/`path`；页图走 `archive/zip/page?...&w=`。

---

## 7. 本地数据边界

| 数据 | 存放 | 是否跨端 |
|---|---|---|
| 媒体库 / 文件索引 / 元数据 | 服务端 | ✅ |
| **阅读进度** | 服务端 `PUT /api/media/reading/progress` | ✅ |
| **刮削参数与缓存配置** | 服务端 `PUT /api/media/settings` | ✅ |
| 音量、画质档位、字号、主题、侧栏、漫画偏好 | 本机 `userData/config.json` / localStorage | ❌（端侧体验） |
| **喜欢 / 歌单 / 视频续播位置** | 本机 localStorage（限额安全层） | ❌ |

后两类服务端 **v0.9.88 仍没有对应端点**（交接包 §5.2 已列为建议项），
客户端 UI 已明确标注「仅本机」，不做跨端承诺。
需要注意：**画质档位与漫画偏好**在 Web 端也是浏览器本地值，服务端没有对应字段，
所以桌面端与 Web 端各自保存、不互相覆盖。

---

## 8. 版本对齐

| 项 | 值 |
|---|---|
| 客户端版本 | **`0.1.0.0`**（与 `package.json` 一致，「关于」页显示） |
| 对接契约 | 服务端 **v0.9.88**（最新 UI；`03-quality.js` / `02-media.js` 逐条对齐） |
| Electron | 44.5.1（Chromium 152 / Node 24.21.0） |
| 安装包 | `dist\VaultHub-Desktop-0.1.0.0-Setup.exe`（NSIS，未签名） |

服务端升级后请重跑 `scripts/selftest.main.cjs`，并重新比对 `web/js/03-quality.js`
与 `02-media.js` 里 `QUALITY_PROFILE`、`comicPrefs`、`buildEbookChapters`、
`requestPlaybackPlan`、`saveMediaRuntimeSettings` 这几处是否变化 —— 它们是本次对齐的锚点。

### 发布到 GitHub

本机没有 git 且 `github.com` 不可达（只有 `api.github.com` 可达），
因此用 REST 的 **Git Data API**（blobs → tree → commit → ref）推送，脚本见
`scripts/github-publish.mjs`：

```powershell
$env:GITHUB_TOKEN = "<fine-grained PAT，对本仓库开放 Contents: Read and write>"
$node scripts\github-publish.mjs --repo q807738511/vaulthub --branch windows-desktop `
      --prefix desktop/windows --message "feat(desktop): VaultHub Windows 桌面客户端 v0.1.0.0"
```

> `node_modules/`、`dist/`、`.cache/` 不会上传；安装包 115 MiB 超过 GitHub 单文件限制，
> 请用 Release 附件分发。token 只从环境变量读取，不写入任何文件。
