# VaultHub v0.8.9 · Smart Stream 播放计划

## 安全补丁

- 播放计划、播放会话和 Smart Stream 全部要求有效 Manager Session。
- 会话 ID 绑定实时 FFmpeg task，关闭播放器可取消实时转码。
- 会话上限 64；创建会话时清理 2 分钟无心跳记录。
- 完整转码模式不再复制 H.264 源流，保证按计划重新编码。

## 核心更新

- 保留三层播放产品结构：Direct Play、Smart Stream、WASM Fallback。
- 新增 `POST /api/media/playback/plan`：网页上报 MP4/MSE/H.264/HEVC/VP9/AAC/Opus 能力，服务端结合 FFprobe 元数据选择播放链路。
- Smart Stream 细分为 Remux、仅音频转码、完整视频转码；完整转码继续使用 NVENC/QSV/VAAPI/CPU 自动回退。
- 播放器直接显示决策方式、硬件和原因，不再只在播放失败后猜测降级。
- 新增轻量播放会话生命周期接口：创建、10 秒进度心跳、暂停/结束上报、关闭播放器停止会话并取消同 ID 转码任务。
- 保留原始文件安全 Range、媒体库 ID + 相对路径 + EvalSymlinks 根目录校验、字幕/音轨和本地续播。

## 接口

- `POST /api/media/playback/plan`
- `POST /api/media/playback/sessions`
- `POST /api/media/playback/sessions/{id}/progress`
- `POST /api/media/playback/sessions/{id}/stop`

## 部署

```yaml
image: ghcr.nju.edu.cn/q807738511/vaulthub:v0.8.9
```

升级：

```bash
docker compose pull
docker compose up -d --force-recreate
curl http://127.0.0.1:8088/healthz
```
