# VaultHub v0.9.13

## 新增

- 音乐媒体库自动刮削改由 VaultHub Go 后端代理 MusicBrainz，按歌曲名/歌手进行结构化查询、可信度校验，并通过 Cover Art Archive 补充专辑封面；网络不可用或无可靠匹配时继续使用文件名展示。
- 影视本地图片角色完整支持：`poster`、`logo`、`fanart`、`backdrop`，同时兼容 `Film-poster.jpg` 等同名 stem 图片和单媒体目录通用图片。
- 影视详情页新增 Logo 展示、Fanart/Backdrop 背景层与媒体信息编辑器。
- 编辑器支持从当前媒体目录选择图片，或输入 HTTP/HTTPS 图片 URL，并可编辑标签。
- 播放、分享、收藏、评分、已观看/未观看、编辑统一位于详情页操作行。
- 已观看状态和图片/标签覆盖信息服务端持久化至 `/data/media-metadata-overrides.json`。

## 安全与兼容

- 所有新增媒体元数据接口都要求有效 Manager Session。
- 媒体目录图片继续经过媒体库 ID、相对路径清理、符号链接解析、媒体根包含和文件存在性检查。
- 外部图片仅允许 HTTP/HTTPS URL，拒绝凭据 URL、`javascript:`、`data:` 和 `file:`。
- 保留 v0.9.12 的电视剧全量聚合、精简缓存和 CSS URL 注入防护。

## 关于“道理鱼音乐”

已调查到道理鱼音乐是独立 NAS 音乐管理服务，但未找到官方公开、稳定且授权第三方调用的“刮削 API”文档，因此本版不猜造或逆向其私有接口。VaultHub 使用有公开文档和使用规范的 MusicBrainz / Cover Art Archive 作为合法默认数据源；后续如道理鱼提供正式 API 文档与授权，可再增加可配置适配器。
