# VaultHub 0.6.22

## 热修复

- 修复播放器选择“原画”时仍进入 `/api/media/transcode` 的 ffmpeg 转码流程，导致原画播放失败的问题。
- `quality=original` 现在直接复用原始文件 Range 播放逻辑，返回真实原文件 Content-Type、Content-Length/Content-Range。
- 增加通过 Caddy 反代访问 `/api/media/transcode` 的回归测试，覆盖原画 passthrough 和 720P 转码播放，避免 502 回归。

## 校验

- 全量 Python 测试通过。
- Caddy 反代播放测试通过。
- index.html JavaScript 语法检查通过。
- media-api 与 manager 严格 GCC 编译通过。
- Caddyfile validate 通过。
