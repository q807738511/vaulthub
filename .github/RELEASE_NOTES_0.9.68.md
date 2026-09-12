# VaultHub 蜀鼠之家 v0.9.68：独立安全审查加固补丁

v0.9.67 在发布前经过**两轮独立安全审查**。第一轮结论 `passed=false`（2 个阻塞项 + 13 条非阻塞建议），
其中 2 个阻塞项与 3 条非阻塞项已随 v0.9.67 修掉（转码并发闸门与像素上限、歌词整文件读入、
缓存自淘汰致 404、singleflight 双 leader、`If-None-Match` 子串误判）。

本补丁把**剩余 9 条非阻塞项**逐条修掉，并为每一条补了回归测试。

## 修复清单（全部来自审查建议）

1. **受鉴权保护的转码结果不再标 `public`**：改 `private, max-age=31536000, immutable`。
   原写法允许中间缓存/前置反代把内容重放给未登录者（且未带 `Vary: Cookie`）；改 `private` 后
   浏览器端缓存收益完全不变。
2. **缓存键纳入「归档自身」的 size/mtime**：原键用的是 ZIP **条目**的 size/mtime，
   用 `zip -X` / 保留时间戳重打包后条目元数据不变 → 会下发陈旧页面。
3. **封面端点强制缩略**：`w=0` 一律 400；不可转码时返回 404（前端回落渐变占位）。
   原行为会静默返回整张原图，书架每张卡片可能下载数 MB。
4. **转码 leader 用 `defer` + `recover` 结束 job**：保证任何退出路径（含解码器 panic）都会
   `endPageJob`。原实现若 panic，`pageJobs[key]` 永久残留，之后同键请求全部阻塞在永不关闭的
   `done` 上。
5. **歌词仅对「音频库 + 音频扩展名」生效**：识别与落盘都加了白名单。
   原实现（结合 `safeFile` 只做包含性校验）可对库里任意文件解析标签。
6. **sidecar 写入加固**：`os.CreateTemp` 生成不可预测临时名 + `fsync` + 显式 `chmod`；
   目标已存在且是符号链接时直接跳过（避免被诱导写入链接指向位置）。
7. **批量歌词上限 200 → 50**（与前端一次批量规模一致），并加 **150s 总时长预算**，
   超时返回已完成部分。原上限下单次 POST 最长可占用连接约 9 分钟，且会把交互式单曲歌词请求
   全部排在全局节流之后。
8. **缓存淘汰改为「锁内摘表、锁外 unlink」**：原在持有 `pageCache.mu` 期间做 `os.Remove`，
   批量淘汰会阻塞所有并发 `get/put`。
9. **清空整库元数据缓存需显式 `?all=1`**：原实现不带 `path` 即清空整库（`writeAuth` 已把关，
   但过于隐晦），现在要求显式声明以防误删。
10. **前端 `setPlaybackBg` 的封面 URL 改经 `cssUrlValue` 清洗**（与 v0.9.66 的详情背景一致）：
    数据来源含服务端元数据缓存（可由已登录用户写入），未清洗时等于把 CSS 值注入面留给它
    （不能执行脚本，但可外联取图 / UI 欺骗）。

## 明确未改动（附理由）

- **音频缓存与索引表的 mtime 保持秒级**：读取时用 `JOIN files ON size+mtime` 判定新鲜度，
  索引表本身就是秒级；改纳秒会让 JOIN 恒不匹配、导致每次打开都重刮。同秒同大小的替换属极端边界。
- **鉴权模型未动**：新端点继续沿用既有会话校验（`readAuth`/`writeAuth`）、媒体库白名单与
  `safeFile` 路径校验；审查确认与既有 `archive` 端点**逐项等价、无新增越权面**。
- 审查已确认无需修改的部分：SQL 全参数化（无注入）、新 innerHTML 拼装均已 `esc()`（未发现 XSS）、
  zip 归档缓存引用计数正确释放、`MEDIA_PAGE_CACHE_MAX_BYTES=0` 确实整体禁用转码。

## 验证

- 新增 Go 回归测试 `media-go/v0968_audit_followup_test.go`：音频扩展名白名单、sidecar 三种情形
  （非音频拒绝 / 符号链接拒绝 / 正常写入且无临时残留）、淘汰后配额与最近条目仍可读。
- 新增契约测试 `tests/test_v0968_audit_hardening.py`；全量 Python 契约测试通过。
- `go vet` / `go test` / `-race` 与前端 `node --check` 全部通过。
- 临时容器端到端复跑，新增断言：`/cover?w=0` → 400、转码结果 `Cache-Control: private`、
  非音频路径请求歌词 → 400、清空缓存不带 `all=1` → 400。

## 升级

```bash
docker compose pull
docker compose up -d --force-recreate
```

镜像：`q807738511/vaulthub:v0.9.68` / `q807738511/vaulthub:latest`
回滚：`q807738511/vaulthub:v0.9.67`
