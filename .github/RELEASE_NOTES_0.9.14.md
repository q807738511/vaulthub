# VaultHub v0.9.14

## 修复

- 修复电视剧聚合后丢失 `logo` 与 `fanart` 的问题；剧集详情现在完整继承 poster/logo/fanart/backdrop。
- 统一影视卡片和详情页的观看状态，移除影视“已读/未读”第二套本地状态，统一使用服务端持久化的“已观看/未观看”。
- 修复仅包含 watched/tags/logo/fanart 的 metadata override 在刷新或新浏览器中可能被忽略的问题。

## 数据可靠性与安全

- metadata override JSON 损坏时拒绝覆盖原文件，避免静默清空已有数据。
- 原子 rename 后同步父目录，提高 Docker 数据卷断电场景下的持久化可靠性。
- 媒体目录图片候选增加 25 MiB 大小上限，避免异常大文件被编辑器直接加载。

## 兼容性

- 保留 v0.9.13 的 MusicBrainz 后端自动刮削、文件名回退、图片 URL 校验、媒体目录图片选择及所有会话鉴权。
- 不改写 v0.9.13 标签；本次修复以新补丁版本 v0.9.14 发布。
