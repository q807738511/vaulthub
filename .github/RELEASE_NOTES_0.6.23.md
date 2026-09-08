# VaultHub 0.6.23

## 登录与权限

- 新增 WebUI 用户名/密码登录界面。
- 默认登录账户为 `ADMIN`，默认密码为 `ADMIN123`。
- 支持通过 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 环境变量覆盖默认凭据。
- 保留非空 `ADMIN_TOKEN` 的旧版令牌兼容登录。
- 页面启动时检查会话；未登录时显示登录遮罩。
- 系统设置、Caddy 配置、Docker 扫描和运行时接口统一要求登录会话。
- Caddy 配置和系统设置入口增加前端登录保护，后端继续执行强制鉴权。

## Go 架构升级

- 使用 Go 管理服务替换原有管理服务实现。
- 提供 `/api/health`、`/api/admin/docker/scan`、`/api/admin/caddy/*` 和 `/api/system/runtime`。
- 保留 `media-api.c`、Caddy、字幕服务和现有前端。
- 支持 Caddy 配置校验、原子写入、热加载和优雅停止。
- 增加阶段 0 基线采集工具 `tools/phase0_baseline.py`。

## 验证

- Docker 多阶段镜像构建成功。
- Go manager 在镜像构建阶段静态编译成功。
- 容器内验证默认登录、错误登录、未登录 401 保护、登录后运行时接口和 Caddy 配置读取均通过。
- 前端 JavaScript 语法检查和 `git diff --check` 通过。

> 默认密码仅用于首次部署验证，公开部署前请通过 Compose 环境变量修改 `ADMIN_PASSWORD`。
