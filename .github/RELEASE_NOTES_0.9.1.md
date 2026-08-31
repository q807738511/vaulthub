# VaultHub v0.9.1

## 本地元数据
- 优先读取同名 NFO、movie.nfo、episode.nfo、tvshow.nfo。
- 应用本地标题、年份、简介、类型、时长、评分、演员和 TMDB/TVDB ID。
- 自动识别同名 poster/cover/folder PNG/JPG 与 fanart/backdrop。
- 自动发现同名 SRT/VTT/ASS/SSA/SUB 外挂字幕并应用到播放器，非 VTT 由服务端转换。

## 页面层级
- 系统设置提升至业务顶层，不再被顶栏或侧边栏遮挡。
- 登录遮罩保持最高安全层。

## 部署
```yaml
image: ghcr.io/q807738511/vaulthub:v0.9.1
```
