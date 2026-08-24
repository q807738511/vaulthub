# VaultHub 0.6.20

## 502 / 播放缓存修复

- 修复 Caddy 日志出现 `dial tcp 127.0.0.1:9100: connect: connection refused` 后，WebUI 无法读取媒体库的问题。
- 根因是 `media-api` 子进程退出后，`vaulthub-manager` 没有立即重启它；Caddy 本身仍在运行，但 9100 没有进程监听。
- `vaulthub-manager` 现在监听 `SIGCHLD`，发现 `media-api` 或 Caddy 子进程退出会自动拉起。
- 首次转码播放改为边转码边输出 `video/mp4`，不再等完整缓存文件生成后才响应播放器。
- 首次播放同时写入 `/data/transcode-cache`；转码完成后后续请求继续使用缓存文件并支持 Range。

## 关于 Caddy

- 本次 502 不是 Caddy 性能不足，而是 127.0.0.1:9100 后端不可用。
- 暂不替换内置 Caddy，避免破坏现有 WebUI 可编辑 Caddyfile、同容器 loopback API、Cloudflare Tunnel 单入口结构。

## 校验

- 新增 media API 子进程退出自动重启测试。
- 新增首次转码流式响应测试。
- 全量 Python 测试、JS 语法检查、C 严格编译通过。
