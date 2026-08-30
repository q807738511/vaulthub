# VaultHub 蜀鼠之家 v0.8.7：侧栏切库、顶栏标题与 compose 精简

v0.8.7 修三件事：侧栏从「漫画」点到「电子书」后高亮和内容真正跟着切换；阅读器/播放器顶栏的长文件名不再压住右侧按钮；部署配置精简为 `docker-compose.yml`（常用项）+ `VaultHub.env`（固定项），环境变量统一 `KEY=value` 写法。

<details>
<summary>v0.8.6：前端资源缓存修复</summary>

v0.8.6 修复升级后浏览器仍然执行旧前端脚本的问题：v0.8.4/v0.8.5 已经删除的播放器设置按钮、标记已读按钮、下载按钮和书架页电子书/漫画切换按钮，在旧缓存下会继续显示，看起来像“没有更新”。现在 `index.html` 入口页 `no-store`，`/web/` 静态资源带 `?v=<版本>` 且长缓存，前端启动时还会自查脚本版本，不一致时自动绕过缓存重载一次。

</details>

## v0.8.0 更新

- 视频播放器按“原生直连 → FFmpeg 兼容流 → WASM SIMD 软件解码”自动切换，并显示当前引擎；WASM 资产随镜像自托管，不依赖第三方 CDN。
- 音乐/MV 页面保留“我的媒体库”“最新音乐”“喜欢”，专辑与歌手可点击进入曲目列表，歌曲和居中播放器均可收藏。
- 电子书/漫画直接展示海报书架与已读收藏；无刮削封面时使用文件名生成封面。
- 电影/电视剧默认使用海报与作品名展示，页面内不再出现来源切换、管理按钮和 TMDB 配置文字。
- 删除管理令牌输入、浏览器 token 存储和 `ADMIN_TOKEN`/`X-VaultHub-Token` 旁路；管理员写操作统一由账号密码登录 Session 鉴权。
- 索引增加启动孤儿清理、双重存储失败 tombstone 与重启恢复保护。

## v0.8.1 更新

- 新增 `MEDIA_CACHE_DIR`、`MEDIA_CACHE_MAX_BYTES`、`MEDIA_CACHE_MAX_AGE_HOURS` 和 `MEDIA_CACHE_CLEANUP_INTERVAL_HOURS`，转码缓存不再固定占用系统盘，并按大小和保留时间自动清理。
- 音乐播放器只有存在当前播放项目时显示；停止播放、播放列表结束或切换到其他页面后不会显示空播放器。
- 清理媒体内容页顶部重复的大类/来源标签；漫画和电子书使用媒体库导航及页面内子类型按钮独立切换，不再依赖顶部标签。

### 原子索引替换

- 扫描结果先写入 `scan_staging(lib, generation, ...)`，正式 `files` 表在扫描期间保持不变
- 完整 staging 成功后，在一个 SQLite 事务中完成删除旧索引、复制新索引和清理 staging
- 取消或错误会清理当前 generation 的 staging，保留上一份完整索引，不再暴露 2,000 条一批的部分结果

### 安全删除扫描中的媒体库

- 删除会推进任务 generation、取消正在运行的扫描，并清理 `files`、`index_status` 与 `scan_staging`
- 旧任务失效后不能再写回正式索引或状态
- 删除进行中，相同媒体库 ID 的创建请求返回 409；清理完成后才能复用，避免旧删除把新索引清空
- 配置写入使用临时文件加原子 rename；配置保存失败时不修改内存状态

### 动态一致性测试

新增 Go 动态测试覆盖：写库阶段取消仍保留旧索引、扫描中删除后复用相同 ID、删除与同 ID 创建并发竞争。Race detector 连续 10 轮共 30 次通过，原有 26 个契约测试全部通过。

## v0.7.0 更新

### 构建卡加载现在可以监测

以前媒体库首次打开只会显示一句「正在后台建立低速索引，请稍后刷新」，既看不到进度、
也分不清是卡死还是仍在扫描。现在：

- 后端 `/api/media/index/status` 在原有 `state` / `scanned` / `total` 之外补充
  `percent`、`elapsed`、`now`；正在扫描时 `percent` 最高只报 99，避免 UI 提前显示完成
- 扫描已在进行但还没落库时，`/api/media/files` 也会返回 `status: indexing` 与 `scanning: true`，
  不再表现为一个空目录
- 前端渲染真实进度块：进度条、已扫描/总数、已用时长、手动刷新和**取消构建**按钮，每 2 秒轮询一次
- 走盘阶段（还不知道总数）显示不确定态动画条与「正在统计文件数量…」，进入写库阶段切换为百分比
- 构建结束自动加载文件列表并提示；取消走 `POST /api/media/index/cancel?id=`，未登录返回 401

