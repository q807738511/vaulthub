# VaultHub 0.6.11

- 修复音乐文件名包含英文单引号（例如 `Poppin'Party`）时，专辑/歌手/文件视图点击播放无响应的问题。
- 音乐播放与手动元数据按钮改用 JSON 字符串字面量生成 inline handler，避免把 HTML 转义误用为 JavaScript 转义。
- 保留 v0.6.10 的媒体路径 percent-encode、漫画全屏阅读器 overlay 与音频 HTTP 加载错误提示修复。
