# VaultHub 0.6.12

- 完整修复音乐文件名包含英文单引号时点击无响应的问题。
- inline `onclick` 参数现在先生成 JavaScript JSON 字符串，再进行 HTML 属性转义，避免双引号打断属性或单引号打断 JS。
- 已用浏览器验证 `Poppin'Party ... .ogg` 可发起 `/api/media/file` 请求并返回 `206 audio/ogg`，播放器 `readyState=4`。
