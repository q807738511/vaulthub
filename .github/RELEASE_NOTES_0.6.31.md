# VaultHub v0.6.31

本版把 `v0.6.30.Branch-update` 分支的 Plex 风格界面改版合入 main，并在其基础上修掉用户报告的五个问题。

## 1. 系统设置里可以退出登录

系统设置新增「账户与登录」标签页，内含退出登录按钮。退出会先 `POST /api/logout`
让服务端销毁 Session，再复位前端状态、关闭弹窗与 Caddy 页面并弹出登录遮罩。
主题、语言、侧栏宽度等本机偏好保留不清。

## 2. Caddy 配置改为独立整页

Caddyfile 内容动辄百余行，挤在弹窗里没法看。现在系统设置的 Caddy 标签页只保留
入口按钮和「已配置 N 条路由」徽标，点击后进入铺满视口的 `#caddyPage` 整页编辑，
textarea 吃掉全部剩余高度，顶部固定「保存并应用 / 重新载入 / 关闭」和行数徽标。
顶栏 ⚙ 打开系统设置后仍会默认停在 Caddy 标签页。

## 3. 「检测显卡」现在真的会检测

之前 `/api/media/hardware` 返回的是硬编码占位值 —— 永远 `selected: cpu`、
`vaapi/qsv/cuda` 永远 false，所以点按钮什么都不会变。

后端新增真实探测：
- 枚举 `/dev/dri/renderD*` 判断有没有 DRM 渲染节点（可用 `VAAPI_DEVICE` 覆盖）
- 检查 `/dev/nvidiactl`、`/dev/nvidia0`、`/dev/nvidia-uvm` 判断 NVIDIA 透传
- 跑 `ffmpeg -encoders` 解析实际编译进的编码器（`h264_vaapi` / `h264_qsv` /
  `h264_nvenc` / `libx264`），结果缓存避免重复起进程
- `auto` 按 QSV → CUDA → VAAPI 顺序择优，显式指定但不可用时回退 CPU

前端把结果显示成「当前 / 可用」徽标加一行明细（DRM 设备路径、NVIDIA 设备节点、
FFmpeg 编码器列表），点按钮会给出 toast 反馈，文案三语齐全。

## 4. 登录状态监测

- 启动时和每 60 秒核对一次 `/api/system/runtime`，在设置页显示「登录状态正常 /
  异常」徽标
- 增删媒体库前先调用 `ensureSessionForWrite()`，状态异常直接给出「登录状态异常，
  请重新登录后再添加/删除媒体库」并弹出登录遮罩，不再让用户点了按钮却毫无反应
- 任何受保护请求返回 401 都会同步刷新徽标
- 切换语言时徽标与提示会重绘

## 5. 视频缓存加速

原实现在缓存未命中时要等 FFmpeg 把整个文件转完、落盘、再从头发送，多 GB 的片子
等于永远打不开。

现在分两条路：
- **缓存未命中**：直接把 FFmpeg 输出以 fragmented MP4
  （`+frag_keyframe+empty_moov+default_base_moof`）流式 `pipe:1` 推给浏览器，
  逐块 flush，第一个 fragment 到达就能起播；响应带 `X-VaultHub-Compat: live`
- **同时**在后台用脱离请求生命周期的 context 生成 `+faststart` 的可 seek 版本，
  下次打开直接命中缓存并支持 Range（`X-VaultHub-Compat: cache`）。
  同一 cache key 的后台构建会去重，可用 `COMPAT_PRECACHE=0` 关闭
- 源视频已是 H.264 时继续 `-c:v copy`；需要重编码时按检测到的硬件走
  `h264_vaapi` / `h264_qsv` / `h264_nvenc`，软件回退用 `-preset veryfast`
- 音频统一 AAC 立体声 160k，仍按 `audio_track` 选轨

## 合入的分支改版（原 v0.6.30.Branch-update）

同时并入两个界面层提交，不改后端能力：

- **Plex 风格改版**：配色由 GitHub 深蓝改为 Plex 灰青（`#1E1E1E` / `#54C0C0`），
  圆角收窄、去毛玻璃；首页重构为服务器监控 / 正在进行 / 最近入库 / 媒体库路径
  四栏，侧栏按媒体库逐项列出，新增 `web/js/05-home.js`；移除已废弃的
  「容器管理」模块。
- **三语 i18n 补齐与音乐刮削修正**：zh-CN / zh-TW / en 词典键集严格一致，新增
  `tf(key, vars)` 占位符插值让动态文案也走词典；MusicBrainz 检索改为结构化
  查询 + `audioMatchAcceptable()` 打分校验（score ≥ 88、标题双向包含、歌手需
  对得上），不再无条件采纳 `recordings[0]` 造成「周杰伦 - 七里香」被刮成无关
  条目。

## 验证

契约测试 25/25 通过（新增 `tests/test_v0631_session_caddy_hw_cache.py`），
`media-go` gofmt/vet/build 通过，`web/js` 全部 `node --check` 通过，
三语词典键集严格一致。真实构建镜像并起容器实测各接口与静态资源。
