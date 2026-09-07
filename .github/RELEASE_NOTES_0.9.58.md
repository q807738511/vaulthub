# VaultHub v0.9.58 发布说明

## 一句话

登录安全加固：移除 `admin123` 默认密码，首次启动改为生成一次性随机初始密码并公布到容器日志，登录后强制改密（服务端受限会话），并增强密码复杂度校验（前后端一致）。

## 1. 移除 admin123 默认密码

- `docker-compose.yml` 与镜像内置 `ENV` 不再携带 `ADMIN_PASSWORD=admin123`（此前任何人用默认密码即可登录，是最大的安全隐患）。
- `ADMIN_PASSWORD` 留空 = 走「一次性随机初始密码」流程；需要固定初始密码时才显式填写。

## 2. 一次性随机初始密码（首次启动）

- 首次启动且未配置 `ADMIN_PASSWORD` 时，**不再进入开放模式**，而是生成一个 **16 位**（无歧义字符集，不含 0/O、1/l/I）随机初始密码。
- 该密码**打印到容器日志**（`docker logs VaultHub`），并以 `must_change=true` 持久化到 `/data/auth.json`（0600）。
- **只生成一次**：容器升级（重建容器但保留 `/data` 卷）时若 `auth.json` 仍在，就不会重新生成/重新校验随机密码，现有部署不受影响；删除 `auth.json` 后才会再次生成。

## 3. 登录后强制改密（受限会话）

- 用随机初始密码登录即建立**受限会话**：前端强制弹出「设置新密码」弹窗（不可点遮罩关闭）；服务端同时拦截除改密外的所有受保护操作与媒体写操作（返回 403 + `must_change`）。
- 改密成功后 `must_change` 清除、当前会话升级为完整会话，初始密码随改密失效。
- 受限会话白名单路径仅：`/api/account`（改密）、`/api/auth/mode`、`/api/logout`、`/api/system/runtime`、`/api/health`。

## 4. 增强密码校验（前后端一致）

- 新密码至少 **8 位**、需**同时包含字母和数字**、命中弱口令黑名单（`admin123` / `password` / `12345678` 等 20 项）或**包含用户名**时拒绝。
- 前端 `validateClientPassword` 与后端 Go `validatePassword` 规则一致，改密/切回密码模式/账户保存三处共用。

## 验证

- Go `vet` + `test` 全绿（新增随机密码生成器 / 增强校验 / must_change 持久化往返 / 受限会话白名单用例）
- Python 契约测试全绿（含 v0.9.58 静态契约）
- `node --check` 全过
- 真实容器 API 验证：首次启动生成随机密码 → 登录返回 `must_change:true` → 受限会话访问受保护端点 403 → 改密后放行
- Chromium 浏览器验证：随机密码登录后强制改密弹窗、提交新密码后恢复正常访问

## 升级说明

```bash
docker compose pull && docker compose up -d --force-recreate
```

- 生产 compose 跟随 `ghcr.io/q807738511/vaulthub:latest`，无需改文件
- 升级后首次启动若此前已设置过密码（`/data/auth.json` 存在），登录方式不变；若此前是「未设置密码的开放模式」（无 `auth.json`），升级后会生成一次性随机初始密码（见容器日志），登录后按提示改密
- 回滚：把 `image:` 改为 `ghcr.io/q807738511/vaulthub:v0.9.57` 后重建
