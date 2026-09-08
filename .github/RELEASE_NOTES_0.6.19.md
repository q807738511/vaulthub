# VaultHub v0.6.19

## NVIDIA NVENC 修复

- 将运行时基础镜像切换为 NVIDIA CUDA Ubuntu 镜像，确保容器内 FFmpeg 使用可注入宿主机驱动的 NVENC 运行环境。
- 修复硬件能力检测：按 `ffmpeg -encoders` 的真实输出判断 `h264_nvenc`、`h264_qsv`、`h264_vaapi`，不再把编译时帮助信息误判为可用硬件。
- CUDA 模式采用 CPU 解码 + NVENC 编码，兼容更多 HEVC、10-bit 和特殊封装输入，避免强制 NVDEC 失败导致播放器持续加载。
- 保留 CPU 自动回退和系统设置中的硬件加速选择。

## 验证

- 飞牛宿主机 NVIDIA 驱动、Docker NVIDIA runtime 和 `gpus: all` 已通过实际环境验证。
- 全部 VaultHub 独立回归脚本和 C 严格编译检查通过。
- 本地 Docker daemon 不可用，最终镜像由 GitHub Actions 构建并通过 GHCR 内容核验。