# VaultHub 蜀鼠之家 v0.5.0：离线升级版

本版本为正式版前离线迭代包，解压后可直接 Compose 构建，不访问 Docker Hub。

## 变更

- 项目名称改为 `VaultHub 蜀鼠之家`。
- Compose 服务名改为 `vaulthub`，容器名改为 `VaultHub`，镜像名改为 `vaulthub:0.5.0-local`。
- 左上角页面名改为 `蜀鼠之家`，图标改为动画中华鼠图标。
- 电子书和漫画合并为 `超漫画`，统一包含 Komga / Kavita / Calibre-Web。
- 新增 WebUI 的 `Caddy 配置` 页面，可读取、保存并热加载容器内 Caddyfile。
- YAML 只保留首次启动预配置；实际 Caddyfile 持久化到 `./data/Caddyfile`。
- 保留 v0.4.2 的 Komga 路由修复和媒体公网自动映射。

## 首次配置

`.env` 示例：

```env
WEBUI_PORT=8088
NAS_IP=192.168.112.3
DASHBOARD_ORIGIN=https://home.enged.top
ADMIN_TOKEN=
```

`ADMIN_TOKEN` 留空表示 Caddy 配置页面不鉴权。公网环境建议填写一串长随机密码，WebUI 保存配置时在弹窗中输入同一个令牌。

## 公网接入方案

VaultHub 支持两种公网接入方式：

1. **Cloudflare Tunnel（推荐）**：无需公网 IP，也无需路由器开放 80/443。
2. **传统反向代理**：公网 DNS + 路由器端口转发 + Lucky/NPM；需要可用公网 IP。

两种方式的核心规则相同：`home`、`kom`、`yy` 三个域名都必须先进入 VaultHub 的 `8088`，再由容器内 Caddy 按 Host 分流。不要把 `kom` 直接代理到 `25600`，也不要把 `yy` 直接代理到 `4533`，否则会绕过 Caddy 的 iframe 响应头处理。

### 方案一：Cloudflare Tunnel

在 Cloudflare Zero Trust → Networks → Tunnels → Public Hostnames 添加：

```text
home.enged.top  -> HTTP -> 192.168.112.3:8088   # VaultHub 主页
kom.enged.top   -> HTTP -> 192.168.112.3:8088   # Caddy 再转 Komga :25600
yy.enged.top    -> HTTP -> 192.168.112.3:8088   # Caddy 再转 Navidrome :4533
```

Cloudflare 提供公网 HTTPS，Tunnel 到 NAS 使用内网 HTTP。三条记录应属于同一个在线 Tunnel，DNS CNAME 应指向同一个 `<tunnel-id>.cfargotunnel.com`。

验证：

```bash
curl -I https://home.enged.top/
curl -I https://kom.enged.top/
curl -I https://yy.enged.top/app/
curl -sI https://kom.enged.top/ | grep -i content-security-policy
```

最后一条应包含 `frame-ancestors https://home.enged.top`。若返回 522，先检查该域名的 Public Hostname 是否指向 `192.168.112.3:8088`，再确认 DNS 没有指向旧 Tunnel。

### 方案二：公网 DNS + Lucky/NPM 传统反向代理

适合不使用 Tunnel、家里有公网 IPv4，或已正确配置 IPv6 入站访问的环境。IPv4 处于运营商 CGNAT 时不能使用此方案，除非先申请公网 IP。

访问链路：

```text
浏览器 HTTPS :443
  -> 公网 DNS（home/kom/yy 指向家庭公网 IP）
  -> 路由器 TCP 443 端口转发
  -> Lucky 或 Nginx Proxy Manager
  -> http://192.168.112.3:8088
  -> VaultHub 内置 Caddy 按 Host 分流
```

#### 1. DNS 解析

在域名 DNS 服务商添加三条记录：

```text
A     home  -> 家庭公网 IPv4
A     kom   -> 家庭公网 IPv4
A     yy    -> 家庭公网 IPv4
```

