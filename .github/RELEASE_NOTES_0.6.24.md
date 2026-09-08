# VaultHub v0.6.24

## 修复

- 修复旧版 `/data/Caddyfile` 自动迁移时生成单行 Caddy 块导致启动校验失败的问题。
- Caddy 启动校验失败时输出具体错误内容，便于定位配置问题。
- 默认将 Compose 重启策略调整为 `on-failure:1`，避免配置错误导致无限重启。
- 明确挂载音乐、漫画和 TXT 媒体目录到容器内固定路径，并保持只读。

## 验证

- 现有持久化 Caddyfile 按修正后的迁移格式验证通过。
- 仓库内 17 个测试脚本全部通过。
- 内嵌 JavaScript 语法检查通过。
- `git diff --check` 通过。
- GitHub Actions 负责执行最终 Docker 镜像构建并发布 GHCR 镜像。
