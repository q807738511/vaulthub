# VaultHub v1.0.3 全量审查报告（安全 / 逻辑）

- 审查对象：`media-go/`（媒体 API，~55 个 HTTP 端点）、`manager/`（会话、Caddy、子进程守护）、`subtitle-api/`、`web/`（前端 JS/CSS）、`scripts/`、`Dockerfile*`、`docker-compose.yml`
- 审查日期：2026-10-17
- 方法：源码通读 + 路由鉴权矩阵（脚本枚举 `mux.HandleFunc` 与每个 handler 的鉴权调用）+ 危险模式检索（`exec.Command` / 出站 HTTP / SQL 拼接 / `innerHTML` 插值 / 归档解包）+ 实机验证（生产容器 8088 与验证容器 8091）
- 结论：**未发现未修复的高危问题**；本轮修复 5 项（1 中危 + 2 低危 + 2 加固），另有 3 项列为后续建议（改动面大或需要迁移，未在本版动手）

## 一、本轮修复

| ID | 严重度 | 位置 | 问题 | 处置 |
| --- | --- | --- | --- | --- |
| S-1 | 中 | `media-go/cover_persist.go` + `network.go` | **SSRF 防护被代理绕过**：拒绝私网目标的校验写在 `safeTransport` 的 `DialContext` 里；一旦配置 `SCRAPER_PROXY`（生产即如此），DialContext 连的是代理、目标由代理解析，这道防线整条失效 —— `POST /api/media/cover` 可让服务端代取 `http://127.0.0.1:9099/…`、`http://169.254.169.254/…` 等内网地址 | 新增 `ensurePublicTarget()`：请求前解析目标主机，任一 IP 为回环/私网/链路本地/未指定/组播即拒绝；`localhost`、`*.local/.internal/.lan/.home` 直接拒绝；封面下载在发请求前调用（**配代理时同样生效**） |
| S-2 | 低 | `media-go/main.go` `extractSubtitle` | 字幕抽取端点**没有鉴权**：未登录即可对库内任意文件反复跑 ffmpeg 并取回字幕文本（内容泄露 + 资源耗尽） | 补 `readAuth`，与文件流/归档读取一致 |
| S-3 | 低 | `media-go/main.go` `systemMetrics` | 主机负载/内存/磁盘/网卡信息**无需登录**即可读取（公网反代暴露时泄露宿主机状况） | 补 `readAuth`（前端仅在登录后轮询，行为不变） |
| S-4 | 低 | `manager/main.go` `clientKey` | 登录限流取 `X-Forwarded-For` **第一跳**（客户端可伪造）→ 换假 IP 即重置失败计数，5 次/5 分钟限流形同虚设 | 改取**最后一跳**（反代追加的真实来源） |
| L-1 | 逻辑 | `media-go/main.go` `commandJSON` | 无调用者的死代码（残留的工具函数） | 删除 |

## 二、已核对、未发现问题的项

| 面 | 核对方式 | 结论 |
| --- | --- | --- |
| 路径穿越 | `safeFile` / `dirInsideLibrary` / `nfoNameRe` 白名单 / `indexRelFor` 边界比较；归档只按 entry 索引流式读取，**不解包落盘** | 未发现穿越或 zip-slip |
| 命令注入 | 全部 `exec.Command` 调用点逐个检查：ffmpeg/ffprobe 参数来自已校验的库内路径与数值轨道号；`iconv` 的编码名是硬编码常量；Caddy 用固定二进制 + 固定路径 | 未发现注入 |
| SQL 注入 | 所有查询参数化；唯一拼接处 `ORDER BY` 由白名单二选一（`path` / `mtime DESC, path`）；`LIKE` 走 `sqliteLikeEscape` | 未发现注入 |
| XSS | `esc()` 覆盖 `& < > " '`；抽查详情页/海报卡/演职/推荐/音乐详情等高风险渲染路径，NFO 与 TMDB 文本均经 `esc()`；`coverGradient` 只输出 `hsl()` 数值 | 抽查未发现未转义插值 |
| 鉴权矩阵 | 脚本枚举 54 条路由 → 48 条在自身或下游 handler 内鉴权；修复后仅 `coverGet`（只读图片，`safeFile` 限定库内路径）保持公开，`nfoHandler`/`pdfCover`/`scrapeCacheHandler` 由下游 handler 鉴权 | 修复后无「写/高开销/内容读取」端点裸奔 |
| 会话安全 | `HttpOnly` + `SameSite=Lax` + `Secure`（TLS 或 `X-Forwarded-Proto=https`）；密码比较 `subtle.ConstantTimeCompare`；会话随机数用 `crypto/rand`；登录限流 5 次/5 分钟 | 未发现问题（哈希强度见建议 R-1） |
| Caddy 管理 | 需要登录；写入固定路径 `/data/Caddyfile`；写入前 `caddy validate`，失败回滚 `.old` | 未发现问题 |
| NFO 写入 | 目录边界 + 文件名白名单 + 原子写 + 512 KB 上限；不可解析文件一律不动（v1.0.3 新增合并语义后仍保持） | 未发现问题 |

## 三、后续建议（本版未改，避免引入迁移风险）

| ID | 项 | 说明 |
| --- | --- | --- |
| R-1 | 密码哈希强度 | 现为 `sha256(salt + "\x00" + password)`：加盐但**快哈希**，`auth.json` 泄露时可离线高速爆破。建议后续迁移到 `argon2id`（需要同时支持旧哈希校验 + 首次登录后自动升级） |
| R-2 | 图片端点鉴权成本 | `GET /api/media/cover` 保持公开（只读图片字节、`safeFile` 限定库内、无法列举）。若改成逐请求鉴权，海报墙一次渲染会额外产生数百次到 manager 的环回会话查询 —— 建议将来做「会话校验结果短期缓存」后再收紧 |
| R-3 | 依赖漏洞扫描 | 本容器无外网包索引访问能力，`modernc.org/sqlite` 等依赖未做 CVE 库比对；建议在 CI 里加 `govulncheck`（需要 runner 能拉取漏洞库） |

## 四、回归测试

- `media-go/v1003_nfo_merge_test.go`（7 项）：外置 NFO 冲突保留/互补、完整即零写入、不可解析不动、自家 NFO 重写、BOM/UTF-16 解析、大小写不敏感查找、演员去重
- `media-go/v1003_audit_test.go`（2 项）：`ensurePublicTarget` 对回环/私网/链路本地/`.local` 等 11 类内网目标全部拒绝、公网 IP 放行
- `tests/test_v1003_contract.py` / `tests/v1003_behavior.js`：页尾精简、NFO 合并写回契约、审查修复点存在性、版本一致性
