# VaultHub 0.6.6

## 修复内置监控访问

- 修复内置系统监控 `/api/system/metrics` 缺少 Caddy 反向代理路由，导致外网访问返回 `{"ok":false,"error":"not found"}`。
- 增加 `/api/system/*` 到内置监控 API 的同源代理，支持通过 VaultHub 外部域名访问。
- 旧版本已有持久化 `/data/Caddyfile` 时，启动自动补入 `/api/system/*` 路由。
- 修复镜像直接携带旧版预编译 `media-api` 的问题，改为 Docker 构建时从 `media-api.c` 和 `vaulthub-manager.c` 源码编译，确保发布镜像包含最新接口。

## Caddy 页面配置权限

- `ADMIN_TOKEN` 为空时，页面 Caddy 配置保存无需填写管理令牌。
- `ADMIN_TOKEN` 非空时，页面“管理令牌”必须填写与 Compose 完全一致的值。
- 权限错误会返回 `401 unauthorized`；`not found` 表示请求路由或后端接口不存在，不是权限不足。