实测（隔离容器，6 万个文件的书库）：`percent` 从 3% → 33% → 53% → 83% 连续递增，
`elapsed` 同步累计，结束后 `state=ready`、`percent=100`、`total=60000`；构建中调用取消
在 1.5 秒内变为 `state=cancelled`、`message=scan cancelled`。

### 侧边栏不再重复展示资源大类

「电子书刊 / 影视作品 / 音视作品」这三个大类此前既是侧栏分组标题，又各自是一个可点击条目，
组内再列出该类下的媒体库，同一个名字出现两三次。现在侧栏只有：

- **主导航**：首页、PT 管理
- **媒体库**：一个扁平列表，每项就是创建媒体库时填写的名称（本地库带项目数，外连服务带 ↗）
- **自定义**：自定义模块

大类只在「系统设置 → 媒体库 → 媒体库增加」里作为分类选择出现，用于决定子类型与刮削源。
侧栏的「添加模块」按钮也移除了，模块显隐改由「系统设置 → 外观主题 → 模块设置」进入。

### 媒体库的管理与增加集成进系统设置

原来媒体库路径管理挂在首页最下方，添加媒体库又另有一个独立弹窗，两处入口维护同一份数据。
现在合并为「系统设置 → 媒体库」一个标签页：

- **已添加的媒体库**：一张表列出全部库（库名、大类/子类型、路径、项目数、刮削状态），
  每行都有重新刮削、打开媒体库、删除三个按钮
- **媒体库增加**：先选来源，再填表单

独立的 `mediaLibraryModal` 弹窗与其保存逻辑一并删除，避免两套代码写同一个接口。
新增媒体库前仍会先确认服务端会话，异常时提示重新登录而不是静默失败。

### 本地媒体库与外连服务统一为「媒体库增加」的两种来源

过去每个大类页面里都内嵌一份服务器配置表单（Komga/Kavita/Calibre-Web、Plex/Emby/Jellyfin、
Navidrome/道理鱼），这也是大类入口在侧栏和顶栏反复出现的根因。现在外连服务和本地库一样，
只是媒体库的一种来源：

- 在「媒体库增加 → 外连服务」里填服务名称、内网地址、反代域名，保存后出现在侧栏媒体库列表
- 内网访问自动走内网地址，公网访问自动走反代域名（原 `serviceAccessUrl` 的自动切换逻辑保留，
  Navidrome 根路径仍会自动补 `/app/`）
- 大类页面只剩内容宿主，由「本地媒体库 / 外连服务」切换条决定显示本地文件还是嵌入服务页

### 系统设置与关于并入账户头像，并支持头像设置

顶栏右上角的 ⚙ 与 ℹ 两个按钮取消，改为左侧账户头像的下拉菜单：头像设置、系统设置、关于、退出登录，
菜单头部直接显示当前登录状态。头像设置支持文字缩写/emoji、背景色和上传图片，
仅保存在本浏览器 `localStorage`（键 `vaulthub_avatar_v1`），不上传服务器。

### 顶栏去掉首页/资料库按钮，右侧只放信息

顶栏的横向主导航（首页 / 资料库 / PT 管理）整体移除，导航统一由侧边栏负责。
顶栏左侧是品牌与账户头像，右侧改成信息区：媒体库总量与总项目数、正在构建的索引统计，不再放任何按钮。

### 首页最近入库点击即读取播放

首页海报卡片以前直接调 `openLocalMedia()`，但阅读器容器 `#local-media-viewer-<group>`
只有在对应媒体库视图渲染之后才存在，所以在首页点击等于什么都没发生。现在改走
`openHomeMediaItem()`：先切到该库的视图、等容器就绪，再打开阅读器；音乐文件直接进播放器。

### 顺带修掉两个缺陷

- **登录后遮罩偶发重新弹出**：启动探测与 60 秒轮询是异步的，慢响应可能在用户登录成功之后才回来，
  用过期结果把状态改回未登录。现在登录/退出会推进 `vaultHubAuthEpoch`，过期探测结果直接丢弃。
- **TXT 打开后误报「文本读取失败」**：滚动定位和文本读取在同一个 `try` 里，
  `scrollIntoView` 抛错会让已经渲染好的正文被一条读取失败的红字替换。滚动已移出 `try`
  并收进 `scrollViewerIntoView()` 守卫。

## v0.6.31 更新

### 系统设置里可以退出登录

系统设置新增「账户与登录」标签页。退出会先 `POST /api/logout` 让服务端销毁 Session，再复位前端状态、
关闭弹窗与 Caddy 页面并弹出登录遮罩；主题、语言、侧栏宽度等本机偏好保留不清。

