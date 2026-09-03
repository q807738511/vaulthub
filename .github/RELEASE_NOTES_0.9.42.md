# VaultHub v0.9.42

部署模型简化：镜像跟随 GHCR `latest` 自动跟新、`vaulthub.env` 变为可选覆盖层、CI 只在正式版本 tag 时更新 `latest`。

## 部署模型：latest 跟新 + 固定版本测试

- `docker-compose.yml` 默认镜像改为 `ghcr.io/q807738511/vaulthub:latest`（`pull_policy: always`）。
- 每次正式版本发布（tag vX.Y.Z）时 CI 会把 **`vX.Y.Z` 与 `latest` 指向同一 digest**；测试/回滚永远用固定版本号标签，两者并存互不影响。
- 日常升级无需再改 compose：
  ```bash
  docker compose pull && docker compose up -d --force-recreate
  ```
- 回滚：临时把镜像行改回 `ghcr.io/q807738511/vaulthub:v0.9.41` 再 `up -d`。
- Docker Hub 仓库启用 immutable tags，其 `latest` 不会跟随（每次同步为预期警告）；固定版本号标签照常同步，生产走 GHCR 不受影响。

## vaulthub.env 变为可选（默认值内置镜像）

- `env_file` 改为 `path: ./vaulthub.env` + `required: false`（compose ≥ v2.24），文件缺失/过期不再影响启动。
- Dockerfile `ENV` 已与 `vaulthub.env` 模板 25 个键逐键对齐：新增 `TZ=Asia/Shanghai`、`SYSTEM_MONITOR_*`、`MEDIA_RUNTIME_CONFIG`、`MEDIA_READING_PROGRESS`、`MEDIA_SCAN_MAX_DEPTH=32`、缓存清理三键、`FFMPEG_HWACCEL=auto`、`VAAPI_DEVICE=/dev/dri/renderD128`、`NVIDIA_VISIBLE_DEVICES/CAPABILITIES` 等；Go 侧原有 `env(key, default)` 兜底保持不变。
- 需要覆盖默认值时才放本地 `vaulthub.env` / `.env`；README「首次配置」已更新为单文件部署说明。

## CI：latest 只在版本 tag 时更新

- `publish-image.yml` 的 latest 标签条件从「默认分支推送」改为「`refs/tags/` 推送」：普通 main 提交只产生 `sha-xxxx`，不会再推动生产跟随的 `latest`。

## 新增 scripts/merge-env.sh（不依赖 git）

- 键级合并：只追加本地缺失的键（带默认值与说明注释）、保留已有值、写前备份、幂等可重复执行。
- 支持 `-n` 预览、`-l` 指定本地文件、URL 模板（`VAULTHUB_GH_TOKEN` 私有仓库直拉）。
- 本地文件缺失时整体复制模板创建。v0.9.42 起不合并也可用（镜像内置全部默认值），本工具服务于维护本地覆盖文件的场景。

## 校验

- Python 契约测试全部通过（含新增 v0.9.42 部署契约：compose `:latest` + `env_file required:false`、CI tag-only latest、Dockerfile 默认值对齐、版本号 0.9.42）。
- 本地镜像真实构建 + 容器验证：无 env 文件启动正常（healthz 200，内置默认值注入）；有 env 文件时覆盖生效。
- GHCR `v0.9.42` 与 `latest` digest 一致读回；Docker Hub 同步 v0.9.42。
