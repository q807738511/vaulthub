# `.workflow/` —— Gitee Go 流水线

v0.9.90 起，CI/CD 从 GitHub Actions 整体迁到这里。原因是 GitHub 账户停用后
`github.com/q807738511/vaulthub` 返回 404、`ghcr.io/q807738511/vaulthub` 返回 403 DENIED，
发布链路整条断掉。

## 文件

| 文件 | 对应原来的 | 触发 |
|---|---|---|
| `validate.yml` | `.github/workflows/validate.yml` | push（所有分支）/ PR |
| `publish.yml` | `.github/workflows/publish-image.yml` | 推送 `v*` tag |

原来的 `sync-dockerhub-to-ghcr.yml` **已删除**：它的作用是把 GHCR 同步到 Docker Hub，
而现在 Docker Hub 是镜像主仓库，GHCR 不在发布链路的任何一环。

## 方言对照（按 Gitee 官方 demo 仓库里真实跑通过的 yml 校准）

> 参考：`gitee.com/gitee-go/spring-boot-gradle-deploy-case` 的
> `.workflow/MasterPipeline.yml`、`gitee-go/spring-boot-maven-deploy-case` 的
> `.workflow/pipeline-20221130.yml`。**别再照搬 GitHub Actions 的字段名猜。**

```yaml
version: '1.0'            # ← 必须有
name: <流水线标识>         # ← 阶段/流水线用 name: 作标识（不是 stage:）
displayName: <显示名>
triggers:
  trigger: auto           # ← 自动触发总开关
  push:
    branches: {prefix: ['']}   # 空前缀 = 所有分支
    tags:     {prefix: [v]}    # 分支/Tag/提交注释三类规则是**交集**
stages:
  - name: <阶段标识>       # ← 用 name:，不是 stage:
    displayName: <阶段名>
    strategy: naturally   # naturally / fast
    trigger: auto
    steps:
      - step: build@<插件>  # 任务即插件
        name: <步骤标识>
        displayName: <步骤名>
        commands:
          - |
            <shell 脚本，一个块里写完，避免命令之间不共享 shell 状态>
```

| GitHub Actions | Gitee Go |
|---|---|
| 目录 `.github/workflows/` | 目录 `.workflow/` |
| `on:` | `triggers:`（另有总开关 `triggers.trigger: auto`） |
| `jobs:` + `runs-on:` | `stages:` → `steps:`，任务即插件 |
| 阶段标识 `stage:` | 阶段标识 **`name:`** |
| `uses: actions/checkout@v4` | 不需要，工作区默认就是代码库根目录 |
| `uses: docker/build-push-action` | `step: build@docker`（`repository` / `username` / `password` / `tag` / `dockerfile` / `isCache`），产出参数 `GITEE_DOCKER_IMAGE` |
| `uses: actions/setup-go` | `step: build@golang`（`golangVersion`），默认走 `goproxy.cn` |
| `${{ github.* }}` / `$GITHUB_*` | `${GITEE_*}`；自定义参数写在 `variables:` 里，运行时可用 `echo 'KEY=VALUE' >> GITEE_PARAMS` 往下游传 |
| `secrets.X` | 仓库/流水线级「全局参数」，用 `${X}` 引用 |
| `gh release create` | Gitee OpenAPI v5 + `curl`（`scripts/ci-release.sh`） |
| `::error title=` / `$GITHUB_STEP_SUMMARY` | 不支持，退化为 `echo` |
| `cache-from: type=gha` | 无对应物（`build@golang` 有 `caches:` 支持 `/go/pkg/mod`） |

**系统参数里没有 `GITEE_TAG`**（官方只文档化了 `GITEE_BRANCH` / `GITEE_COMMIT` /
`GITEE_COMMIT_MESSAGE` / `GITEE_PIPELINE_*` / `GITEE_REPO` …）。所以 `publish.yml`
第①步用 `git tag --points-at HEAD` 先取版本号，系统变量只作退路；解析不出来**直接红灯**。

## 发布的两条路

1. **NAS 上 `sh scripts/release-nas.sh <tag>`（推荐）** —— 零构建分钟消耗、
   三种 tag（`vX.Y.Z` / `latest` / `sha-xxxxxxx`）与原来完全对等、不依赖第三方 runner。
2. **Gitee Go 全托管** —— 推 tag 即触发 `publish.yml`。注意免费额度是
   单仓库 200 分钟（一次性）+ 个人每月 500 分钟，且 `build@docker` 只接受单个 tag 值，
   所以 `latest` 要单独一步（构建分钟翻倍）。

## 首次运行要盯的四件事

1. **`validate.yml` 里 gcc / node / python3 / docker / caddy 不一定在托管 runner 上。**
   工具不在就打印【跳过】并继续（不许因为缺工具假红），末尾会列一份【跳过清单】。
   想全量校验，用 Gitee 的**主机组**（`shell@agent` / `deploy@agent`）把命令下到 NAS 上跑。
2. **插件标识**（`build@python` / `build@docker` / `build@golang`）在
   「流水线 → 编辑 → 代码视图」的插件选择器里核对一次。
3. **打 tag 推送时版本号对应哪个系统变量没有官方文档** —— 见上文，已用 git 兜底。
4. **`triggers` 里分支 / Tag / 提交注释三类匹配规则是交集**。`publish.yml` 只写了
   `tags.prefix: [v]`；首跑后到「触发记录」确认一次普通分支推送没被误触发。

## 需要在「流水线 → 全局参数」里建的参数

| 参数 | 值 |
|---|---|
| `DOCKERHUB_USERNAME` | `q807738511` |
| `DOCKERHUB_TOKEN` | Docker Hub 访问令牌（不是登录密码） |
| `GITEE_TOKEN` | Gitee 个人访问令牌，需勾 `projects` 权限 |

`scripts/ci-release.sh` 的幂等 / 重试 / 读回校验逻辑有完整回归：
`python3 tests/test_v0970_release_step_logic.py`（静态 11 项 + 行为场景 10 项）。
