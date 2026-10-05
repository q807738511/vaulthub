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
| `node:16-bullseye` | sh -n、node --check、gcc 语法、caddy validate | go test、前端测试套件（没 go / python3）、docker build |
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
