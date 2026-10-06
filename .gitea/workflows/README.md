# VaultHub 在 Gitea 上的 CI（Gitea Actions）

这套流水线是 **Gitea 原生**写的：纯 `sh`，不引用任何外部 action，
所以内网 runner 不需要访问 github.com。

```
.gitea/workflows/validate.yml          校验：sh -n / node --check / go / gcc / 测试套件 / compose
.gitea/workflows/publish-image.yml     tag 构建：版本一致性 → 发布说明 → 测试 → 推 Docker Hub → Gitea Release
scripts/ci-release-gitea.sh            Gitea Release 幂等创建（幂等 + 重试 + 读回校验）
```

## 一、Runner 侧的两个必须条件

**1. 标签必须含 `ubuntu-latest`**（两个工作流都是 `runs-on: ubuntu-latest`）。
注册时 `--labels` 或容器环境变量 `GITEA_RUNNER_LABELS` 里要有它，例如：

```
GITEA_RUNNER_LABELS=ubuntu-latest:docker://node:16-bullseye
```

> 逗号分隔多个标签时，**逗号后面不要留空格**。官方入口脚本 `scripts/run.sh` 里
> `LABEL_ARGS="--labels ${GITEA_RUNNER_LABELS}"` 是不加引号展开的，
> 一个空格会把第二个标签变成 `register` 的位置参数，直接报
> `Error: accepts at most 0 arg(s), received 1`，注册永远不成功。

**2. 镜像里有什么，CI 就能跑什么。**

| job 镜像 | 能跑 | 跑不了 |
|---|---|---|
| `node:16-bullseye` | sh -n、node --check、gcc 语法、caddy validate、**大部分测试套件**（python3 是有的；缺 ffmpeg / go / zip / gh / jq 的用例会逐条打印「跳过」） | go test、需要 ffmpeg 或 go 的用例、docker build |
| `catthehacker/ubuntu:act-latest` | 上面全部 + go + python3 | docker build（除非另挂 socket） |

要让「构建并推送镜像」在 CI 里真跑，还得在 act_runner 的 `config.yaml` 给 job 容器挂 socket：

```yaml
container:
  options: "-v /var/run/docker.sock:/var/run/docker.sock"
```

不想给 runner 开 docker 权限也行 —— 那就继续在 NAS 上跑 `scripts/release-nas.sh`，
CI 只负责校验和发布说明把关（流水线会打印 `::warning::` 明说本次没构建）。

## 二、仓库密钥

| 名称 | 用途 | 缺失时 |
|---|---|---|
| `DOCKERHUB_USERNAME` | 推 Docker Hub | 到构建步骤报错退出 |
| `DOCKERHUB_TOKEN` | 同上 | 同上 |
| `GITEA_RELEASE_TOKEN` | 建 Gitea Release | 该步骤打印 warning 后跳过 |

`GITEA_RELEASE_TOKEN` 用仓库级访问令牌，权限勾 `repository: read and write` 即可。

## 三、GitHub 原版工作流怎么恢复

两个 GitHub Actions 时代的工作流**没有被删除**，而是原样保留了两份：

1. `.github/workflows/publish-image.yml.disabled`
2. `.github/workflows/validate.yml.disabled`
   —— 字节级原文。恢复只需把扩展名改回 `.yml`。
3. 同样的内容也**整体注释**在两个 `.gitea/workflows/*.yml` 文件末尾，
   方便直接在 Gitea 的网页上查看对比。

恢复步骤：

```sh
git mv .github/workflows/validate.yml.disabled      .github/workflows/validate.yml
git mv .github/workflows/publish-image.yml.disabled .github/workflows/publish-image.yml
git rm .gitea/workflows/validate.yml .gitea/workflows/publish-image.yml   # 免得两边各跑一遍
```

恢复前确认：GitHub 账户已可用、`ghcr.io` 能推（原版推的是 `ghcr.io`，不是 Docker Hub），
并且重新配好 `GITHUB_TOKEN` 相关权限。

## 四、和 Gitee Go 那套的关系

`.workflow/validate.yml`、`.workflow/publish.yml` 是 **Gitee Go** 的方言，Gitea 不认；
`.gitea/workflows/*` 是 **Gitea Actions** 的，Gitee 不认。两套互不干扰，
放在同一个仓库里随平台各取所需。

## 三、踩过的坑（都已在工作流里兜住，改的时候别踩回去）

**1. act_runner 交下来的工作目录是空的。**
Job 容器里的工作目录连 `.git` 都没有（实测：探测脚本算出「工作区条目 = 0」），
所以任何读文件的步骤都会在第 1~2 步、3~4 秒内退出——
`[ ! -d scripts ]`、「版本号读不到」都不是逻辑错，是没有代码可读。
`actions/checkout@v4` 内网又拉不到，因此每个工作流的**第一步**都自己克隆：
纯 `git init + git remote add + git fetch --depth=1 $GITHUB_REF + git checkout -f FETCH_HEAD`，
工作区已有代码时直接跳过。

**2. Gitea/act 执行 `run:` 块用的是 `bash -eo pipefail`（与 GitHub 一致）。**
脚本按 `set -eu` 语义写的人会在这里翻车：`grep ... | sort -u | head -3 | sed ...`
在 **grep 没匹配**（或 head 提前退出触发 SIGPIPE）时整条管道返回非 0，
被 `set -e` 当场判死——表现为「1~2 秒红灯」，看不出任何逻辑问题。
所以每个 `run:` 块在 `set -eu` 之后都有一行
`if [ -n "${BASH_VERSION:-}" ]; then set +o pipefail; fi`（dash 下无副作用）。

**3. 测试里不许写死开发机路径。**
7 个行为测试的 node harness 曾写死 `const ROOT = "/opt/data/vaulthub-github"`，
两个 Python 用例把临时目录钉在 `/opt/data`。开发机上路径存在 → 本地永远全绿，
CI 上必然 ENOENT → 永久红灯。现在一律按文件位置推导（`path.resolve(__dirname, "..")`，
可用 `VH_ROOT` / `VH_TMPDIR` 覆盖）。

**4. `.github/workflows/` 里的活工作流会被 Gitea 一起扫。**
Gitea 同时扫 `.gitea/workflows/` 和 `.github/workflows/`。GitHub 原版若以 `.yml` 存在，
每次推送就多跑一遍，而它们第一步是 `actions/checkout@v4`（内网拉不到，3 秒必红），
名字还和原生版撞车（都叫 `Validate` / `Publish`）——看起来像原生版在失败。
按既定约定：**原版一律保持 `.disabled`**（内容逐字节保留，改名即可恢复）。
三个直接读活路径的测试已改成「优先读 `.disabled`」。

**5. 日志不用登录也能看（这是排查的关键手段）。**
- `GET /api/v1/repos/{owner}/{repo}/commits/{sha}/status` → 公开仓库匿名可读，
  **逐个 job** 的结论（context 形如 `Validate / validate (push)`）与耗时都在里面；
- job 日志本身要登录/令牌（`/actions/runs/N/jobs/M/logs` → 404）；
- 想逐项定位时，把要查的东西拆成**矩阵 job**（`strategy.matrix`），
  每个矩阵项就是一个独立 job，于是「哪一项红」直接从上面那个公开接口读出来——
  比要令牌快得多，也留下了「`zz-probe-*` 探测工作流探完即删」的做法。