### Caddy 配置改为独立整页

Caddyfile 动辄百余行，挤在弹窗里没法看。系统设置的 Caddy 标签页现在只保留入口按钮和
「已配置 N 条路由」徽标，点击进入铺满视口的整页编辑器，textarea 吃掉全部剩余高度，
顶部固定「保存并应用 / 重新载入 / 关闭」和行数徽标。保存仍由内置 Caddy 校验并热加载，失败自动回滚。

### 「检测显卡」现在真的会检测

此前 `/api/media/hardware` 返回的是硬编码占位值 —— 永远 `selected: cpu`、`vaapi/qsv/cuda` 永远 false，
所以点按钮不会有任何变化。现在后端做真实探测：

- 枚举 `/dev/dri/renderD*` 判断有没有 DRM 渲染节点（可用 `VAAPI_DEVICE` 指定）
- 检查 `/dev/nvidiactl`、`/dev/nvidia0`、`/dev/nvidia-uvm` 判断 NVIDIA 透传
- 跑 `ffmpeg -encoders` 解析实际编译进的编码器（`h264_vaapi` / `h264_qsv` / `h264_nvenc` / `libx264`），
  结果缓存避免重复起进程
- `auto` 按 QSV → CUDA → VAAPI 择优；显式指定但不可用时回退 CPU

前端显示「当前 / 可用」徽标加一行明细（DRM 设备路径、NVIDIA 设备节点、FFmpeg 编码器列表），
点按钮给出 toast 反馈，文案三语齐全。

### 登录状态监测

- 启动时和每 60 秒核对 `/api/system/runtime`，在设置页显示「登录状态正常 / 异常」徽标
- 增删媒体库前先确认服务端会话，异常时直接提示「登录状态异常，请重新登录后再添加/删除媒体库」
  并弹出登录遮罩，不再让用户点了按钮却毫无反应
- 任何受保护请求返回 401 都会同步刷新徽标；切换语言时徽标与提示会重绘

### 视频缓存加速

原实现在缓存未命中时要等 FFmpeg 把整个文件转完、落盘、再从头发送，多 GB 的片子等于打不开。现在分两条路：

- **缓存未命中**：直接把 FFmpeg 输出以 fragmented MP4（`+frag_keyframe+empty_moov+default_base_moof`）
  流式推给浏览器，逐块 flush，第一个 fragment 到达就能起播；响应头 `X-VaultHub-Compat: live`
- **同时**在后台用脱离请求生命周期的 context 生成 `+faststart` 的可 seek 版本，下次打开直接命中缓存
  并支持 Range（`X-VaultHub-Compat: cache`）。同一 cache key 的后台构建会去重，
  可用 `COMPAT_PRECACHE=0` 关闭预缓存
- 源视频已是 H.264 时继续 `-c:v copy`；需要重编码时按检测到的硬件走
  `h264_vaapi` / `h264_qsv` / `h264_nvenc`，软件回退用 `-preset veryfast`
- 音频统一 AAC 立体声 160k，仍按 `audio_track` 选轨

实测（隔离容器，60 秒测试片）：首次请求 TTFB 约 0.19–0.20 秒即开始出流；后台预缓存落盘后
第二次请求 TTFB 约 0.001 秒、`Accept-Ranges: bytes`、Range 请求返回 206。

## v0.6.30.Branch-update 分支更新（界面改版，已合入 v0.6.31）

界面改成 Plex Web 风格：

- 配色从 GitHub 深蓝（`#0D1117` / `#58A6FF`）换成 Plex 灰青（底色 `#1E1E1E`，主色 `#54C0C0`，
  明亮主题主色加深为 `#0F8F8F` 保证对比度），圆角由 10px 收到 6px，去掉毛玻璃效果，整体密度提高。
- 导航改为双层：新增全宽顶栏放品牌、横向主导航（首页 / 资料库 / PT 管理）和右上工具区，
  原侧栏下移到顶栏之下。~~横向主导航与右上工具区~~已在 v0.7.0 移除：顶栏右侧只放信息，
  系统设置/关于收进账户头像菜单。
- 侧栏宽度可拖拽（62–340px，默认 236px），宽度记忆在 `localStorage` 的 `vaulthub_sidebar_w`；
  折叠后变成 62px 图标栏。
- ~~侧栏分类由「主导航 / 媒体 / 系统 / 自定义」改为「主导航 / 电子书刊 / 影视作品 / 音视作品 / 自定义」，
  每组列出该大类下的媒体库并带「更多 ›」入口。~~ v0.7.0 改为「主导航 / 媒体库 / 自定义」，
  媒体库是一个扁平列表，不再重复展示三个大类。

