# VaultHub 0.6.17

## 媒体视图

- 漫画、电子书、影视本地库新增独立的“海报 / 列表”视图切换。
- 视图选择会保存到浏览器本地，漫画、电子书和影视互不影响。
- 影视海报视图继续使用豆瓣/TMDB 海报或影片片段截图兜底。

## 阅读/播放窗口

- 漫画、电子书、TXT、PDF、影视播放窗口改为避开左侧侧边栏，不再覆盖主导航。
- 移动端保持全屏阅读/播放，避免窄屏可用空间不足。

## 网络自动识别与画质

- 新增 `isLanPlaybackOrigin()` 自动识别当前访问来源。
- 内网 IP、localhost、`.local` 下，“原画”使用 `/api/media/file` 文件直连播放。
- 域名反代、Cloudflare Tunnel、FRP/Lucky/NPM 等穿透访问下，即使选择“原画”也自动走 `/api/media/transcode`，减少远程浏览器编码/Range/容器兼容问题。
- 新增画质档位：原画、1080P、720P、480P、360P；非原画固定走 ffmpeg 转码。

## 转码缓存

- `/api/media/transcode` 新增 `quality` 参数。
- 新增转码缓存目录 `TRANSCODE_CACHE_DIR`，默认 `/data/transcode-cache`。
- 缓存 key 由文件真实路径、大小、mtime 和画质生成；同一文件同一画质二次播放直接返回缓存 MP4。
- 缓存文件支持 Range 请求，浏览器拖动进度条更稳定。

## 配置

- Dockerfile、docker-compose.yml、.env.example 已加入 `TRANSCODE_CACHE_DIR=/data/transcode-cache`。
- 运行镜像继续内置 ffmpeg。

## 校验

- 新增前端回归测试覆盖海报/列表切换、侧栏安全阅读器、网络自动识别、画质档位。
- 新增后端黑盒测试覆盖转码 quality 参数校验和缓存目录创建。
- 全量 Python 测试、JS 语法检查、C 编译均通过。
