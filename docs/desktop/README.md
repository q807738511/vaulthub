# VaultHub 桌面客户端开发文档

本目录面向**桌面客户端开发者**（Tauri / Electron / 原生壳），目标是把服务端已冻结的
HTTP 接口面讲清楚，让客户端在不需要读 Go 源码的前提下完成：登录、浏览媒体库、
播放视频/音频、阅读电子书/漫画/PDF、上报进度。

- 服务端版本基线：**v1.0.7**
- 契约基线：[`docs/api/openapi.yaml`](../api/openapi.yaml)（71 路径 / 29 schema）
- 路由与鉴权清单：[`docs/api/ROUTE_INVENTORY.md`](../api/ROUTE_INVENTORY.md)
- 契约测试清单：[`docs/api/CONTRACT_TESTS.md`](../api/CONTRACT_TESTS.md)

> 这三份契约文档由服务端团队维护。客户端只依赖 **P0** 面（见 openapi 的 tag 分层），
> P1/P2 端点可能在版本间变动。

## 30 分钟上手路径

| 步骤 | 文档 | 产出 |
|---|---|---|
| 1 | [01-getting-started.md](01-getting-started.md) | 本机能连上服务实例，冒烟脚本跑通 |
| 2 | [02-architecture-and-auth.md](02-architecture-and-auth.md) | 拿到会话 Cookie，理解为什么必须走原生 HTTP 层 |
| 3 | [03-api-reference.md](03-api-reference.md) | 库列表 / 文件分页 / 封面 三个接口打通 |
| 4 | [04-playback.md](04-playback.md) | 视频起播（直连 + 转码两条路） |
| 5 | [05-reading-and-library.md](05-reading-and-library.md) | 电子书 / 漫画 / PDF 阅读与进度 |
| 6 | [06-packaging-and-testing.md](06-packaging-and-testing.md) | 打包、自测矩阵、常见坑 |
| 7 | [07-git-ci-and-release.md](07-git-ci-and-release.md) | 分支、提交、CI、发布约定 |

## 一页端点索引（P0）

```
公开
  GET  /api/health                      健康
  GET  /api/auth/mode                   认证模式 + 用户名
  POST /api/login                       登录（下发 vh_session Cookie）
  POST /api/logout                      注销

需会话（Cookie: vh_session=...）
  GET  /api/media/libraries             库列表
  GET  /api/media/files?id=&limit=&offset=   文件分页
  GET  /api/media/file?id=&path=        原文件（Range/206/304）
  GET  /api/media/cover?id=&path=&w=    封面/海报（支持缩略）
  POST /api/media/playback/plan         播放决策
  GET  /api/media/compat?id=&path=&height=&sub_track=&audio_track=
                                        转码流（live 或 cache）
  POST /api/media/playback/sessions     建播放会话（转码任务与心跳）
  POST /api/media/playback/sessions/{id}/progress
  POST /api/media/playback/sessions/{id}/stop
  GET/PUT/DELETE /api/media/playback/progress   播放进度（继续观看）
  GET  /api/media/streams?id=&path=     音轨/字幕轨清单
  GET  /api/media/subtitles/search?id=&path=
  GET  /api/media/subtitles/extract?id=&path=&track=
  GET  /api/media/subtitles/download?url=
  GET  /api/media/audio/stream?id=&path=&bitrate=96k|128k|192k|256k|320k
  GET  /api/media/reading/progress?id=&path=
  GET  /api/media/document/epub?id=&path=
  GET  /api/media/pdf/info|page|cover?id=&path=&page=
  GET  /api/media/archive/zip|zip/page|zip/cover?id=&path=&entry=&page=
```

## 三条硬约束（先看，能省掉几天）

1. **没有 CORS**。服务端不下发 `Access-Control-Allow-Origin`，浏览器渲染进程（`file://`、
   `http://localhost:1420`）直接用 `fetch` 读不到响应。桌面端必须把 HTTP 放在**原生层**
   （Tauri：Rust `reqwest`；Electron：主进程 `net`/`undici`，渲染进程走 IPC）。
2. **会话是 Cookie**（`vh_session`，HttpOnly）。原生层需自带 Cookie 罐并持久化到
   「系统钥匙串 / 应用数据目录」，不要塞进 localStorage。
3. **播放有两条路**：`direct_play` 直连原文件（要支持 Range/206），`smart_stream` 走
   `/api/media/compat`（live 态不可拖动，cache 态可拖动）。客户端的 seek 策略见 04 篇。

## 本目录文件

```
docs/desktop/
├── README.md                       ← 本文件
├── 01-getting-started.md           环境、获取代码、起服务、冒烟
├── 02-architecture-and-auth.md     拓扑、会话、错误码、版本约定
├── 03-api-reference.md             端点详解与示例
├── 04-playback.md                  播放决策 / 转码 / 心跳 / 进度
├── 05-reading-and-library.md       电子书 / 漫画 / PDF / 音频
├── 06-packaging-and-testing.md     打包、自测矩阵、坑
├── 07-git-ci-and-release.md        分支 / 提交 / CI / 发布
└── examples/
    ├── client-config.example.json  客户端配置样例（主机、超时、质量档）
    ├── smoke.sh                    冒烟脚本（登录→库→文件→封面）
    └── minimal-client.mjs          最小客户端（Node 18+，零依赖，可直接跑）
```

示例里的主机一律写 `<vault-hub-host>`，接入方自行替换；仓库内不放真实域名与内网地址。