首页重构为四个板块：

1. **服务器监控** —— CPU、内存、网络、磁盘四张指标卡，磁盘卡显示剩余容量，阈值 90% 标红、75% 标黄。
2. **正在进行中的操作** —— 展示当前播放会话与刮削信息；没有会话时显示占位提示。
3. **最近入库** —— 电子书刊 / 影视作品 / 音视作品三条海报轨，按入库时间倒序；音视作品用方形封面。
4. ~~**媒体库路径管理**~~ —— 表格按「具体路径 + 手动命名」维护媒体库，手动名称即刮削库名，
   分三大类六子类（电子书刊：漫画 / 电子书；影视作品：电影 / 剧集；音视作品：音乐 / MV）。
   v0.7.0 起该表格迁至「系统设置 → 媒体库」，首页只保留前三个板块。

其他调整：

- **移除容器管理（Docker）和青龙面板**，两者不再作为可添加模块出现。老配置里残留的 `docker`
  条目会被自动过滤，不影响其余模块显示；仍需要容器管理请留在 v0.6.30。
- 后端 `/api/media/files` 新增 `sort=mtime` 参数支撑「最近入库」，默认仍按 `path` 排序，
  文件浏览器的字母序不变。

顺带修掉四个既有缺陷：

- 登录遮罩显隐反了。`classList.toggle('hidden', !logged)` 配合 `.auth-mask.hidden{display:none}`，
  登录成功时反而把遮罩显示出来盖住页面，已改为 `!!logged`。
- 海报标题解析。影视标题会带出 `2160p`、`WEB-DL`、`S01E12` 等发布规格，音乐的「歌手 - 歌名」
  在连字符被归一化成空格后切不出歌手；改为在原始文件名上先剥离规格再归一化。
- 音乐刮削张冠李戴。MusicBrainz 的 `/recording` 检索总会返回「最像」的一条，之前无条件采纳
  `recordings[0]`，导致「周杰伦 - 七里香.mp3」被刮成标题「周杰倫」、歌手「王泰翔 2000wtx」。
  改为结构化查询（`recording:"…" AND artist:"…"`）加打分与文本双重校验，`score` 低于 88
  或标题/歌手对不上就保留文件名解析结果。
- 语言切换只翻译一半。英文与繁中的 i18n 词典缺 55 个新键，而首页表格、子类型下拉、海报占位、
  刮削状态徽标等文案由 JS 拼装，`applyI18n()` 只覆盖静态 `data-i18n` 节点，切到英文后大面积
  残留简体中文。补齐三语词典（键集完全一致），新增 `tf()` 占位符插值函数把动态文案也纳入词典，
  并让 `setLang()` 重跑首页各渲染器。

## v0.6.18 更新

- Docker Compose 支持 `/dev/dri` 透传，并提供 NVIDIA Container Toolkit 的 `gpus` 配置示例。
- 系统设置新增显卡加速选项：自动、CPU、VAAPI、Intel QSV、NVIDIA CUDA/NVENC。
- `/api/media/hardware` 检测设备和 ffmpeg 编码器；硬件不可用自动回退 CPU。
- `/api/media/compat` 支持 `hw` 参数，响应头 `X-VaultHub-Hardware` 显示实际使用的加速模式。
- 长 TXT 按 Range 分块读取并完整合并，不再只缓存/显示首屏。
- TXT 继续自动识别 UTF-8，失败时回退 GB18030。
- 电子书正文、目录、阅读背景同步系统暗色、亮色和自定义主题；切换主题时已打开阅读器即时更新。

## GPU 配置

Intel/AMD VAAPI 或 QSV：

```yaml
environment:
  FFMPEG_HWACCEL: "auto"
  VAAPI_DEVICE: "/dev/dri/renderD128"
devices:
  - /dev/dri:/dev/dri
```

CPU-only主机请保持默认 Compose 不映射 `/dev/dri`；需要 VAAPI/QSV 时，在服务的 `devices:` 下取消注释并重建容器。NVIDIA 主机使用 `gpus: all`，并使用带 NVENC 支持的 CUDA 运行时镜像。

NVIDIA：宿主机安装 NVIDIA Container Toolkit 后，在 Compose 中启用：

```yaml
gpus: all
environment:
  FFMPEG_HWACCEL: "cuda"
  NVIDIA_VISIBLE_DEVICES: "all"
  NVIDIA_DRIVER_CAPABILITIES: "compute,video,utility"
```

硬件设备、权限或 ffmpeg 编码器不可用时会自动回退 CPU，不影响播放。


