# VaultHub 0.6.19

## 502 修复

- 修复 WebUI 报“无法读取本地媒体库”且容器日志批量出现以下错误的问题：

```text
dial tcp 127.0.0.1:9100: i/o timeout
/api/system/metrics
/api/media/libraries
status: 502
```

## 根因

- `media-api` v0.6.18 仍是单线程 accept + handle。
- 首次视频转码、截图或大文件响应会同步占用唯一处理线程。
- 浏览器同时轮询 `/api/system/metrics`、`/api/media/libraries` 时，请求排队超过 Caddy 反代等待时间，于是 Caddy 返回 502。

## 修复

- `media-api` 改为每个客户端连接独立线程处理。
- 转码/截图请求不再阻塞系统监控和媒体库读取。
- `listen` backlog 从 32 提升到 128。
- 转码临时文件名从 `.tmp.<pid>` 改为 `.tmp.<pid>.<thread>`，避免多线程并发转码同一个视频画质时临时文件冲突。

## 校验

- 新增 `tests/test_media_api_concurrency.py`。
- 使用 ffmpeg 生成真实 1920x1080 测试视频。
- 启动首次 720P 转码时，同时连续请求：
  - `/api/system/metrics`
  - `/api/media/libraries`
- 验证这些轻量接口均快速返回 `HTTP 200`，不再被转码阻塞。
- 全量 Python 测试、JS 语法检查、C 编译均通过。

## NAS 更新建议

- 更新后建议重建容器，确保新的 `media-api` 进程生效。
- 如果仍有旧的转码长任务卡住，先停止容器再启动，不要只刷新页面。
