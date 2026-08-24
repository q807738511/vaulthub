# VaultHub 0.6.21

## 播放器布局

- 播放器不再固定在左上角小窗口。
- 按侧栏右侧剩余宽度与可用高度自适应，保持 16:9。
- 桌面端居中，移动端全宽，避免页面出现大块无效空白和纵向溢出。

## 非原画转码

- 720P/480P/360P/1080P 使用 fragmented MP4 流式输出。
- 浏览器收到初始化片段后即可开始播放，同时服务端继续转码并写入 `/data/transcode-cache`。
- Caddy media/system 反代关闭响应缓冲，避免代理层等待整块数据。
- 已保留完成后的缓存命中与 Range 播放。

## 校验

- 全量 Python 测试、真实视频转码/Range/缓存测试通过。
- media-api 与 manager 严格 GCC 编译通过。
- index.html JavaScript 语法检查通过。