- 新增 `/api/media/probe`，使用 ffprobe 判定容器和音频编码是否可能被浏览器直接支持。
- 新增 `/api/media/compat`，直连无声或不兼容时输出 H.264 + AAC 的 MP4 兼容流。
- 前端自动判定规则：MKV/AVI/RMVB/WMV/FLV/TS/M2TS/VOB/ISO 等容器直接使用兼容流；MP4/WebM 等先直连，再结合 probe 的音频编码结果自动切换。
- 播放器保留“直连原片”和“音频兼容”手动按钮，直连错误时自动切换兼容流。
- 桌面端视频阅读器不再覆盖左侧边栏，只占用侧栏右侧空间；移动端继续全屏。

## v0.6.16 更新

- 删除 0.6.16 之后引入的转码/画质切换功能，影视播放改回 `/api/media/file` 直连。
- 视频播放器不再自动播放，避免浏览器拦截有声自动播放；加载元数据后强制取消静音并恢复音量。
- 视频阅读窗口铺满当前页面阅读区域，隐藏视频下方提示信息。
- 放开电子书、漫画、PDF/图片阅读窗口高度限制，阅读器按可视窗口拉伸。

## v0.6.15 更新

- 漫画本地库支持：EPUB、MOBI、ZIP、CBZ、PDF、RAR、CBR、7Z、CB7、JPG/PNG 等散图、CPG、LZH、CBL、TAR、CBT。
- 电子书本地库支持：EPUB、PDF、MOBI、AZW/AZW3、CHM、EXE、UMD、JAR/JAD、CAJ、PDG、DJVU、CEB、DOC/DOCX、XPS、TXT。
- 影视栏目新增“本地媒体库 / 外连服务”切换；本地库支持 MP4、MKV、AVI、MOV、WEBM、TS/M2TS、WMV、FLV、MPG/MPEG、RMVB、ISO 等影片文件。
- 影视本地库支持文件名兜底展示、豆瓣默认刮削、`TMDB_API_KEY` 环境变量启用 TMDB 刮削代理。

### TMDB 可选配置

```yaml
environment:
  - TMDB_API_KEY=你的_tmdb_api_key
```

未配置 `TMDB_API_KEY` 时，影视库仍可正常读取和播放，刮削失败会使用文件名展示。


- 新增本地媒体库设置：名称、类型和多个容器目录路径。
- 媒体源可在“本地媒体库”和原有“外连服务”之间切换。
- 本地音乐支持浏览器原生播放，本地图片/TXT/PDF 支持直接预览，其他电子书和压缩漫画可下载或由浏览器支持能力打开。
- 本地媒体文件通过 `home.examples.top/api/media/*` 同源访问，浏览器不会连接 NAS 内网 IP。
- 媒体列表接口只返回库配置；文件索引由后台单线程低速任务生成，带临时文件原子替换，避免页面请求阻塞。
- 文件列表使用 `/api/media/files` 分页接口，默认每页 100 条，避免一次性构造巨型 JSON 和浏览器 DOM。
- 扫描会跳过 `@eaDir`、`.cache`、`#recycle`，并按批次休眠降低磁盘 I/O 竞争；索引保存到 `/data/media-index`。
- TXT 预览按 1 MiB Range 分块读取并完整合并；不一次性请求超大正文，同时保证长文末尾和全部章节可读。
- 媒体库路径改为任意容器内已挂载的绝对目录，不再强制要求 `/media` 前缀；仍保留真实路径和符号链接逃逸校验。

- 项目名称改为 `VaultHub 蜀鼠之家`。
- Compose 服务名为 `vaulthub`，容器名为 `VaultHub`。
- ~~本地镜像名为 `vaulthub:0.6.0-local`。~~（旧的本地构建方式，保留兼容；当前推荐直接使用 `ghcr.io/q807738511/vaulthub:latest` 或固定版本标签。）

## 镜像拉取与加速站

镜像发布在 GitHub Container Registry：

```
ghcr.io/q807738511/vaulthub:<版本标签>   # 例如 v0.8.0
ghcr.io/q807738511/vaulthub:latest        # 随 main 漂移，生产不建议
```

**建议固定版本标签部署（如 `v0.8.7`），不要用 `latest`**：`latest` 会随每次推送变化，出问题难回滚。

### 中国网络：直连 GHCR 拉不动怎么办

部分网络（含家庭 NAS）直连 `ghcr.io` 会在大层（约 175MB 的 Debian + ffmpeg 层）卡住，表现为 Docker 反复 `Retrying`、镜像拉不全、容器起不来后被 `unless-stopped` 反复重启。**这不是镜像或构建问题，是拉取线路对 GHCR 限速。** 换加速站即可，镜像内容完全一致（digest 相同）。

可用加速站（实测拉取本仓库镜像成功，digest 与官方一致）：

