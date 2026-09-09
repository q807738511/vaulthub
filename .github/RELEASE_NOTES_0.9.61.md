# VaultHub 蜀鼠之家 v0.9.61：全屏海报遮罩层级修复 · 移除旧最大化按钮

## 一句话

修复音乐播放器「封面海报全屏放大」被顶栏/侧边栏遮挡的问题，并移除控制栏旧版最大化按钮，海报放大统一走封面悬停按钮入口。

## 1. 全屏海报遮罩层级修复

- `.audio-fullscreen-overlay` 的 `z-index` 由 `280` 提升至 `650`，高于顶栏与侧边栏（均为 `600`）。
- 此前遮罩层级低于顶栏/侧边栏：放大后的海报会被侧边栏遮挡（旧播放器居中放大 `z-index:250` 同样低于侧边栏 600，且 `left:50%` 基于全视口居中会侵入侧边栏区域），右上角返回按钮落在顶栏范围内无法点击。
- 现在放大后海报完整覆盖音乐界面，返回按钮可正常点击收起。

## 2. 移除控制栏旧「最大化」按钮

- 删除播放器控制条中的 `audioMaximizeButton`（旧 `toggleAudioMaximize` 居中放大播放器）。
- 删除 `audioMaximized` 状态与 `.audio-player.maximized` 相关 CSS（含移动端规则）。
- 海报放大统一通过左侧封面悬停显示的放大按钮（`audio-cover-zoom-btn` → `toggleAudioCoverZoom`）进入，符合「默认隐藏、悬停显示、点击放大、右上角返回」交互。
- 歌词双页（海报/歌词）DOM 与逻辑保留：`audio-expand` 默认隐藏，歌词仍可通过「歌曲详情」弹窗查看，不影响既有功能。

## 验证

- JavaScript 语法检查：全部通过
- Python 契约测试：v0.9.54/0.9.56/0.9.60 相关测试已同步更新旧 maximized 断言并通过
- Go 模块回归：通过
- 真实容器验证：待浏览器复现确认遮罩盖过顶栏、返回按钮可点

## 升级说明

```bash
docker compose pull && docker compose up -d --force-recreate
```

- 生产 compose 跟随 `ghcr.io/q807738511/vaulthub:latest`，无需修改文件。
- 本次无配置迁移、无数据结构变更。
- 回滚：把 `image:` 改为 `ghcr.io/q807738511/vaulthub:v0.9.60` 后重建。
