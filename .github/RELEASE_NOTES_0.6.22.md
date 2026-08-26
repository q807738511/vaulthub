# VaultHub v0.6.22

## 字幕与播放器

- 新增同容器 Go `subtitle-api`，不依赖 Python 或第二个字幕容器。
- 自动扫描视频同目录、同名前缀的 `.srt`、`.vtt`、`.ass`、`.ssa` 字幕。
- 播放器提供字幕搜索、候选选择和同源挂载入口。
- 新增 Shooter Go API 适配：视频四段 MD5 hash、中文/英文字幕查询、SRT/ASS 候选归一化。
- 新增 Zimuku/SubHD 可配置站点搜索适配；第三方站点不可用、超时或返回异常时只记录 Provider 错误，不阻塞视频播放。
- 新增字幕下载代理入口，限制 HTTPS、重定向次数和响应大小。
- 保留媒体根目录、符号链接逃逸和路径穿越校验。
- 音轨识别与音轨切换继续保留，并在切换后恢复播放位置。
- 播放器继续显示播放时间、缓冲范围和播放进度。

## 部署配置

可在 Compose 或容器环境变量中配置：

```yaml
environment:
  MEDIA_ROOT: /media
  SUBTITLE_API_ADDR: 127.0.0.1:9120
  SUBTITLE_SHOOTER_ENDPOINT: https://www.shooter.cn/api/subapi.php
  SUBTITLE_ZIMUKU_BASE: https://zimuku.org
  SUBTITLE_SUBHD_BASE: https://subhd.tv
```

Zimuku 和 SubHD 页面结构、域名及访问策略可能变化，默认留空即可使用本地字幕扫描；在线 Provider 失败不会影响原片播放。

## 验证

- Go 1.23.12：`go test ./...` 通过。
- Go 静态编译：`go build -trimpath -ldflags='-s -w'` 通过，生成约 6.2 MB Linux amd64 二进制。
- 本地临时媒体目录实测：健康检查、同目录 SRT 搜索和路径穿越拒绝均通过。
- `media-api.c` 严格语法编译通过。
- `vaulthub-manager.c` 严格语法编译通过。
- 内嵌 JavaScript `node --check` 通过。
- 全部 `tests/test_*.py` 逐个执行通过。
- Caddy 配置校验通过。
- `git diff --check` 通过。

> 当前环境 Docker daemon 未运行，完整 CUDA 镜像构建和 GHCR 发布需要 Docker daemon 及 GitHub 推送凭据可用后执行。未在此状态下伪造镜像或 Release 结果。
