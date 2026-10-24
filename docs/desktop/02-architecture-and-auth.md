# 02 · 架构、会话与错误约定

## 1. 拓扑（客户端只需要知道一个端口）

```
客户端 ──► :8088（Caddy，唯一入口）
             ├─ /api/health /api/login /api/logout /api/auth/mode
             │  /api/account /api/system/runtime /api/admin/*   → manager  127.0.0.1:9099
             ├─ /api/system/*                                    → media-go 127.0.0.1:9100
             ├─ /api/media/subtitles/search|download（精确匹配）  → subtitle-api 9120
             ├─ /api/media/*                                     → media-go 9100
             └─ 其余                                              → 静态 WebUI
```

对客户端而言：**所有请求都打 `http://<host>:8088`，路径前缀区分服务**，不需要知道内部端口。

## 2. 会话模型

登录成功下发 Cookie：

```
Set-Cookie: vh_session=<48 位小写 hex>; Path=/; HttpOnly; SameSite=Lax[; Secure]
```

- **单账号体系**：没有多用户、没有角色，登录即全权限。
- **TTL 两档**：`keep_days >= 60` → 60 天，其余（含缺省）→ 30 天；**每次请求滑动续期**。
- **服务端持久化**：`/data/sessions.json`，按到期时间保留最近 256 条。容器重启后旧 Cookie 仍有效。
- **限速**：同 IP 连续 5 次登录失败锁 5 分钟（`429 too many login attempts`），成功登录清零。
- **must_change 受限会话**：只能访问 `/api/account`、`/api/system/runtime` 等白名单，
  其它端点 401。客户端遇到 `must_change:true` 应引导改密。

客户端实现要点：

1. Cookie 罐放**原生层**，持久化到系统钥匙串或应用数据目录（Tauri: `keyring` crate；
   Electron: `safeStorage`），别写 localStorage（渲染进程可被 XSS 读走）。
2. 统一 `request()`：401 → 清会话 → 弹登录；429 → 提示「5 分钟后再试」，不要重试。
3. 退出：`POST /api/logout` 吊销当前会话并下发过期 Cookie。
4. 同一台设备只保留一个会话；多设备各自一个 Cookie，服务端最多留 256 条。

## 3. 为什么没有 CORS（桌面端必须注意）

服务端**不下发** `Access-Control-Allow-Origin`，预检 `OPTIONS` 直接返回 401。因此：

| 方案 | 能不能用 | 说明 |
|---|---|---|
| Tauri 渲染进程 `fetch` | ✗ | WebView 按浏览器规则执行，跨源被拦 |
| Electron 渲染进程 `fetch`（`file://`/dev server） | ✗ | 同上 |
| Tauri Rust 侧 `reqwest` | ✓ | 推荐；Cookie 用 `cookie_store` 或自己维护 |
| Electron 主进程 `net` / `undici` | ✓ | 通过 IPC 暴露给渲染进程 |
| 自建本地反代（localhost:xxxx → 远程） | ✓ | 可行但多一层；仅在必须用浏览器 HTTP 时选 |

同理，`media` 播放也不能把 URL 直接丢给 `<video src>` 跨源加载 —— 需要在原生层拉流再喂给
播放器（Tauri 可用自定义协议 `asset://` 或本地代理端口；Electron 可用 `protocol.handle`）。

## 4. 错误约定

所有 JSON 错误恒为：

```json
{"ok": false, "error": "login required"}
```

| 状态码 | 含义 | 客户端动作 |
|---|---|---|
| 400 | 参数/JSON 非法 | 修请求，别重试 |
| 401 | 未登录 / 会话失效 | 清会话 → 登录 |
| 403 | 受限会话被拦（must_change） | 引导改密 |
| 404 | 库/文件/会话不存在 | 提示并刷新列表 |
| 405 | 方法不允许 | 检查方法与路径 |
| 409 | 冲突（如禁用转码时的原盘） | 按 `warn` 文案提示用户 |
| 422 | 探测失败 / 无可读内容 | 提示文件损坏或格式不支持 |
| 429 | 登录限速 / 并发超限 | 等待，不重试 |
| 503 | 组件不可用（数据库/poppler 等） | 提示稍后再试 |

**契约字符串**（改动即视为破坏兼容，客户端可直接按值判断）：

`login required`、`invalid media path`、`library not found`、`file not found`、
`invalid credentials`、`too many login attempts`、`method not allowed`、`session not found`。

## 5. 版本与兼容

- 服务端**没有** `/v1/` 前缀；兼容性靠「只增不改」：P0 端点字段只新增、不改名、不改语义。
- 契约基线随版本发布冻结：当前 `v1.0.7`（见 `docs/api/openapi.yaml`）。
- 客户端应把 `GET /api/health` 的 `service` 与自身「最低支持版本」比对，低于则提示升级；
  不要用 WebUI 的 `?v=` 参数判断（那是静态资源版本，与 API 无关）。
- 发现缺失字段：优先按「缺省 = false / 0 / 空」处理，再向服务端提需求，不要自行猜默认值。

## 6. 安全边界（客户端不要绕过）

- 服务端只信任 Cookie，不认 `Authorization: Bearer`。
- 路径参数一律是**相对库根**的路径（`/` 分隔）；绝对路径、`..`、反斜杠都会被拒（404）。
- 不要尝试拼接磁盘路径访问库外文件 —— 服务端做 `EvalSymlinks` 包含性校验。
- 客户端日志里不要打印 Cookie 与密码。
