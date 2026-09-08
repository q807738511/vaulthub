# VaultHub v0.8.0 — 三重解码与图形媒体中心

## 主要更新

### 三重视频解码架构

- 浏览器原生 `<video>` 直连优先，减少服务器负载。
- 浏览器或音轨不兼容时，自动降级到服务端 FFmpeg 兼容流。
- 兼容流仍失败时，启动自托管 `@ffmpeg/core 0.12.10` WebAssembly Worker，使用带 `simd128` target feature 的 WASM 核心执行真实软件解码和 H.264/AAC 兼容片段生成。
- 播放器显示当前解码引擎，并允许手动切换三个引擎。
- 为避免浏览器因大文件耗尽内存，WASM 回退限制输入不超过 256 MB，并输出最长 60 秒的应急兼容片段；完整大文件仍优先使用原生或服务端流。

### 内容优先的媒体页面

- 音乐/MV：图形化专辑和歌手、“我的媒体库”“最新音乐”“喜欢”栏目，歌曲列表与居中播放器均可收藏。
- 电子书/漫画：进入页面直接展示海报书架和“已读收藏”；刮削失败时使用文件名生成渐变封面。
- 电影/电视剧：默认使用海报与作品名展示扫描结果，刮削失败回退文件名海报。
- 删除三个内容页中的本地/外连来源切换、管理按钮、文字式媒体类型按钮和刮削/TMDB 配置提示；配置统一位于“系统设置 → 媒体库管理”。

### Session-only 管理鉴权

- 删除管理令牌输入框、`dwu_media_admin_token` 浏览器存储、`X-VaultHub-Token` 和 `ADMIN_TOKEN` 旁路。
- Manager 登录只接受 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。
- 媒体库新增、删除、重建、取消以及 Caddy 写操作统一依赖 HttpOnly `vh_session` Cookie。

### 索引可靠性

- 纳入 generation-scoped staging 原子替换后的双重故障保护。
- DB 清理和配置回滚同时失败时保留 tombstone，当前进程拒绝复用同 ID。
- 重启时清理崩溃残留 staging 和可信配置之外的孤儿索引。

## 验证范围

- Python 前端/后端契约脚本全量通过。
- Go manager 与 media-go 单元测试通过；索引一致性测试包含取消、删除/复用和双重故障恢复。
- JavaScript classic scripts 与 WASM Worker 通过 `node --check`。
- `ffmpeg-core.wasm` 可由 WebAssembly 编译，其 `target_features` 包含 `simd128`。
- 容器登录、Session-only 写接口、静态 WASM 资产、媒体 API、视频 Range、compat 和浏览器 DOM/播放降级链路均纳入发布前实测。

## 升级

```yaml
services:
  vaulthub:
    image: ghcr.io/q807738511/vaulthub:v0.8.0
    environment:
      ADMIN_USERNAME: ADMIN
      ADMIN_PASSWORD: 请替换为强密码
```

`ADMIN_TOKEN` 已废弃并删除。升级前保留 `/data` 持久卷；建议固定 `v0.8.0` 标签，不使用 `latest`。
