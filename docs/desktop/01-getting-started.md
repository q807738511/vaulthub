# 01 · 环境与上手

## 1. 你需要什么

| 项 | 要求 |
|---|---|
| 服务实例 | VaultHub **v1.0.7 及以上**，对外只有一个入口端口（默认 `8088`） |
| 网络 | 能访问 `<vault-hub-host>:8088/api/health` 并返回 `{"ok":true}` |
| 本地工具链 | Node 20+ / Rust 1.77+（Tauri）或 Electron 28+；`curl`、`git` |
| 测试媒体 | 一个已建好的媒体库（影视/音乐/书刊/漫画任一），库内至少 1 个可播文件 |

服务端信息由项目负责人提供三样东西（不在仓库里）：

1. **入口地址**：`http://<vault-hub-host>:8088`（生产若走反向代理，用 `https://<你的域名>`）
2. **账号**：管理账号（单用户体系，没有多账号概念）
3. **测试库 ID**：例如 `lib-movie`，客户端调试时直接用，不要自己建库

## 2. 获取代码

仓库在自建 Gitea 上，`main` 为默认分支：

```bash
git clone <gitea-http-url>/enged/vaulthub.git
cd vaulthub
git log --oneline -3          # 期望看到 v1.0.7 相关提交
```

推送到远端需要凭据 —— 具体地址、账号与密钥在**交接包**里（`CREDENTIALS.md`），
代码仓本身不含任何凭据。约定见 [07-git-ci-and-release.md](07-git-ci-and-release.md)。

## 3. 起一个可用的服务实例

### 3.1 已经有实例（推荐）

直接用负责人给的地址调试，不要重复部署。冒烟：

```bash
BASE=http://<vault-hub-host>:8088
curl -s "$BASE/api/health"
curl -s "$BASE/api/auth/mode"      # {"ok":true,"mode":"password","username":"admin",...}
```

### 3.2 本地起一个（离线开发 / 造数据）

仓库自带 `docker-compose.yml`，容器内 Caddy 是唯一入口：

```bash
# 数据目录与媒体目录按需改；测试媒体可先用 examples 里的 4KB 占位文件
mkdir -p ./vh-data ./vh-media/movies
docker compose up -d
docker compose logs -f vault-hub | head -30
curl -s http://127.0.0.1:8088/api/health
```

首次启动会把 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 写进数据卷；
**未设置 `ADMIN_USERNAME` 时默认用户名是大写 `ADMIN`**（很多人在这里卡住）。

登录并建库（一次性）：

```bash
BASE=http://127.0.0.1:8088
C=$(curl -si -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
      -d '{"username":"ADMIN","password":"<本地密码>","keep_days":30}' \
    | grep -i '^set-cookie' | sed 's/.*: //;s/;.*//')

curl -s -X POST "$BASE/api/media/libraries" -H "Cookie: $C" -H 'Content-Type: application/json' \
  -d '{"id":"lib-movie","name":"电影","type":"movie","path":"/media/movies"}'
sleep 5
curl -s "$BASE/api/media/files?id=lib-movie&limit=5" -H "Cookie: $C"
```

`type` 取值：`movie` / `series` / `audio` / `musicvideo` / `book` / `comic`。
新增库会触发后台索引，`/api/media/files` 的 `status` 从 `indexing` 变 `ready` 才算完成。

## 4. 冒烟脚本

`examples/smoke.sh` 覆盖「登录 → 库列表 → 文件分页 → 封面 / 播放决策」，全部只读：

```bash
BASE=http://<vault-hub-host>:8088 VH_USER=admin VH_PASS='***' \
  bash docs/desktop/examples/smoke.sh
```

期望最后一行 `SMOKE OK`。脚本不写任何数据（不建库、不改进度），可反复跑。

## 5. 调试建议

- **先打 HTTP，再做 UI**：`examples/minimal-client.ts` 是一个 200 行的 Node 客户端，
  跑通它再写界面，能排除 80% 的「界面没问题但接口不对」。
- **401 打点**：所有请求统一走一个 `request()`，收到 401 就清会话并弹登录，
  不要在每个页面各写一遍（服务端重启后会话仍在，但密码改过会全体失效）。
- **封面走缩略**：`/api/media/cover?id=..&path=..&w=320`，列表页不要拉原图（单张可能 MB 级）。
- **别缓存 `/api/media/files` 的 `version` 字段以外的分页结果**，索引重建会让 `version` 变。

## 6. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `login` 返回 401 `invalid credentials` | 默认用户名是大写 `ADMIN`，或密码被容器首次启动改写 | 看 `docker compose logs` 里首次启动输出 |
| 连续失败后返回 429 | 同 IP 5 次失败锁 5 分钟 | 等 5 分钟；测试时别用错误密码循环重试 |
| 所有 `/api/media/*` 返回 401 | `libraries/index/status/hardware/scrapers` 自 v1.0.7 起需会话 | 先登录拿 Cookie，再带上 |
| 浏览器 `fetch` 报 CORS 且无响应头 | 服务端不提供 CORS | HTTP 放原生层（Tauri/Electron 主进程） |
| 直连播放器 seek 卡住 | 用了 `/compat` 的 live 流（`Accept-Ranges: none`） | 见 04 篇的 seek 策略 |
| 封面 404 | `path` 必须是相对库根的路径，且 `/` 分隔 | 用 `/api/media/files` 返回的 `path` 原样回传 |