| 加速站 | 前缀 | 备注 |
|--------|------|------|
| 南京大学 | `ghcr.nju.edu.cn` | 稳定，推荐 |
| 1ms.run | `ghcr.1ms.run` | 可用，偶发 `unknown blob`，重试一次即可 |

> 加速站可能随时失效或限流；若某个不可用，换另一个或稍后重试。`ghcr.m.daocloud.io` 不支持本仓库路径转发（`pull access denied`），请勿使用。

用法一——compose 直接写加速站地址（最简单）：

```yaml
services:
  vaulthub:
    image: ghcr.nju.edu.cn/q807738511/vaulthub:v0.8.7
```

> 注意只有一个冒号：`vaulthub:v0.8.7`，不是 `vaulthub::v0.8.7`。

用法二——保持 compose 用官方名，手动拉取后打回原名（便于随时切回直连）：

```bash
docker pull ghcr.nju.edu.cn/q807738511/vaulthub:v0.8.7
docker tag  ghcr.nju.edu.cn/q807738511/vaulthub:v0.8.7 ghcr.io/q807738511/vaulthub:v0.8.7
# compose 仍写 image: ghcr.io/q807738511/vaulthub:v0.8.7
docker compose up -d
```

用法三——给 Docker daemon 配 registry 镜像（一劳永逸，需重启 Docker）：编辑 `/etc/docker/daemon.json` 后 `systemctl restart docker`（会短暂影响所有容器）。
- 左上角页面名改为 `蜀鼠之家`，图标改为动画中华鼠图标。
- 电子书和漫画合并为 `超漫画`，统一包含 Komga / Kavita / Calibre-Web。
- 新增 WebUI 的 `Caddy 配置` 页面，可读取、保存并热加载容器内 Caddyfile。
- YAML 只保留首次启动预配置；实际 Caddyfile 持久化到 `./data/Caddyfile`。
- 保留 v0.4.2 的 Komga 路由修复和媒体公网自动映射。

## 首次配置

v0.8.7 起部署配置分两个文件，都放在 compose 同一目录：

| 文件 | 放什么 | 什么时候改 |
|------|--------|-----------|
| `docker-compose.yml` | 镜像标签、端口、卷、以及常用环境变量 | 换版本、改路径、改账号时 |
| `VaultHub.env` | 容器内固定路径、官方 API 地址、监控挂载点、缓存清理策略、硬件能力声明 | 基本不用改 |

compose 通过 `env_file` 加载 `VaultHub.env`，因此 compose 里只剩下你会经常调的那几项：`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`TMDB_API_KEY`、`MEDIA_SCRAPER_MODE`、`MEDIA_CACHE_DIR`、`SYSTEM_MONITOR_FILESYSTEMS`。硬件转码选择 `FFMPEG_HWACCEL` 放在 `VaultHub.env` 中统一管理，默认值为 `auto`。

> 关于代理：TMDB 客户端使用自带 SSRF 防护的自定义 `http.Transport`，没有设置 `Proxy`，所以 `PROXY_HOST` 和标准的 `HTTPS_PROXY` 都不会生效。若你的网络必须走代理才能访问 `api.themoviedb.org`，请在网关或 Clash 侧做透明代理/分流。

两个文件的环境变量都必须写成 `KEY=value`：

```yaml
    env_file:
      - ./VaultHub.env
    environment:
      - ADMIN_USERNAME=${ADMIN_USERNAME:-ADMIN}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-ADMIN123}
```

在 `environment` 列表里写成 `- KEY: "value"` 会让 compose 报
`services.vaulthub.environment.[N]: unexpected type map[string]interface {}` —— 列表项里的 `KEY: value` 会被 YAML 解析成映射而不是字符串。同一段里不要混用列表写法（`- KEY=value`）和映射写法（`KEY: value`）。

改完 `VaultHub.env` 需要重建容器才会重新注入，`restart` 不够：

```bash
docker compose up -d --force-recreate
```

**`VaultHub.env` 必须和 compose 放在同一目录**：文件缺失时 `docker compose` 会直接报 `env file ... not found` 并拒绝启动。`scripts/install.sh` 和 `scripts/upgrade.sh` 会自动投递它，已存在时保留你的改动。

旧的变量化 `.env` 写法仍兼容，但当前家庭 NAS 固定部署不再要求使用：

- ~~`WEBUI_PORT=8088`~~
- ~~`NAS_IP=192.168.112.3`~~
- ~~`DASHBOARD_ORIGIN=https://home.examples.top`~~
- ~~`ADMIN_TOKEN`~~（v0.8.0 已删除，写接口统一使用登录 Session）

