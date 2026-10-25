# VaultHub v1.0.7 · 契约冻结 · 端点收紧 · 继续观看

把移动 APP 依赖的 HTTP 面固化成可回归的契约，同时把三处「匿名可读」的口子收掉，
并补上「继续观看」缺失的服务端落点。本版以**服务端与主服务**为主，网页端只做配套。

---

## 1. 契约三件套入库（docs/api/）

`openapi.yaml` / `ROUTE_INVENTORY.md` / `CONTRACT_TESTS.md` 进入仓库与镜像
（`/docs/api/*`），作为 APP 与服务端之间的冻结基线：

- **openapi.yaml**：71 条路径、29 个 schema。P0（APP MVP 依赖）给出字段级定义 ——
  登录/会话、媒体库与文件分页、播放决策与会话、阅读进度、漫画/PDF/EPUB、封面、字幕、
  音频流；P1/P2 只给方法、参数与关键响应。
- **ROUTE_INVENTORY.md**：Caddy 9099/9100/9120 分流图、会话模型（48 hex、30/60 天滑动、
  256 条落盘、5 次失败锁 5 分钟）、逐端点鉴权要求、别名与 canonical 表。
- **CONTRACT_TESTS.md**：L1 静态断言清单 + L2 运行时矩阵（AUTH/PLAY/READ/SUB/LIB）
  + SEC 回归清单。

**入库前勘误**（原稿与 v1.0.6 实况不符）：

| 原稿 | 实况 |
|---|---|
| subtitle-api 自身完全不校验会话 | v1.0.6 起有 `sessionOK()` 探针，未登录 401（已实测） |
| L1 样例 `"2*time.Minute"` | 源码写作 `-2 * time.Minute`，照抄会 MISS |
| cover 公开「冻结前建议决策」 | 维持公开属有意决策（服务分享场景），已在契约里写明 |

---

## 2. 五个匿名端点收紧

实测（生产 :8088 未登录）原本这五个端点全部 200：

| 端点 | 原行为 | 现在 |
|---|---|---|
| `GET /api/media/libraries` | 匿名返回全部库配置，**含磁盘绝对路径** | 401 `login required` |
| `GET /api/media/index/status` | 匿名返回库名、扫描状态、文件规模 | 401 |
| `GET /api/media/probe` | 匿名对任意库内文件跑 ffprobe（元数据枚举 + CPU） | 401 |
| `GET /api/media/hardware` | 匿名返回转码硬件能力快照 | 401 |
| `GET /api/media/scrapers` | 匿名返回运行配置快照 | 401 |

`GET /api/media/cover` 保持公开（缩略需猜中库 ID + sidecar 路径，且分享场景依赖直链），
在契约里作为**显式决策**记录，不再算「遗漏」。

**前端配套**（不改会白屏）：

- 启动时未登录不再调用硬件探测与库列表；
- 登录成功后 `bootAfterLogin()` 补拉硬件徽章、媒体库、首页四栏；
- 首页 5 秒轮询在未登录时直接返回。

---

## 3. 播放进度持久化（继续观看）

新增 `GET/PUT/DELETE /api/media/playback/progress`：

```
GET    ?id=<lib>             → {"id": lib, "items": {"<相对路径>": {...}}}
PUT    ?id=<lib>&path=<rel>  → {"position_ms","duration_ms","completed","updated_at"}
DELETE ?id=<lib>&path=<rel>  → {"ok","id","path","removed"}   // 幂等
```

语义与安全：

- 复用 `reading_progress` 的存储模式：单 JSON（`/data/media-playback-progress.json`）、
  `configMu` 串行化、`tmp + rename` 原子落盘；
- `safeFile` 包含性校验（库根 + EvalSymlinks），`id+path` 不能组合越权写别的键；
- 服务端钳制 `position ≤ duration`；时长已知且 ≥95% 自动置 `completed`（前端可据此过滤）；
- 负数、坏 JSON → 400；未知库、越界路径 → 404；未登录 → 401。

网页播放器接入：`timeupdate` 节流 15 秒写一次，暂停/结束/关闭播放器强制写；
本机 localStorage 没有记录时（换设备/清缓存）从服务端取断点，`completed` 与「离结尾
不足 15 秒」都不续播。播放会话（内存，2 分钟 GC）继续只管转码任务生命周期，两者互不替代。

---

## 4. 契约测试 L1

`tests/test_v1007_contract.py`（静态，无需起服务）把本次冻结面写成断言：

- 文档入库 + 三处勘误不得回退；
- 五个端点的鉴权门在产出数据之前；
- 进度端点的路由、存储键、钳制、完成态、幂等删除、鉴权位置；
- 前端三处门槛 + 播放器写/读；
- 错误文案契约字符串（`login required` / `invalid media path` / `library not found` /
  `file not found`）与别名 canonical 标注；
- `media-go` 只认 `/api/session/check` 的 200 这一跨服务隐式契约；
- 源码与文档不得出现内网地址 / 容器卷路径。

Go 侧新增 `v1007_playback_progress_test.go`：往返、钳制与完成态、删除与路径越界、
未登录 401、跨实例（模拟容器重启）读回。

---

## 升级

```bash
docker compose -p vaulthub pull
docker compose -p vaulthub up -d
```

镜像：`q807738511/vaulthub:v1.0.7`（`:latest` 同推）。回滚锚点：`prod-1.0.6`。

**升级后请在浏览器强制刷新一次**（资源带 `?v=1.0.7`）。若之前依赖匿名接口做外部脚本
（如自建面板直接拉 `/api/media/libraries`），现在需要携带 `vh_session` Cookie。

---

## 已知边界

- APP 侧「继续观看」UI 尚未实现，本版只交付数据面与网页端的最小闭环；
- 契约 L2 运行时矩阵（AUTH/PLAY/READ 全量）随 APP 迭代补，L1 已覆盖命名与鉴权不漂移；
- Caddy 2.8.4 与 Go 1.23 的版本升级仍未并入，需单独一版替换二进制。
