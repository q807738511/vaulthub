# VaultHub 蜀鼠之家 v0.9.69：P3 加固补丁（v0.9.68 复审剩余项）

v0.9.69 是 v0.9.68 之后的**收尾加固补丁**：内容来自第二轮独立安全审查报告中尚未处理的
低优先级项（P2 末位 + P3），以及**第三轮针对本增量 diff 的审查**发现的发布完整性问题。
无新功能、无接口破坏性变更。

## 修正内容

1. **转码源体积上限与像素上限对齐**
   - `maxPageSourceBytes` **96MB → 32MB**。审查指出 96MB 与 16M 像素上限不匹配：
     压缩源仍会被整块读入内存，并发时叠加（旧值仅输入项就有 3×96MB）；32MB 足以覆盖
     所有「可转码」的页。
2. **元数据缓存读取改成 SQL 侧分页**
   - `GET /api/media/audio/cache` 支持 `limit`（默认 5000，上限 50000）；
   - 关键点：在 **SQL 侧** `ORDER BY m.path LIMIT ?`（多取一行判定 `truncated`），
     而不是仅在 Go 侧裁剪响应体 —— 审查指出后者不减少 DB 扫描与内存占用，且批次不确定。
     响应新增 `truncated` 与 `limit` 字段。
3. **批量歌词串行闸门改为「闭包释放」**
   - v0.9.68 已把批量上限降到 50 首并加 150s 预算；本版再加进程内非阻塞闸门，
     冲突时返回 **429**。
   - 审查指出早先的写法（独立 `endLyricsBatch()` + `select/default`）**模式脆弱**：
     一次非持有者的 `end` 就能清空持有者令牌，让两个批量同时跑。现改为
     `beginLyricsBatch() (release func(), ok bool)`，只有取得令牌的那次调用能释放它，
     与既有 `acquireTranscode` 一致。
4. **前端配合**
   - `loadAudioServerCache` 显式带上限并处理 `truncated`（提示仅载入前 N 条）；
   - 批量刮削遇到 429 时给出「已有歌词刮削任务在进行中，请稍后重试」而非裸 `HTTP 429`；
   - `writeAudioMetadata` 写入失败不再静默。文案改为**准确表述**
     （并非所有调用点都会写服务端缓存；Safari 隐私模式抛 SecurityError 而非「已满」）。
5. **测试质量与发布完整性（重要）**
   - 修掉 `tests/test_v0967_comic_reader_and_lyrics.py` 中因 `and/or` 优先级而**恒真**的断言；
   - 新增 `tests/test_v0969_p3_hardening.py`：为上述每一项建立真实守卫；
   - 新增 `media-go/v0969_batch_gate_test.go`：闸门闭包配对 / 未初始化 fail-closed。
   - **背景**：本版最初提交时，发布说明声称「已补契约守卫」，但独立审查用**突变测试**证明
     守卫并不存在（回退全部加固后契约与 Go 测试仍全绿）—— 属于发布声明不实。
     现守卫已落地，并再次用突变验证：回退这 4 项后 `test_v0969_p3_hardening.py`
     **报 6 处 FAIL 并以非 0 退出**。

## 验证

- `python3 tests/test_v0969_p3_hardening.py` 全绿；**突变验证**：回退 4 项加固后该测试
  6 项 FAIL（退出码 1）；
- 全量 Python 契约测试通过；Go `go vet` / `go test` / `-race` 通过；前端 JS 全部 `node --check`；
- 临时容器端到端 29/29（转码 miss→hit、`private, max-age=31536000, immutable` 缓存头、
  伪造 ETag 不得 304、zip-slip 与路径越界 404、`/cover?w=0` → 400、8 路并发转码不同页全 200、
  页码进度读回、内嵌/同名歌词识别、在线歌词 + sidecar 落盘、缓存 `truncated` 字段、批量端点 200）。

## 升级

```bash
docker compose pull
docker compose up -d --force-recreate
```

镜像：`q807738511/vaulthub:v0.9.69` / `q807738511/vaulthub:latest`
回滚：`q807738511/vaulthub:v0.9.68`
