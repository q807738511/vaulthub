# VaultHub 0.6.18

## 视频播放修复

- 修复 v0.6.17 影视资源任意画质无法加载的问题。
- 根因 1：ffmpeg 输出缓存临时文件名为 `.mp4.tmp.<pid>`，没有标准视频扩展名，ffmpeg 无法自动选择 MP4 muxer；现已显式追加 `-f mp4`。
- 根因 2：720P/480P 等画质的 scale 表达式需要正确转义逗号；现输出 `scale=-2:min(height\,ih)`。

## 播放器交互

- 默认播放策略改为：任何访问环境下默认 720P 转码播放。
- 删除旧的“兼容转码播放”按钮。
- 删除旧的“外部打开原片”按钮。
- 画质选择移动到播放器内部右下角，靠近浏览器原生音量、全屏和菜单区域。

## 画质策略

- 原画：尝试文件直连 `/api/media/file`。
- 1080P / 720P / 480P / 360P：使用 `/api/media/transcode` 对应分辨率缓存转码。
- 播放器初始画质为 720P。

## 校验

- 使用 ffmpeg 生成真实 1280x720 测试视频。
- 验证原画直连接口返回 `206 video/mp4`。
- 验证 720P 转码接口返回 `200 video/mp4`，ffprobe 识别为 H.264 1280x720 + AAC。
- 验证 480P 转码接口返回 `200 video/mp4`，ffprobe 识别为 H.264 854x480 + AAC。
- 验证转码缓存文件生成和 Range 请求。
- 全量 Python 测试、JS 语法检查、C 编译均通过。

## 注意

- 当前执行环境无法启动 Chrome：`chrome-not-running: no supported browser is running and none could be launched`。因此浏览器像素级验证不可用；本次使用真实 HTTP 视频流和 ffprobe 完成播放流校验。
