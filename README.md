# VaultHub · 蜀鼠之家

**自托管一站式媒体中心**：把你的电影、剧集、音乐、漫画、电子书放进同一个 Web 界面，统一刮削、播放与阅读。

> 常见的影视、音频、漫画、电子书等容器都是功能比较单一的（PLEX/EMBY：影视、音频；Komga：纯漫画；Navidrome：纯音乐向）。参考这个思路，把它们聚合到一起又做了轻量化，后续可能会做成 APP，可以期待下（有隐藏功能可以挖掘一下）。

📌 完整更新日志见 [Update Log.md](Update Log.md) · 各版本发布说明见 `.github/RELEASE_NOTES_*.md`

---

## 功能介绍

### 🎬 影视：智能播放与转码

使用自刮削和源文件刮削混合模式，可以配合 MoviePilot 容器使用其刮削后的文件进行读取；自带刮削能力需要填写 TMDB 的 API Key 并赋予容器代理能力才能实现（也可以通过 MP 的硬链接来使用 115 等网盘的影视资源）。

1. 播放器按 **原生直连 → FFmpeg 兼容流 → 转码流** 自动切换，音频不兼容自动重编码为 AAC
2. 画质档位：自动 / 原画直放 / 1080p / 720p / 480p，转码结果分档缓存
3. **硬件转码自动探测**：`auto` 按 QSV → CUDA/NVENC → VAAPI 择优，不可用时自动回退 CPU（libx264）
4. 悬浮控制栏、全屏、倍速、音轨/字幕选择、播放列表与剧集连播、中断自愈与画质记忆
5. 内置 ffprobe 探测 + 转码缓存自动清理；在线字幕与提取内嵌字幕为 WebVTT
6. 详情页右上角「← 返回详情 / ← 返回媒体库」**横向药丸**返回按钮，按语境回退到剧集详情或媒体库

### 🎵 音乐：刮削、歌词与收藏

使用自刮削模式读取并写入海报信息（iTunes 源），刮削准确性非常不错；UI 也采用类似 Apple 的按钮风格。

1. 刮削主源 iTunes Search（免密钥），MusicBrainz 兜底；命中即落**封面 sidecar** 持久化，换浏览器/清缓存不丢
2. 歌手维度独立刮削（单人/组合/合作演唱），头像圆形展示并标注「合作演唱」；专辑与歌手都可 ✎ **批量编辑**（改名/换封面写入该分组全部曲目）
3. 专辑与歌手可点击进入该分组**全部曲目**，分组内点击曲目**直接播放**（队列即该专辑/歌手，自动连播不跳出）；卡片「▶ 播放」与列表「▶ 播放全部」一键直播分组；**喜欢**收藏（列表 ♡ + 居中播放器 ♥ 双入口），歌单可整单播放
4. Apple 风格居中播放器：海报 / **歌词**双页切换，歌词逐行高亮、随播放自动滚动、点击跳转
5. 音乐刮削失败自动以文件名展示，不影响浏览与播放

### 🎞️ 剧集：带图示卡片列表

- 剧集按 Plex/Emby 风格聚合（根目录剧名 / Season 01 / S01E01），主列表以带封面海报的卡片展示
- 剧集详情内每一集也以**图示卡片**呈现：封面/剧集主视觉 + 集号角标 + 集名，点击卡片直接播放

### 📚 漫画和电子书

1. 漫画 ZIP/CBZ 中央目录缓存提速，GBK/日文文件名正常解码；阅读进度**服务端持久化**，换设备接着读
2. TXT 编码自动识别：BOM → 无 BOM UTF-16 → UTF-8 严格 → 多候选打分（GBK/GB18030、Big5、Shift-JIS、EUC-KR）；超长文本按 Range 分块读取合并，不会乱码/截断
3. 封面多源刮削：AniList / Bangumi 竞速优先，Google Books / OpenLibrary 兜底，单源失败不影响其它

### 🖥️ 系统与集成

1. 首页服务器监控（CPU / 内存 / 网络 / 磁盘）、播放与刮削会话、最近入库
2. **内置 Caddy**：读取、编辑并热加载容器内 Caddyfile，一个入口按 Host 分流到内网各服务
3. PT 管理（MoviePilot · Savept 监护室，需额外安装 MP 实现）、媒体搜索、三语界面（简中/繁中/EN）、暗/亮/自定义主题
4. **移动端适配**：≤768px 窄屏侧栏自动变为顶栏下方横向导航条，导航项可横向滑动查看更多

---

## 部署方式

### Compose

```yaml
services:
  vaulthub:
    image: ghcr.io/q807738511/vaulthub:latest
    # 当网络环境异常可以改用 docker.io/q807738511/vaulthub:latest 进行拉取镜像
    container_name: VaultHub
    pull_policy: always
    # 如需显卡加入解码，参考下方「硬件解码配置」加入解码配置需求
    ports:
      - "8088:8088"
    environment:
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=admin123
      - TMDB_API_KEY=
      - MEDIA_SCRAPER_MODE=auto
      # 系统监控的卷名列表（逗号分隔），与下方 /host/<卷名> 只读挂载一一对应；
      # 只需监控一个卷时填单个卷名即可（示例：vh-data）。
      - SYSTEM_MONITOR_FILESYSTEMS=vh-data
    volumes:
      - ./data:/data
      - /media:/media  # 媒体库
      - /data2:/data/transcode-cache  # 媒体缓存目录
      # Docker 状态监控（容器页面/刮削辅助需要）
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # 系统监控：/proc 与 /sys 为必需只读挂载。
      # 卷监控：把要监控的卷根目录挂到 /host/<卷名>:ro 并同步修改上面的
      # SYSTEM_MONITOR_FILESYSTEMS，例如：
      #   - /mnt/vh-data:/host/vh-data:ro
      #   - /mnt/vh-media:/host/vh-media:ro
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /srv:/host/vh-data:ro
    tmpfs:
      - /tmp:size=32m,mode=1777
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
```

### Docker Pull

```bash
docker pull q807738511/vaulthub:latest
```

---

## 硬件解码配置

针对不同的显示设备，这里准备了几种 Docker 用的解码方式。

### 1. NVIDIA 显卡（安装 NVIDIA Container Toolkit 后可用）

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    environment:
      - FFMPEG_HWACCEL=cuda
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
```

### 2. Intel 核显 / AMD 卡（QSV / VAAPI）

```yaml
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - video
      - render        # 组不存在则删掉该行
    environment:
      - FFMPEG_HWACCEL=auto        # auto: QSV → VAAPI; AMD 可显式 vaapi
```

---

## 相关链接

- **更新日志（历史版本）**：[Update Log.md](Update Log.md)
- **本版本发布说明**：`.github/RELEASE_NOTES_0.9.56.md`
- **Docker Hub**：`q807738511/vaulthub`
- **GHCR**：`ghcr.io/q807738511/vaulthub`
