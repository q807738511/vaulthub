# VaultHub v0.6.27

## 本次更新

- 修复 GitHub Actions `Validate` 工作流仍引用已移除的生产 `media-api.c`，导致阶段 2 发布后校验失败的问题。
- 校验流程改为对 `manager` 和 `media-go` 执行 `go test`、`go vet` 和 `go build`。
- 显式使用 Go 1.23，并继续严格检查 `vaulthub-manager.c` 与 `tests/fixtures/media-api_legacy.c`。
- Compose 校验改为兼容写法，避免依赖 `config --quiet` 可选参数。

## 验证

- Manager 与 Media Go 服务测试、vet、构建通过。
- Shell、JavaScript、Caddyfile 和历史 C fixture 校验通过。
- `git diff --check` 通过。
