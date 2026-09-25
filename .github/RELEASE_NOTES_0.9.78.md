# VaultHub 蜀鼠之家 v0.9.78

## 影视按 TMDB 评分推荐修复（仍无法生效的根因）
- 修复影视推荐不生效：此前详情页只在 tmdb_id 存在且非「本地 NFO」才取 TMDB 详情与推荐；豆瓣/文件名/本地 NFO 来源缺 tmdb_id 被跳过导致推荐不显示。现按标题回查 TMDB 取 id 后取评分+credits+recommendations；未命中/密钥无效/网络失败有可见中文提示。
- TMDB v4 Read Access Token（JWT）走 Bearer 鉴权修正：评分/影视推荐这次补上 id 兜底链路，覆盖豆瓣/文件名/本地 NFO 来源。

## 演职人员头像刮削插件 + 依赖生态补完（Metashark 适配器 / Plex NFO Agent，内置，不额外装容器）
- 内置 Metashark 适配器：豆瓣/TMDB 适配、中文文件名解析、演员头像下载器，经本地 /api/media/cast/avatar 代理抓 TMDB 人物头像并落 /data；不直连 image.tmdb.org（弱网/代理更稳）。
- 内置 Plex NFO Agent：XBMCnfo 导入 + NFO 导出器生成带 thumb 头像字段，镜像内置依赖，不需额外容器。
- 刮削配置新增「演职人员图像刮削插件」选择；插件内置，不额外安装容器。

## 分离刮削与硬件（配置归类重构）
- 拆「刮削与硬件」为两个独立标签页：硬件配置（显卡加速 / 转码缓存 / NAS 监控）+ 刮削配置（刮削来源 / API 网络链接测速 / 网络能效 / 演职人员图像刮削插件）。
- 显卡加速、转码缓存、NAS 监控 -> 硬件配置单独立项；刮削来源、API 网络链接测速、演职人员图像刮削插件 -> 刮削配置。

> 约定：README 固定为项目介绍不改动；升级日志由发布说明承载；Docker Hub 与 GitHub 说明分离维护（CI 只推 GHCR 镜像与 GitHub Release）。
