# `.workflow/` —— Gitee Go 流水线

v0.9.90 起，CI/CD 从 GitHub Actions 整体迁到这里。原因是 GitHub 账户停用后
`github.com/q807738511/vaulthub` 返回 404、`ghcr.io/q807738511/vaulthub` 返回 403 DENIED，
发布链路整条断掉。

## 文件

| 文件 | 对应原来的 | 触发 |
|---|---|---|
| `validate.yml` | `.github/workflows/validate.yml` | push（所有分支）/ PR |
| `publish.yml` | `.github/workflows/publish-image.yml` | 推送 `release-v*` 分支（见下） |

原来的 `sync-dockerhub-to-ghcr.yml` **已删除**：它的作用是把 GHCR 同步到 Docker Hub，
而现在 Docker Hub 是镜像主仓库，GHCR 不在发布链路的任何一环。

## 实测踩到的三个坑（2026-10-05，有日志为证）

1. **「Tag 匹配」是生效的，别再误判。** 构建 #1（13:16:47，tag `v0.9.89` → `aa11745`）
   就是推 tag 触发的；当初以为它"不触发"，是因为构建历史列表按分支 `main` 过滤过，
   把 tag 触发的那条记录挡掉了。`publish.yml` 现在仍用**分支触发**（推 `release-vX.Y.Z`），
   理由只是「重跑方便」：重推分支即可再触发，不用反复删改 tag。
   ⚠️ 分支匹配与 Tag 匹配是**交集**关系，一条流水线里只能留一个。
2. **运行器的 checkout 是 `git fetch --no-tags --prune --depth=1`**，本地**一个 tag 都没有**，
   所以 `git tag --points-at HEAD` 永远是空 —— 不能拿它当版本号来源。
   → 版本号改为「系统变量（发布分支名）解析 + **远端** tag 核对」，
   远端核对有两条路：`git ls-remote --tags origin`，失败则 Gitee OpenAPI（走 `GITEE_TOKEN`）。
3. **分支 / Tag / 提交注释三类匹配规则是交集关系**（官方文档）：同时设置需全部满足。
   所以 `publish.yml` **只写 `branches`**，不写 `tags` —— 否则分支推送会因为「没带 tag」
   而永远匹配不上。

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
| `uses: actions/setup-go` | `step: build@golang`（`golangVersion`） |
| `${{ github.* }}` / `$GITHUB_*` | `${GITEE_*}`；自定义参数用 `echo 'KEY=VALUE' >> GITEE_PARAMS` 往下游传 |
| `secrets.X` | 流水线「通用变量」（旧文档写作「全局参数」），用 `${X}` 引用 |
| `gh release create` | Gitee OpenAPI v5 + `curl`（`scripts/ci-release.sh`） |
| `::error title=` / `$GITHUB_STEP_SUMMARY` | 不支持，退化为 `echo` |
| `cache-from: type=gha` | 无对应物（`build@golang` 有 `caches:` 支持 `/go/pkg/mod`） |

**系统参数里没有 `GITEE_TAG`**（官方只文档化了 `GITEE_BRANCH` / `GITEE_COMMIT` /
`GITEE_COMMIT_MESSAGE` / `GITEE_PIPELINE_*` / `GITEE_REPO` …），而 checkout 又不带 tag。
所以 `publish.yml` 第①步从系统变量（发布分支名）解析版本号，再去**远端**核对 tag 存在且指向
本次提交；核对不上又拿不到远端列表时按系统变量继续（创建发行版那步会再校验一次）。

## 发布的两条路

1. **NAS 上 `sh scripts/release-nas.sh <tag>`（零构建分钟消耗）** —— 一次推三种 tag
   （`vX.Y.Z` / `latest` / `sha-xxxxxxx`），与原来的发布完全对等、不依赖第三方 runner。
2. **Gitee Go 全托管** —— 三条命令：
   ```sh
   git push gitee HEAD:main                        # 代码
   git push gitee refs/tags/vX.Y.Z                 # 版本 tag（发行版要用）
   git push gitee HEAD:refs/heads/release-vX.Y.Z   # ← 这一下才触发 release 流水线
   ```
   免费额度：单仓库 200 分钟（一次性）+ 每月 500 分钟；`build@docker` 只接受单个 tag 值，
   所以 `latest` 要单独一步（构建分钟翻倍）。发布分支可以留着当记录，也可以发布后删掉。

## 首次运行要盯的四件事

1. **`validate.yml` 里 gcc / node / python3 / docker / caddy 不一定在托管 runner 上。**
   工具不在就打印【跳过】并继续（不许因为缺工具假红），末尾会列一份【跳过清单】。
   想全量校验，用 Gitee 的**主机组**（`shell@agent` / `deploy@agent`）把命令下到 NAS 上跑。
2. **插件标识**（`build@python` / `build@docker` / `build@golang`）在
   「流水线 → 编辑 → 代码视图」的插件选择器里核对一次（`build@golang` 已证实可用）。
3. **`build@docker` 个人版没有「构建参数」字段**，传不了 `--build-arg` ——
   构建源（`GO_IMAGE` / `RUNTIME_IMAGE` / `GOPROXY` / `APT_MIRROR`）已写进 `Dockerfile` 默认值。
4. **流水线参数在插件字段里的替换**（`tag: ...:${VH_TAG}`）以首跑结果为准；
   替换不成功只会让该步失败，不会推错标签。

## 需要在「流水线 → 通用变量」里建的参数

| 参数 | 值 |
|---|---|
| `DOCKERHUB_USERNAME` | `q807738511` |
| `DOCKERHUB_TOKEN` | Docker Hub 访问令牌（不是登录密码） |
| `GITEE_TOKEN` | Gitee 个人访问令牌，需勾 `projects` 权限 |

`scripts/ci-release.sh` 的幂等 / 重试 / 读回校验逻辑有完整回归：
`python3 tests/test_v0970_release_step_logic.py`（静态 11 项 + 行为场景 10 项）。
