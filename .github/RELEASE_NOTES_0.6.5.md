# VaultHub 0.6.5

## 内置 NAS 数据监控

- 调整 Compose 结构，增加环境变量与少量只读挂载示例。
- 无需部署 Glances 容器，VaultHub 可通过内置 `/api/system/metrics` 接口读取宿主机系统信息。
- 使用 `SYSTEM_MONITOR_ENABLED`、`SYSTEM_MONITOR_INTERVAL`、`SYSTEM_MONITOR_INTERFACE`、`SYSTEM_MONITOR_FILESYSTEMS`、`SYSTEM_MONITOR_PROC_ROOT`、`SYSTEM_MONITOR_SYS_ROOT` 配置监控行为。
- `/proc`、`/sys` 以及需要统计容量的 NAS 卷均以只读方式挂载；磁盘容量使用 `statvfs` 获取，不会递归扫描卷内文件。

## 页面监控调整

- 删除 NAS 监控页面对 Glances `/api/4/*` 接口的调用。
- 删除系统设置中的 Glances API 地址配置。
- 页面统一调用同源 `/api/system/metrics`，接口不可用时显示不可用状态，不再生成随机模拟监控数据。
