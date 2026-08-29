# VaultHub v0.8.3 — 缓存与媒体库体验修复

> v0.8.3 是 v0.8.1 功能修复后的清洁发布标签，移除了构建目录生成的临时二进制文件。

## 更新内容

- 新增独立转码缓存目录设置，支持自定义目录、最大字节数、最大保留时间和清理周期。
- 缓存启动时清理过期文件，并按最旧优先策略控制总容量，避免系统盘被 FFmpeg 缓存占满。
- 音乐播放器在没有活动播放项目时隐藏；停止、播放列表结束和切换页面时不会显示空播放器。
- 移除媒体内容页顶部重复的大类/来源标签信息。
- 漫画与电子书按媒体库和子类型独立展示，支持从媒体库导航和页面按钮切换。

## 镜像

```yaml
services:
  vaulthub:
    image: ghcr.io/q807738511/vaulthub:v0.8.3
    environment:
      MEDIA_CACHE_DIR: /data/transcode-cache
      MEDIA_CACHE_MAX_BYTES: "10737418240"
      MEDIA_CACHE_MAX_AGE_HOURS: "168"
      MEDIA_CACHE_CLEANUP_INTERVAL_HOURS: "24"
```

建议将 `MEDIA_CACHE_DIR` 指向容量充足的数据卷，并固定使用版本标签。