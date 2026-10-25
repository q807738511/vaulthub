# VaultHub 蜀鼠之家 v1.0.9

**大媒体库响应速度与元数据自愈版。** 3 项改造：服务端 NFO 体检与补全；音乐库首页去掉
「喜欢 / 歌单」入口卡、功能收进播放器；接大媒体空间后「页面无响应」按根因修掉。

镜像：`q807738511/vaulthub:v1.0.9`（`latest` 同推）。

---

## 1. NFO 体检与补全：本地没有就由服务端补出来

**问题**：库里大量条目的 NFO「信息缺失」甚至「完全无信息」——没有 NFO 文件、只有标题、
没有简介/评分/海报、剧集只有单集 NFO 而剧名根没有 `tvshow.nfo`。旧版只能靠前端
「翻到哪个条目才刮哪个」，没人翻过的条目永远补不上。

**做法**（`media-go/nfo_repair.go`）：

| 接口 | 作用 |
| --- | --- |
| `POST /api/media/nfo/repair` | 启动作业，body `{id, limit, dry_run, download_art}` |
| `GET /api/media/nfo/repair/status?id=` | 进度快照（total/scanned/repaired/missing/failed/artwork + 样本） |
| `POST /api/media/nfo/repair/cancel?id=` | 取消（在条目之间检查，不打断单条写入） |
| `POST /api/media/nfo/repair/one` | 单条补全，body `{id, path}` |

- **判定**：复用 `readLocalMediaMetadata` 的全部候选规则（`<文件名>.nfo` / `movie.nfo` /
  `tvshow.nfo` / 剧名根回溯），逐条收集缺失项 `nfo|title|overview|rating|poster`。
- **刮削**：TMDB 优先（配了密钥时给简介、类型、时长、评分、演职人员、海报、背景图），
  未配置或未命中时豆瓣兜底（片名、年份、评分、海报）。
- **落盘**：`<文件名>.nfo`；单文件目录再写 `movie.nfo`；剧集在剧名根补 `tvshow.nfo`
  （仅当不存在）。海报下载为 `<文件名>-poster.jpg` —— 与读取端 `local_metadata.go` 的
  候选名一致，所以下一次进库直接读本地，不再联网刮。
- **只填不改**：写盘走 `writeNFOFile(..., overwrite=false)`，已有字段保留、
  用户手写或其它刮削器的 NFO 走 `nfoMergeIntoExisting` 合并，不整份覆盖。
- **安全**：目标路径全部经 `safeFile` 边界校验；图片下载经 `coverTargetGuard`（禁内网地址）、
  20 MiB 上限、魔数嗅探扩展名、临时文件 + rename 原子写。
- **入口**：系统设置 → 媒体库列表里影视库行的 🩺 按钮：先体检（不写盘）→ 开始补全 →
  进度条与样本清单；可随时取消。

## 2. 音乐库：入口卡移除，功能收进播放器

- 歌手网格前的「喜欢 / 歌单」两张卡删除，音乐库首页只呈现歌手。
- 播放器新增三个按钮：**＋ 加入歌单**、**♥ 我的喜欢**、**♫ 我的歌单**（原有 ♥ 收藏当前曲目保留）。
- 新按钮沿用 v1.0.8 的「外暗内亮」双描边，深色/浅色主题下边界都清晰。

## 3. 大媒体空间不再「页面无响应」

**实测根因**（生产库，只读观察）：

| 操作 | 旧行为 |
| --- | --- |
| 打开音乐库（178,964 条） | 174 次 `/api/media/files`、36 MB JSON、一次渲染 **5,828** 张歌手卡、DOM 66,357 节点 |
| 冷启打开电子书库（184,693 条） | 231 次请求、**52.6 MB** JSON |
| 点一次歌手 / 编辑歌手 | 又把整库索引重拉一遍 |

首屏单次请求本身只有 ~60 ms，慢的全是「把整库索引搬到浏览器再本地排序分组」。

**做法**：三个服务端接口 + 前端改为每屏取一页。

| 接口 | 说明 |
| --- | --- |
| `GET /api/media/audio/browse` | 歌手 / 专辑 / 曲目三级聚合。按目录结构推断（`<歌手>/<专辑>/01 曲名`、`<年份 歌手 - 专辑>/曲名`），跳过 Booklet/Disc/Scans 子目录；内存缓存按索引版本失效；一页 60 位歌手 |
| `POST /api/media/shelf` | 书刊库分页 + 搜索 + 排序（名称/时间/大小）+ 页签筛选与计数。喜欢 / 已完成以**路径数组**上行参与 `IN` / `NOT IN`，不再传整库 |
| `POST /api/media/lookup` | 按路径批量取条目（歌单、喜欢列表、播放队列），一次 `IN` 查询 |

- 点歌手 → 只取该歌手的专辑；点专辑 → 只取该专辑的曲目；点「编辑歌手/专辑」同样只取该分组。
- 书刊架翻页、改密度、切页签全部只请求当前页；喜欢/取消喜欢只重绘当前视图。
- 索引未就绪时接口返回 `status: "indexing"` 语义，前端保留原「正在索引」提示。

## 升级

```bash
docker compose -p vaulthub pull && docker compose -p vaulthub up -d
```

生产 compose 跟随 `:latest`；回滚用固定 tag：

```bash
docker tag q807738511/vaulthub:v1.0.8 prod-rollback && docker compose -p vaulthub up -d --force-recreate
```

## 兼容性

- 新接口均需登录会话（读接口 `readAuth`、写接口 `writeAuth`），匿名一律 401。
- 旧前端仍可工作：`/api/media/files` 未改动，只是新前端不再拉整库。
- NFO/海报只写在媒体同目录，命名与 Kodi / Emby / Jellyfin / Plex(XBMCnfo) 通用规则一致。

## 测试与验证

- Python 契约 69 项（`tests/test_v1009_contract.py`）+ 全量历史套件。
- Go 单测 `v1009_browse_test.go`：路径解析（歌手/专辑/曲目/音轨号）、排序与 WHERE 生成、
  NFO 文档字段、海报命名。
- 真实容器：新库索引 → 分页/聚合接口读回 → NFO 补全写盘（含海报下载）→ 匿名 401。
- 浏览器：音乐库首页无入口卡、歌手 → 专辑 → 曲目三级、播放器四按钮、请求数与字节数对比。