端口和媒体卷可以直接写在 Compose 中。`NAS_IP`、`DASHBOARD_ORIGIN`、`WEB_ROOT`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 已有镜像默认值；当前环境不变时无需重复声明。v0.8.0 起 Caddy 与媒体库写操作均要求先使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。

## 本地媒体目录

~~先在 `.env` 中填写 NAS 的宿主机目录：~~（旧的变量化媒体路径方式，仍兼容但不再推荐。）

- ~~`MUSIC_PATH=/vol2/link/音乐`~~
- ~~`COMIC_PATH=/vol3/漫画`~~
- ~~`BOOK_PATH=/vol4/电子书`~~

~~Compose 会把它们只读映射为 `/media/music`、`/media/comics`、`/media/books`。~~

当前推荐直接在 Compose 中配置只读卷。可以映射一个公共媒体根目录：

```yaml
volumes:
  - ./data:/data
  - /media:/media:ro
```

也可以只映射需要的具体目录：

```yaml
volumes:
  - ./data:/data
  - /vol2/link/音乐:/media/music:ro
  - /vol3/漫画:/media/comics:ro
  - /vol3/1000/komga/书画:/media/books:ro
```

宿主机路径写在冒号左边，容器路径写在右边，`:ro` 表示只读。容器路径在
**账户头像 → 系统设置 → 媒体库 → 媒体库增加 → 本地媒体库** 里填写（v0.7.0 起首页不再有该表单）：

```text
/media/music
/media/comics
/media/books
```

同一媒体库可添加多个路径。跨卷时可在 Compose 的 `volumes` 中继续增加只读映射，例如：

```yaml
- /vol5/音乐:/media/music-vol5:ro
```

然后在同一个音乐库中添加 `/media/music-vol5`。为避免泄露容器文件，媒体 API 只接受容器内已挂载的绝对目录。

首次添加后媒体库会立即开始建立索引，「系统设置 → 媒体库」的表格与该库页面都会显示实时进度
（已扫描数量、百分比、已用时长），大库可以随时点「取消构建」中止。

## 界面导览（v0.7.0）

| 位置 | 内容 |
| --- | --- |
| 顶栏左侧 | 品牌 + 账户头像。头像菜单：头像设置 / 系统设置 / 关于 / 退出登录 |
| 顶栏右侧 | 只读信息：媒体库与项目总数、正在构建的索引，无按钮 |
| 侧边栏 | 主导航（首页、PT 管理）→ 媒体库（你创建的库名与外连服务）→ 自定义模块 |
| 首页 | 服务器监控 / 正在进行中的操作 / 最近入库（点击海报直接开始阅读或播放） |
| 系统设置 → 媒体库 | 已添加媒体库表格（重新刮削 / 打开 / 删除）+ 媒体库增加（本地媒体库、外连服务） |
| 系统设置 → Caddy | 入口按钮与路由数徽标，编辑器为独立整页 |
| 系统设置 → 外观主题 | 语言、主题、背景图、侧栏宽度、模块设置入口 |
| 系统设置 → 刮削与硬件 | 刮削来源、重新刮削、显卡检测 |
| 系统设置 → 账户与登录 | 登录状态与退出登录 |

资源大类（电子书刊 / 影视作品 / 音视作品）只在配置媒体库时用于选择子类型和刮削源，
不再作为侧边栏或顶栏的导航入口。

## 公网接入方案

VaultHub 支持两种公网接入方式：

1. **Cloudflare Tunnel（推荐）**：无需公网 IP，也无需路由器开放 80/443。
2. **传统反向代理**：公网 DNS + 路由器端口转发 + Lucky/NPM；需要可用公网 IP。

两种方式的核心规则相同：`home`、`kom`、`yy` 三个域名都必须先进入 VaultHub 的 `8088`，再由容器内 Caddy 按 Host 分流。不要把 `kom` 直接代理到 `25600`，也不要把 `yy` 直接代理到 `4533`，否则会绕过 Caddy 的 iframe 响应头处理。

### 方案一：Cloudflare Tunnel

在 Cloudflare Zero Trust → Networks → Tunnels → Public Hostnames 添加：

```text
home.examples.top  -> HTTP -> 192.168.112.3:8088   # VaultHub 主页
kom.examples.top   -> HTTP -> 192.168.112.3:8088   # Caddy 再转 Komga :25600
yy.examples.top    -> HTTP -> 192.168.112.3:8088   # Caddy 再转 Navidrome :4533
```

Cloudflare 提供公网 HTTPS，Tunnel 到 NAS 使用内网 HTTP。三条记录应属于同一个在线 Tunnel，DNS CNAME 应指向同一个 `<tunnel-id>.cfargotunnel.com`。

验证：

