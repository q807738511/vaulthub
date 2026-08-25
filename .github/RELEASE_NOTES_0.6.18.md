# VaultHub v0.6.18

- 新增 Docker GPU 透传示例：支持 `/dev/dri` VAAPI/QSV，并预留 NVIDIA Container Toolkit 的 `gpus` 与运行时变量。
- 新增系统设置中的“显卡加速”选项：自动、CPU、VAAPI、QSV、CUDA/NVENC；后端检测设备和编码器，不可用时自动回退 CPU。
- `/api/media/compat` 增加 `hw` 参数及 `X-VaultHub-Hardware` 响应头，兼容流在可用时使用硬件解码/编码。
- 修复大 TXT/长文只显示首屏：前端按 `Range` 分块读取并完整合并，保留 UTF-8/GB18030 自动解码。
- 修复电子书阅读器主题不同步：阅读器正文、目录、背景继承系统暗色/亮色/自定义主题，切换主题时已打开阅读器即时同步。

## Docker 配置

### Intel / AMD（VAAPI）

```yaml
environment:
  FFMPEG_HWACCEL: "auto"
  VAAPI_DEVICE: "/dev/dri/renderD128"
devices:
  - /dev/dri:/dev/dri
```

### NVIDIA

宿主机先安装 NVIDIA Container Toolkit，然后在 Compose 中启用：

```yaml
gpus: all
environment:
  FFMPEG_HWACCEL: "cuda"
  NVIDIA_VISIBLE_DEVICES: "all"
  NVIDIA_DRIVER_CAPABILITIES: "compute,video,utility"
```

未检测到显卡、设备权限不足或 ffmpeg 缺少对应编码器时，VaultHub 自动回退 CPU，不中断播放。

## 校验

- 全部 `tests/test_*.py` 回归脚本通过。
- 新增真实后端黑盒测试：无 GPU 时自动回退 CPU；超过 3 MiB 的 TXT 经多段 Range 组合后长度和末尾标记完整。
- `media-api.c` 与 `vaulthub-manager.c` 通过 `-Wall -Wextra -Werror` 编译。
- JavaScript 语法、Shell 脚本、Caddyfile 校验通过。
