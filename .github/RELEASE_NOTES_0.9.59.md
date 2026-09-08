# VaultHub v0.9.59 发布说明

## 一句话

修复长时间播放音乐或视频时因 30 分钟无交互而自动登出的问题：媒体持续播放期间同时刷新前端 idle 计时器与服务端滑动会话，避免后续媒体库请求突然返回 401。

## 1. 媒体播放期间会话保活

- 音频实际进入播放状态后启用会话保活，每 5 分钟请求一次受保护的 `/api/system/runtime`，同步延长服务端 30 分钟滑动会话。
- 视频实际进入 `playing` 状态后采用相同机制，持续看片不再被当作「无人操作」。
- 每次保活同时调用 `markVaultHubActivity()`，避免前端 30 分钟 idle 定时器主动调用 `/api/logout` 杀掉当前会话。

## 2. 生命周期与资源释放

- 音频停止、播放错误时停止音频保活；连续切歌采用具名 `Set` 幂等管理，不会重复累计计时器。
- 视频播放结束、播放错误、关闭播放器或切换片源时释放视频保活与转码播放会话。
- 音频与视频使用独立 source，可分别启停；短时网络故障不会中断当前播放，下一周期自动重试。
- 401/403 仍统一交给现有 `handleProtectedResponse` 处理，不绕过登录鉴权。

## 验证

- JavaScript 语法检查与 Python 契约测试。
- Go 三模块 `go vet` / `go test` 回归。
- 真实 Docker 镜像构建与测试容器 API 验证。
- Chromium 浏览器验证音频/视频播放状态下保活请求、前端 idle 计时器刷新及停止后的资源释放。

## 升级说明

```bash
docker compose pull && docker compose up -d --force-recreate
```

- 生产 compose 跟随 `ghcr.io/q807738511/vaulthub:latest`，无需修改文件。
- 本次无配置迁移、无数据结构变更。
- 回滚：把 `image:` 改为 `ghcr.io/q807738511/vaulthub:v0.9.58` 后重建。
