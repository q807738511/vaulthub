# `.workflow/` —— Gitee Go 流水线

v0.9.90 起，CI/CD 从 GitHub Actions 整体迁到这里。原因是 GitHub 账户停用后
`github.com/q807738511/vaulthub` 返回 404、`ghcr.io/q807738511/vaulthub` 返回 403 DENIED，
发布链路整条断掉。

## 文件

| 文件 | 对应原来的 | 触发 |
|---|---|---|
| `validate.yml` | `.github/workflows/validate.yml` | push / PR |
| `publish.yml` | `.github/workflows/publish-image.yml` | 推送 `v*` tag |

原来的 `sync-dockerhub-to-ghcr.yml` **已删除**：它的作用是把 GHCR 同步到 Docker Hub，
而现在 Docker Hub 是镜像主仓库，GHCR 不在发布链路的任何一环。

## 与 GitHub Actions 的关键差异

| GitHub Actions | Gitee Go |
|---|---|
| 目录 `.github/workflows/` | 目录 `.workflow/` |
| `on:` | `triggers:` |
| `jobs:` + `runs-on:` | `stages:` → `steps:`，任务即插件 |
| `uses: actions/checkout@v4` | 不需要，工作区默认就是代码库根目录 |
| `uses: docker/build-push-action` | `step: build@docker`（`repository` / `username` / `password` / `tag` / `dockerfile`） |
| `${{ github.* }}` / `$GITHUB_*` | `${GITEE_*}` / `${GITEE_*}` 系统参数 |
| `secrets.X` | 仓库级「全局参数」或「凭证」，用 `${X}` 引用 |
| `gh release create` | Gitee OpenAPI v5 + `curl`（`scripts/ci-release.sh`） |
| `::error title=` / `$GITHUB_STEP_SUMMARY` | 不支持，退化为 `echo` |
| `cache-from: type=gha` | 无对应物 |

## 发布的两条路

1. **NAS 上 `sh scripts/release-nas.sh <tag>`（推荐）** —— 零构建分钟消耗、
   三种 tag（`vX.Y.Z` / `latest` / `sha-xxxxxxx`）与原来完全对等、不依赖第三方 runner。
2. **Gitee Go 全托管** —— 推 tag 即触发 `publish.yml`。注意免费额度是
   单仓库 200 分钟（一次性）+ 个人每月 500 分钟，且 `build@docker` 只接受单个 tag 值。

## 首次运行要盯的三件事

1. `validate.yml` 的第一步是「工具自检」，会在日志里列出 runner 上缺哪些工具
   （`go / gcc / node / python3 / docker / curl / caddy`）。缺工具就用 Gitee 的
   **主机组**（`shell@agent` / `deploy@agent`）把命令下到 NAS 上跑。
2. `build@golang` 这个插件标识需要在「流水线 → 编辑 → 代码视图」的插件选择器里核对
   （老文档里叫 `golangbuild@1`）。
3. 打 tag 推送时 **版本号对应哪个系统变量没有官方文档**。Gitee Go 只列了
   `GITEE_BRANCH / GITEE_COMMIT / GITEE_COMMIT_MESSAGE`，没有 `GITEE_TAG`。
   `publish.yml` 用 `${GITEE_TAG:-${GITEE_BRANCH}}` 兜底并强制校验 `v1.2.3` 形状 ——
   解析不出来直接红灯，宁可失败也不发错版本。

`scripts/ci-release.sh` 的幂等 / 重试 / 读回校验逻辑有完整回归：
`python3 tests/test_v0970_release_step_logic.py`（静态 11 项 + 行为场景 10 项）。
