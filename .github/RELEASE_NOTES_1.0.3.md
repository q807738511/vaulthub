# VaultHub 蜀鼠之家 v1.0.3

> 修正版，3 项：页尾精简、NFO 识别与「内置刮削 × 外置 NFO」合并写回、项目全量安全与逻辑审查。
> 本轮同时推送 Gitea、Docker Hub 与 GitHub（不再按 20 版本节流暂缓）。

## 1. 页尾精简（需求1）

- 页尾只保留**当前版本 + 版本功能提示**一行：`v1.0.3 · 页尾精简 · NFO 合并写回 · 全量安全审查`。
- 去掉品牌名占位与「版本与『系统设置 → 账户与登录 → 关于』中的版本参数保持一致」这行说明文字；
  三语语言包里对应的提示键一并移除。
- 高度压缩：`margin` 26→10px、`padding` 12→5px、字号 12→11.5px、行高 1.35 —— 页尾总高度下降约 40%。
- 版本号仍由 `syncAppFooterVersion()` 从「关于」读取，全站只维护一处，发版不会漏改。

## 2. NFO 识别修复与合并写回（需求2）

### 2.1 识别加固（读得到）

- **编码**：支持 UTF-8 BOM 与 UTF-16（Windows 记事本「Unicode」另存）的 NFO —— 旧实现用
  `xml.Decoder` 流式解码，这两类文件直接解析失败，表现为「本地明明有 NFO，界面却是空的」。
- **文件名**：NFO 与图片的查找改为**大小写不敏感**兜底 —— Linux 上 `Movie.NFO` / `TVSHOW.NFO` /
  `Poster.JPG` 与候选名不相等，旧实现判定「没有 NFO / 没有海报」。

### 2.2 冲突合并（写得对）

外置 NFO（用户手写、tinyMediaManager / Emby / Jellyfin / Kodi 写的）与内置刮削结果冲突时：

- **原有非空字段一律保留**，只把缺失/空字段用刮削结果补齐（标题、原名、剧名、年份、首播、
  简介、短简介、时长、评分、类型、演员、TMDB/TVDB ID、海报/背景图/logo）；
- 两边都有值但不同的字段记入 `conflicts`（接口返回），**不覆盖**用户内容；
- 合并结果**原子写回同一个 NFO 文件**，用户自带的 `<studio>`、`<tag>`、`<set>`、注释、
  CDATA 等本工具不认识的节点原样保留（采用文本级插入，不做整树重排）；
- 演员按姓名、类型按名称、`uniqueid` 按 type+value、`thumb` 按 aspect+value **语义去重**，
  不会产生重复节点；
- VaultHub 自己写的 NFO（带 `written by VaultHub` 标记）或显式 `overwrite` 仍按最新刮削
  **整份重写**，保证刮削更新能落地；
- 无法解析 / 根标签未知的 NFO **一个字节都不动**（宁可不写，也不破坏用户文件）。

接口 `POST /api/media/nfo` 新增返回 `merged`（补进去的字段）与 `conflicts`（保留原值未覆盖的字段）。

## 3. 全量审查（需求3）

审查 55 个 HTTP 端点、`manager`、`subtitle-api`、前端与脚本，**修复 5 项**：

| ID | 严重度 | 问题 | 处置 |
| --- | --- | --- | --- |
| S-1 | 中 | 封面下载的 SSRF 防护写在 `DialContext` 里，**配置代理后整条失效** | 新增 `ensurePublicTarget()`，请求前强制校验公网目标（配代理同样生效） |
| S-2 | 低 | 字幕抽取端点未鉴权（可反复跑 ffmpeg 取回字幕文本） | 补 `readAuth` |
| S-3 | 低 | 系统监控端点未鉴权（泄露宿主机负载/内存/磁盘） | 补 `readAuth` |
| S-4 | 低 | 登录限流取 `X-Forwarded-For` 第一跳（可伪造） | 改取最后一跳 |
| L-1 | 逻辑 | 无调用者的死代码 `commandJSON` | 删除 |

已核对无问题：路径穿越（`safeFile` / 目录边界 / NFO 名白名单 / 归档只流式读不解包）、
命令注入（ffmpeg/ffprobe/iconv 参数来源逐个确认）、SQL 注入（全参数化 + ORDER BY 白名单）、
XSS（`esc()` 覆盖高风险渲染路径）、Caddy 管理（需登录 + 固定路径 + 写前校验）、
会话安全（HttpOnly/SameSite/Secure + 常量时间比较 + crypto/rand）。

后续建议（本版未改，避免迁移风险）：密码哈希升级 `argon2id`；图片端点做会话校验缓存后再收紧；
CI 增加 `govulncheck`。完整报告见 `.github/AUDIT-1.0.3.md`。

## 4. 版本与发布

- 全站同步 **v1.0.3**（`index.html` 资源版本 ×11、`VAULTHUB_ASSET_VERSION`、
  `VAULTHUB_SCRIPT_VERSION`、安装/升级脚本、字幕服务 UA、页面标语 ×3）。
- 本次发布：**Gitea + Docker Hub + GitHub**（`v1.0.3` 与 `latest` 同推），生产容器升级到 v1.0.3。
- 测试：Go `vet`/`test` 全绿（新增 9 项 NFO/审查单测）；Python 契约与行为测试全量通过。
