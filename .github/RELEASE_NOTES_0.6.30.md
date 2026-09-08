# VaultHub v0.6.30 · 监控修复、播放兼容与内嵌字幕

本版聚焦修复用户反馈的页面与播放问题。

## 首页 NAS 监控（全部修复）
- **CPU 使用率**：改为按 `/proc/stat` 两次采样差值计算真实忙碌百分比（此前恒为 0）。
- **CPU 核心数 / 温度**：新增，核心数取自 `/proc/stat`，温度取自 `coretemp`/`k10temp`/`cpu_thermal`。
- **网络**：自动选择物理网卡（跳过 lo/veth/br-/docker/ovs），读取真实 rx/tx 字节并显示网卡名（如 `enp7s0`）；此前恒为 0。
- **硬盘温度**：读取 `/host/sys/class/hwmon` 全部 `tempN_input`；优先展示独立硬盘/NVMe 传感器（`drivetemp`/`nvme`），无独立传感器时回退展示系统传感器读数并标注，不再永久 `--`。
- **硬盘容量**：`statfs` 逐卷读取，返回真实已用/总量/百分比。
- **内存**：新增 Swap 已用/总量。

## 影视播放与刮削
- **兼容流不再全量转码**：视频已是 H.264 时直接 `-c:v copy`（秒开），仅在必要时才重编码；音频统一转 AAC 双声道。修复大文件点开兼容流长时间无响应/失败。
- **音轨选择**：`/api/media/compat` 支持 `audio_track` 参数并以 `-map` 精确选轨，缓存键包含音轨编号，多音轨互不覆盖。
- **字幕（内嵌）**：`/api/media/streams` 现返回内嵌字幕轨；新增 `/api/media/subtitles/extract` 将文本字幕实时提取为 WebVTT 挂载到播放器（位图字幕 PGS/DVD 自动跳过）；播放器字幕菜单自动列出内嵌字幕。

## 页面与设置
- **右上角「系统设置」「Caddy 配置」按钮**：去掉失效的 `guardProtectedAction` 包裹，直接打开弹窗；受保护接口仍由后端会话鉴权。
- **Caddy 配置弹窗**：移除无实际作用的「外部域名」「管理令牌」输入框（后端不消费），只保留 Caddyfile 编辑、保存并热加载。
- **关于页技术栈/版本**：更新到 v0.6.30，技术栈如实标注 `Go (media/manager/subtitle) · Caddy · FFmpeg · SQLite · HTML/CSS/JS`；侧边栏版本号同步。

## 验证
- media-go 本地跑真实 `/proc`+`/sys`：CPU%、核心、温度、网卡、容量、Swap 均返回真实值。
- compat 对 H.264 源实测 0.3s 返回（copy 路径），输出 `h264+aac` MP4。
- streams 返回 audio_tracks / subtitle_tracks 结构。
- 全部 `tests/test_*.py` 22 项通过；`manager` go test 通过；media-go/subtitle-api go build + vet 通过。
