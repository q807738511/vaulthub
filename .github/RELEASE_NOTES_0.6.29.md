# VaultHub v0.6.29

架构升级阶段 3–5 + 运行时基底切换。本版重点是**索引落 SQLite、前端拆分、
服务拆分决策**，并把镜像基底从 CUDA/Ubuntu 切到 Debian trixie，修复中国网络下
Docker Hub 拉取超时导致无法构建的问题。

## 阶段 3：SQLite 与后台索引

- 媒体索引从内存 + 每库 JSON 快照迁移到 SQLite（`/data/media-index/index.db`），
  纯 Go 驱动 `modernc.org/sqlite`，**无 cgo**，静态二进制不变。
- WAL 模式 + `busy_timeout`，扫描写入时读查询照常返回。
- 新接口：
  - `POST /api/media/index/rebuild[?id=]`：创建后台重扫任务，立即返回 `202`，
    不阻塞轻接口；需要登录会话。
  - `GET /api/media/index/status`：从 SQLite 读取每个库的
    `state/scanned/total/running`，不触碰文件系统。
  - `POST /api/media/index/cancel[?id=]`：取消进行中的扫描。
- `GET /api/media/files` 改为 `SELECT ... LIMIT ? OFFSET ?` 查询 SQLite，
  不再实时遍历目录；分页语义不变（`offset`/`limit`，上限 500）。
- 扫描分两阶段：先无锁遍历文件系统，再在单写者闸门下分批（2000 条/事务）
  提交，写锁频繁释放，多个库的扫描互不阻塞。
- 首次启动自动导入旧版 per-library JSON 快照，升级后立即可用，无需先重扫。

## 阶段 4：拆分前端

- 单文件 `index.html` 拆为 `web/css/main.css` + `web/js/0{1..4}-*.js`
  四个**有序原生脚本**（非 ES module，保持全局函数，131 个内联事件处理器不受影响）。
- 未引入 React/Vue/Svelte：当前状态复杂度仍在原生模块能力内。
- 加载顺序固定：state → media → features → boot，所有初始化调用集中在
  `04-boot.js`，确保依赖先定义后执行。
- 拼接四文件与原 `index.html` 脚本体逐字节等价，零逻辑漂移。

## 阶段 5：按需服务拆分（决策：暂不拆）

- 新增 `docs/architecture-phase5-service-split.md`，逐条核对拆分触发条件
  （GPU 调度、刮削独立重启、索引独立运行、多产品共用 API），**当前一条都不满足**，
  维持单容器多进程；记录了未来触发信号与拆分预案。

## 运行时基底：CUDA/Ubuntu → Debian trixie-slim

- 宿主无 GPU（`/dev/nvidia*`、`/dev/dri` 均不存在），CUDA 基底的运行库从未被使用，
  却把构建绑死在唯一不通的 Docker Hub。
- 换 `debian:trixie-slim`（与飞牛/Debian NAS 同代）：基底体积 244MB→79MB，
  ffmpeg 4.4→7.1.5，NVENC/VAAPI/QSV 编码器**仍在**（运行时 dlopen 加载，
  `ldd ffmpeg` 不硬链接任何 nvidia 库），未来接入 GPU 仍可硬件转码。
- 基底镜像与 `GOPROXY` 改为可覆盖的构建参数（`GO_IMAGE`/`RUNTIME_IMAGE`/`GOPROXY`），
  断网/中国网络可指向镜像站与 `goproxy.cn`，CI 仍走官方源。

## 验证

- 隔离二进制实测：`rebuild` 无凭据 `401`、有会话 `202`；扫描进行中
  `status` 亚毫秒返回、`running=true`；小库秒级 `ready` 且分页正确；
  大库（25000 文件）扫完 `total=25000`；`cancel` 后状态落 `cancelled`，不崩溃。
- 真实 `docker build`（Debian 基底）成功，容器 4 进程正常。
- 全部 Python 测试脚本、`manager`/`media-go` 的 `go test`/`go vet`/`go build`、
  前端 `node --check` 通过。

## 部署

发布并 Actions 绿色后：
```
image: ghcr.io/q807738511/vaulthub:v0.6.29
```
`.env` 设置 `TMDB_API_KEY=<你的密钥>`（v0.6.28 起生效）。