```bash
curl -I https://home.examples.top/
curl -I https://kom.examples.top/
curl -I https://yy.examples.top/app/
curl -sI https://kom.examples.top/ | grep -i content-security-policy
```

最后一条应包含 `frame-ancestors https://home.examples.top`。若返回 522，先检查该域名的 Public Hostname 是否指向 `192.168.112.3:8088`，再确认 DNS 没有指向旧 Tunnel。

### 方案二：公网 DNS + Lucky/NPM 传统反向代理

适合不使用 Tunnel、家里有公网 IPv4，或已正确配置 IPv6 入站访问的环境。IPv4 处于运营商 CGNAT 时不能使用此方案，除非先申请公网 IP。

访问链路：

```text
浏览器 HTTPS :443
  -> 公网 DNS（home/kom/yy 指向家庭公网 IP）
  -> 路由器 TCP 443 端口转发
  -> Lucky 或 Nginx Proxy Manager
  -> http://192.168.112.3:8088
  -> VaultHub 内置 Caddy 按 Host 分流
```

#### 1. DNS 解析

在域名 DNS 服务商添加三条记录：

```text
A     home  -> 家庭公网 IPv4
A     kom   -> 家庭公网 IPv4
A     yy    -> 家庭公网 IPv4
```

若公网 IP 会变化，先在 Lucky/路由器配置 DDNS。使用 IPv6 时创建 AAAA 记录，并确认 NAS、代理和防火墙都允许 IPv6 443 入站。若 DNS 托管在 Cloudflare，传统源站模式可使用橙云代理，但它不等于 Tunnel，源站仍需开放 443。

#### 2. 路由器端口转发

```text
公网 TCP 443 -> Lucky/NPM 所在主机的 TCP 443
公网 TCP 80  -> Lucky/NPM 所在主机的 TCP 80（证书 HTTP 验证或跳转，可选）
```

不要把公网端口转发到 VaultHub 管理 API，也不要开放 `9099`。若运营商封锁 80，可使用 DNS Challenge 申请证书；443 仍需公网可达。

#### 3. Lucky 配置

创建 HTTPS Web 服务监听（通常为 443），申请 `home.examples.top`、`kom.examples.top`、`yy.examples.top` 证书，并建立三个按主机名匹配的子规则：

```text
前端域名 home.examples.top -> 后端 http://192.168.112.3:8088
前端域名 kom.examples.top  -> 后端 http://192.168.112.3:8088
前端域名 yy.examples.top   -> 后端 http://192.168.112.3:8088
```

启用 WebSocket，保留原始 `Host` 请求头，并设置 `X-Forwarded-Proto: https`。不要使用 Lucky 管理端口 `16601` 作为反代入口。

#### 4. Nginx Proxy Manager 配置

分别新建三个 Proxy Host：

```text
Domain Names: home.examples.top / kom.examples.top / yy.examples.top
Scheme:       http
Forward Host: 192.168.112.3
Forward Port: 8088
Websockets:   开启
SSL:          为每个域名申请证书，开启 Force SSL
```

NPM 默认会转发原始 Host；不要在 Advanced 中覆盖成 `Host 192.168.112.3`。三个域名虽然共用同一个目标端口，但 Caddy 会根据原始 Host 分别返回 VaultHub、Komga 和 Navidrome。

#### 5. 安全与验证

- 路由器只开放反向代理的 80/443，不开放 `8088`、`4533`、`25600`、`61208` 或 `9099`。
- 建议在 `home.examples.top` 前增加额外访问控制；VaultHub 管理写操作使用 HttpOnly 登录 Session。
- `DASHBOARD_ORIGIN` 必须保持 `https://home.examples.top`。

```bash
curl -I https://home.examples.top/
curl -I https://kom.examples.top/
curl -I https://yy.examples.top/app/
curl -sI https://kom.examples.top/ | grep -i content-security-policy
```

### 两种方案对比

| 项目 | Cloudflare Tunnel | 传统反向代理 |
|---|---|---|
| 公网 IP | 不需要 | 需要公网 IPv4 或可入站 IPv6 |
| 路由器开放端口 | 不需要 | 需要转发 443，通常还需 80 |
| HTTPS 证书 | Cloudflare 托管 | Lucky/NPM 自行申请和续期 |
| 源站 IP 暴露 | 不暴露 | 通常会暴露 |
| 故障点 | cloudflared、Tunnel DNS | DDNS、端口转发、证书、防火墙 |
| VaultHub/Caddy 配置 | 相同 | 相同 |

当前环境已使用 Tunnel，继续使用方案一最省事。方案二适合作为不依赖 cloudflared 的备用接入方式，两种方案不建议让同一域名同时生效，以免 DNS 流量指向不一致。

