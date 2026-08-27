# VaultHub 架构升级 · 阶段 5 决策记录：按需服务拆分

状态：**暂不拆分（保持单容器多进程）**
日期：v0.6.29
适用范围：`vaulthub-manager` / `media-api` / `subtitle-api` / `caddy` 四进程单镜像

## 现状

当前生产镜像 `ghcr.io/q807738511/vaulthub` 在单个容器内由
`vaulthub-manager`（PID 1）拉起四个进程：

| 进程 | 端口 | 职责 |
|------|------|------|
| vaulthub-manager | 127.0.0.1:9099 | 登录/会话/Caddy 配置/Docker 扫描 |
| media-api（Go） | 127.0.0.1:9100 | 媒体库、SQLite 索引、Range 文件流、FFprobe/FFmpeg、ZIP、TMDB |
| subtitle-api（Go） | 127.0.0.1:9120 | 字幕检索 |
| caddy | :8088 | 唯一入口、反向代理、静态资源 |

阶段 3 之后，索引已落 SQLite（`/data/media-index/index.db`，WAL 模式），
重扫由后台任务执行，轻接口不受阻塞。阶段 4 之后，前端已从单文件
`index.html` 拆为 `web/css/main.css` + `web/js/0{1..4}-*.js` 四个有序原生脚本。

## 结论：现在不拆

按用户既定原则——“只有在转码需要独立 GPU 调度、刮削需要独立重启、
索引需要独立运行或多个产品共用 API 时，才考虑拆分”——逐条核对触发条件，
**目前一条都不满足**：

- **转码 GPU 调度**：宿主无 GPU（`/dev/nvidia*`、`/dev/dri` 均不存在），
  FFmpeg 走 CPU libx264，无需独立调度器。
- **刮削独立重启**：TMDB 刮削是无状态 HTTP 转发，崩溃概率与重启代价都低，
  与媒体流同进程不构成风险。
- **索引独立运行**：阶段 3 已把索引做成 media-api 内的后台任务 + SQLite，
  轻接口延迟实测亚毫秒级，未出现索引拖垮 API 的情况。
- **多产品共用 API**：目前只有 VaultHub 一个前端消费这些接口。

拆分会引入跨容器网络、服务发现、多份镜像发布与编排复杂度，在上述收益
未出现前属于**过度工程**。渐进式单体（Go 单进程 + SQLite + 后台任务）
仍是当前规模的最优解。

## 触发条件（满足任一即启动对应拆分）

| 触发信号 | 拆出的服务 | 理由 |
|----------|-----------|------|
| 宿主接入 NVIDIA/Intel GPU，且转码需要限制并发/显存、与播放请求隔离 | `vaulthub-media`（转码）独立，或引入 `vaulthub-worker` 做转码队列 | GPU 是稀缺资源，需要独立调度与背压 |
| 刮削源（TMDB/豆瓣）不稳定导致刮削逻辑频繁崩溃或需热更新规则 | `vaulthub-worker`（刮削）独立 | 让刮削崩溃不影响媒体流；可单独重启 |
| 单库文件量级达千万级，索引重扫需长时间独占 CPU/IO | `vaulthub-indexer` 独立 | 索引进程可单独限流、单独重启、单独扩容 |
| 出现第二个前端/第三方集成复用媒体 API | `vaulthub-web`（仅静态资源+BFF）与 `vaulthub-media`（纯 API）分离 | API 成为公共契约，需独立版本与鉴权边界 |

## 拆分时的落地约定（预案，未执行）

- 服务名：`vaulthub-web`、`vaulthub-media`、`vaulthub-worker`、`vaulthub-indexer`。
- 仍由一个 `caddy`/反向代理作为唯一入口，对外只暴露 `:8088`，
  子服务只监听内网，不直接对外。
- 会话鉴权权威仍在 `vaulthub-manager`：其它服务通过内部
  `/api/session/check`（loopback/内网）校验，不各自实现会话存储。
- SQLite 若被多个容器共享需改为 WAL + 单写者，或迁移到独立 DB 服务；
  在此之前 `vaulthub-indexer` 与 `media` 必须同机共享卷、单写者。
- FFmpeg 始终作为外部命令调用，不嵌入 Go。

## 复核方式

每次发布前对照上表触发条件；任一为真则在本文件追加决策并开对应拆分任务，
否则维持单容器多进程。