若公网 IP 会变化，先在 Lucky/路由器配置 DDNS。使用 IPv6 时创建 AAAA 记录，并确认 NAS、代理和防火墙都允许 IPv6 443 入站。若 DNS 托管在 Cloudflare，传统源站模式可使用橙云代理，但它不等于 Tunnel，源站仍需开放 443。

#### 2. 路由器端口转发

```text
公网 TCP 443 -> Lucky/NPM 所在主机的 TCP 443
公网 TCP 80  -> Lucky/NPM 所在主机的 TCP 80（证书 HTTP 验证或跳转，可选）
```

不要把公网端口转发到 VaultHub 管理 API，也不要开放 `9099`。若运营商封锁 80，可使用 DNS Challenge 申请证书；443 仍需公网可达。

#### 3. Lucky 配置

创建 HTTPS Web 服务监听（通常为 443），申请 `home.enged.top`、`kom.enged.top`、`yy.enged.top` 证书，并建立三个按主机名匹配的子规则：

```text
前端域名 home.enged.top -> 后端 http://192.168.112.3:8088
前端域名 kom.enged.top  -> 后端 http://192.168.112.3:8088
前端域名 yy.enged.top   -> 后端 http://192.168.112.3:8088
```

启用 WebSocket，保留原始 `Host` 请求头，并设置 `X-Forwarded-Proto: https`。不要使用 Lucky 管理端口 `16601` 作为反代入口。

#### 4. Nginx Proxy Manager 配置

分别新建三个 Proxy Host：

```text
Domain Names: home.enged.top / kom.enged.top / yy.enged.top
Scheme:       http
Forward Host: 192.168.112.3
Forward Port: 8088
Websockets:   开启
SSL:          为每个域名申请证书，开启 Force SSL
```

NPM 默认会转发原始 Host；不要在 Advanced 中覆盖成 `Host 192.168.112.3`。三个域名虽然共用同一个目标端口，但 Caddy 会根据原始 Host 分别返回 VaultHub、Komga 和 Navidrome。

#### 5. 安全与验证

- 路由器只开放反向代理的 80/443，不开放 `8088`、`4533`、`25600`、`61208` 或 `9099`。
- 建议在 `home.enged.top` 前增加认证；VaultHub 的 `ADMIN_TOKEN` 必须设置长随机值。
- `DASHBOARD_ORIGIN` 必须保持 `https://home.enged.top`。

```bash
curl -I https://home.enged.top/
curl -I https://kom.enged.top/
curl -I https://yy.enged.top/app/
curl -sI https://kom.enged.top/ | grep -i content-security-policy
```

### 两种方案对比

| 项目 | Cloudflare Tunnel | 传统反向代理 |
|---|---|---|
| 公网 IP | 不需要 | 需要公网 IPv4 或可入站 IPv6 |
| 路由器开放端口 | 不需要 | 需要转发 443，通常还需 80 |
| HTTPS 证书 | Cloudflare 托管 | Lucky/NPM 自行申请和续期 |
| 源站 IP 暴露 | 不暴露 | 通常会暴露 |
| 故障点 | cloudflared、Tunnel DNS | DDNS、端口转发、证书、防火墙 |
| VaultHub/Caddy 配置 | 相同 | 相同 |

当前环境已使用 Tunnel，继续使用方案一最省事。方案二适合作为不依赖 cloudflared 的备用接入方式，两种方案不建议让同一域名同时生效，以免 DNS 流量指向不一致。

## 构建验证

```bash
docker compose ps
curl http://127.0.0.1:8088/healthz
curl http://127.0.0.1:8088/api/admin/caddyfile
curl -H "Host: kom.enged.top" http://127.0.0.1:8088/api/v1/libraries
```

`/api/v1/libraries` 未登录时返回 Komga 认证错误是正常的；不应返回 `<title>VaultHub` 或 WebUI HTML。
