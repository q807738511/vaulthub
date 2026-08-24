# VaultHub 0.6.17

## 视频音频兼容播放

- 保留 v0.6.16 的直连原片播放作为优先路径。
- 新增 `/api/media/probe`，通过 ffprobe 读取视频/音频编码并给出 `compat_recommended` 自动判定。
- 新增 `/api/media/compat`，当浏览器不支持原容器或音频编码时，使用 ffmpeg 输出 H.264 + AAC 的 fragmented MP4 兼容流。
- 前端自动判定规则：
  - MKV、AVI、RMVB、RM、WMV、FLV、TS、M2TS、MTS、VOB、ISO 等容器默认使用兼容流。
  - MP4/M4V/WebM/OGG 等先直连，再根据 probe 的音频编码结果自动切换。
  - 直连 video error 时自动切换兼容流。
  - 保留“直连原片”和“音频兼容”手动按钮。

## 播放器空间

- 桌面端阅读/视频播放器不再覆盖左侧边栏，只占用侧栏右侧内容区域。
- 移动端仍保持全屏阅读体验。

## 校验

- 新增 AC3 音频样本黑盒测试，验证 probe 推荐兼容流并输出 AAC MP4。
- 全量 Python 测试通过。
- index.html JavaScript 语法检查通过。
- media-api 与 manager 严格 GCC 编译通过。
- Caddyfile validate 通过。
