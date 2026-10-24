# 07 · Git、CI 与发布约定

## 1. 远端

| 远端 | 地址 | 用途 |
|---|---|---|
| `origin` | `<gitea-http-url>/enged/vaulthub.git` | 主仓（Gitea，自建）。`main` 是集成分支 |
| `gh` | `git@github.com:<owner>/vaulthub.git` | GitHub 镜像（按版本节奏同步，非每版必推） |

**克隆**：仓库公开可读，匿名 clone 即可：

```bash
git clone <gitea-http-url>/enged/vaulthub.git
```

**推送**需要凭据，二选一（具体值在交接包的 `CREDENTIALS.md`，不进仓库）：

1. **部署密钥（推荐，可单独吊销）**

```bash
cat > ~/.ssh/vaulthub_desktop <<'EOF'
<交接包里的私钥内容>
EOF
chmod 600 ~/.ssh/vaulthub_desktop

git config core.sshCommand "ssh -i ~/.ssh/vaulthub_desktop -o IdentitiesOnly=yes"
git remote set-url origin <gitea-ssh-url>:enged/vaulthub.git
git ls-remote --heads origin        # 读回验证
```

2. **访问令牌（HTTPS）**

```bash
git config credential.helper 'store --file=~/.git-credentials-vaulthub'
# 首次 push 输入用户名 + 令牌；或写入 ~/.git-credentials-vaulthub（0600）：
#   https://<user>:<token>@<gitea-host>
chmod 600 ~/.git-credentials-vaulthub
```

**禁止**：把令牌/私钥写进仓库、写进 `docker-compose.yml`、贴进 issue 或截图。

## 2. 分支与提交

- `main`：集成分支，受保护，**只能通过 PR 或负责人直接推**（当前单负责人模式）。
- 功能分支：`feat/desktop-<主题>`、修复：`fix/desktop-<主题>`；从最新 `main` 切出。
- 提交信息用 Conventional Commits：

```
feat(desktop): 播放器支持 Range 拖动
fix(desktop): 会话过期后未跳转登录
docs(desktop): 补充图形字幕烧录说明
```

- 一个提交一件事；不要在一个 PR 里混「重构 + 功能 + 格式化」。
- `go fmt` 只格式化你改过的文件（仓库里 `go fmt ./...` 会重排几十个无关文件）。

## 3. CI（Gitea Actions）

流水线在 `.gitea/workflows/`：

| 文件 | 触发 | 内容 |
|---|---|---|
| `validate.yml` | push 到任意分支 | 静态校验；无法取工具链时打印跳过（不亮假绿灯） |
| `publish-image.yml` | 推 `v*` tag | 构建/推送镜像 + 创建 Release（NAS 侧已先构建验证，CI 不重复构建） |

Runner 标签固定为 `ubuntu-latest:docker://node:16-bullseye`。
**如果你看到任务在「准备工作区（自行克隆）」步骤失败**，那是 runner 抖动（同一 commit 重跑即过），
不是你的代码问题 —— 先重跑一次再排查。

客户端仓库若独立，建议自带 `validate` 流水线（lint + 单元测试 + 打包 dry-run），
命名沿用 `<项目>-desktop`，CI 结论要贴进 PR。

## 4. 发布节奏

服务端由负责人按版本发布（`vX.Y.Z`，tag + Release + Docker Hub `:latest`）。
桌面客户端**独立版本号**（建议 `0.x` 起步），发版条件：

1. 自测矩阵（06 篇 14 项）全过；
2. 对**当前线上服务版本**（`GET /api/health` + `docs/api/openapi.yaml`）完成回归；
3. 安装包在三平台至少各装一次（Win/macOS/Linux，或团队约定的最小集合）。

对接口的破坏性需求（改名/删字段/改语义）**不要**在客户端侧「适配」掉，
把它写成 issue 给服务端：P0 面只增不改，破坏性变更要走版本并同步三处契约文档。

## 5. 提 issue / PR 时带上什么

- `GET /api/health` 输出（服务版本）
- 复现用的请求：方法、路径、关键请求头（**不要贴 Cookie**）、请求体
- 响应：状态码 + `{"ok":false,"error":"..."}` 原文
- 播放类问题再加 `POST /api/media/playback/plan` 的完整响应
- 客户端日志片段（脱敏）

## 6. 目录约定（客户端仓库建议）

```
vaulthub-desktop/
├── src/                 # 前端（渲染进程）
├── src-tauri/           # Tauri Rust 侧（HTTP、会话、播放协议）
├── docs/                # 从服务端仓库同步的 docs/desktop（只读参考）
├── scripts/             # 打包、签名、发版脚本
└── .gitea/workflows/    # lint + test + package
```

`docs/desktop/` 建议以 git submodule 或副本形式跟随服务端版本，**不要改内容**，
需要补充的客户端专属说明放 `docs/client-notes/`。
