# 06 · 打包、自测与常见坑

## 1. 技术选型建议

| 方案 | 适合 | 关键点 |
|---|---|---|
| **Tauri 2** | 想控制体积（安装包 ~10MB）、Rust 侧做 HTTP 与播放 | 用 `reqwest` + `cookie_store` 维护会话；播放用系统 WebView 或原生播放器 |
| **Electron** | 生态熟悉、需要 Chromium 的播放能力 | HTTP 走主进程 `net`/`undici`，`protocol.handle` 把远程流映射成本地协议 |
| 原生 + WebView | 已有 C++/Rust 播放内核 | 同上，注意 Cookie 与 Range 转发 |

三个共同要求：

1. **HTTP 在原生层**（原因见 02 篇 CORS 一节）；
2. **Cookie 持久化到钥匙串**（`keyring` / `safeStorage`），退出登录时清；
3. **播放流经本地协议或本地端口**，不要把远程 URL 直接交给 `<video src>`（跨源 + 无凭据）。
   Tauri：注册 `asset://` 或 `stream://` 自定义协议；Electron：`protocol.handle('vh', …)`，
   转发 `Range` 头与 `Content-Range` 响应。

## 2. 打包前检查

```bash
# 1) 版本号写进关于页/安装包元数据（与 repo 的 tag 对齐，客户端自己定版本，不跟服务端）
# 2) 默认服务地址可改（配置页），不要硬编码内网 IP
# 3) 会话存储走钥匙串；日志脱敏（Cookie/密码不得落盘）
# 4) 更新检查：调用 GET /api/health 判断可达性，失败时给「离线/地址错误」明确文案
```

安装包命名建议：`VaultHub-Desktop-<版本>-<平台>-<架构>.<ext>`，例如
`VaultHub-Desktop-0.1.0-windows-x64.msi`、`VaultHub-Desktop-0.1.0-macos-arm64.dmg`、
`VaultHub-Desktop-0.1.0-linux-x64.AppImage`。

## 3. 自测矩阵（每轮发版都跑）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 错误密码 3 次 → 正确密码 | 前 3 次 401 提示；正确后进入首页；**连错 5 次会锁 5 分钟** |
| 2 | 杀掉进程重开 | 会话仍在（Cookie 已持久化），直接进首页 |
| 3 | 服务端地址填错 | 明确的「无法连接」提示，不是白屏 |
| 4 | 库列表 → 网格滚动 | 封面用 `w=320`，滚动不卡；无封面显示占位 |
| 5 | 直连播放（H.264 MP4） | 秒开、可拖、`Range` 生效 |
| 6 | 转码播放（HEVC MKV） | 有起播等待提示；`live` 态拖动按 04 篇策略 |
| 7 | 关播放器 | `stop` 发出；服务端 CPU 回落 |
| 8 | 播 30s 后退出重开 | 进度读回并提示继续 |
| 9 | 图形字幕（PGS） | 烧录生效；直连模式下提示「需切转码」 |
| 10 | EPUB / CBZ / PDF | 打开、翻页、进度回写、重开续读 |
| 11 | 音频 320k → 128k 切换 | 有转码提示；切档后可播 |
| 12 | 断网 30 秒再恢复 | 播放器重连而不是崩溃；列表可重试 |
| 13 | 大库（>5000 文件） | 虚拟滚动；`indexing` 时显示进度 |
| 14 | 服务端重启 | 客户端 401 → 自动跳登录（会话在 sessions.json 里通常仍有效，先重试一次） |

## 4. 常见坑（按出现频率排序）

1. **渲染进程直接 fetch**：CORS 无响应头 → 表现为「请求发出去了但没有数据」。
   先看 DevTools 的 Network 是否 `(CORS error)`，是就把请求挪到原生层。
2. **Cookie 没带**：原生 HTTP 库默认不共享 Cookie 罐。登录响应的 `Set-Cookie` 要手动存，
   后续请求手动加 `Cookie: vh_session=...`（或配置 `cookie_store`）。
3. **播放器发 `Range` 给 live 流**：`Accept-Ranges: none`，播放器表现为卡死/无限等待。
   先看 `X-VaultHub-Compat` 头再决定是否允许拖动。
4. **忘了 `stop`**：转码任务继续跑，CPU 打满，用户以为「软件很卡」。
5. **封面拉原图**：单张可能几 MB，网格 60 张就是几百 MB。务必带 `w=320`。
6. **每帧写进度**：`playback/progress` 是全量 JSON 落盘，高频写入会拖慢磁盘。
7. **把 `path` 二次编码**：服务端已 `QueryEscape` 处理，客户端只做一次 URL 编码，
   不要对整条 URL 再 encode 一遍（会出现 `%2520`）。
8. **登录限速连带**：自动重连逻辑里带登录重试时，错误密码会累计到 5 次锁定。
   重连只重放已保存的会话，不要重回密码。

## 5. 调试工具

```bash
# 会话是否有效（200=有效；media-go 也只认这个 200）
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: $C" \
  'http://<host>:8088/api/media/files?id=lib-movie&limit=1'

# 播放决策（贴到 issue 里最有用）
curl -s -X POST 'http://<host>:8088/api/media/playback/plan' -H "Cookie: $C" \
  -H 'Content-Type: application/json' \
  -d '{"library_id":"lib-movie","path":"<file>","quality":"auto",
       "client":{"mp4":true,"h264":true,"aac":true}}'

# 转码流形态（看 X-VaultHub-Compat）
curl -sI "http://<host>:8088/api/media/compat?id=lib-movie&path=<file>" -H "Cookie: $C" \
  | grep -iE 'x-vaulthub-compat|accept-ranges|content-type'
```

## 6. 与 WebUI 的关系

WebUI 是**服务端自带的参考实现**（同一套接口）。遇到行为不一致时以接口响应为准，
可以把 WebUI 的请求（浏览器 DevTools）当作对照样本，但不要复制它的 Cookie 处理方式
（它跑在同源页面里，天然没有 CORS 问题）。
