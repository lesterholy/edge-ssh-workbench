# Tailnet Connector 部署与使用

Cloudflare Workers 的 TCP Socket 不能连接私有网络地址，Worker 本身也不能加入 Tailnet。Tailnet Connector 解决这个边界：SSH 客户端和私钥仍留在 Worker 的 SSH Durable Object 中，Connector 只在 WebSocket 与 Tailnet TCP 连接之间转发 SSH transport byte stream。

```text
浏览器
  -> EdgeSSH Worker / SSH Durable Object
  -> 带 Access Service Token 和 HMAC 的 WSS
  -> Cloudflare Tunnel
  -> 127.0.0.1:8789 Tailnet Connector
  -> Tailscale IP 或完整 MagicDNS FQDN:22
  -> 目标 VPS
```

正常工作时，Connector 不接收或保存 SSH 私钥、密码和终端内容，但它能看到目标地址、端口、session UUID、SSH version banner 和加密建立前的握手元数据。SSH host key 校验用于发现中间人篡改，首次连接仍必须通过独立渠道核验指纹。它不是通用 TCP Proxy，只允许：

- `TAILNET_ALLOWED_SUFFIX` 下的完整 MagicDNS 名称
- 全部 DNS 结果都属于 Tailscale IPv4 `100.64.0.0/10` 或 IPv6 `fd7a:115c:a1e0::/48`
- `TAILNET_ALLOWED_PORTS` 中的端口，默认为 `22`

字面 IP 被明确拒绝，因为地址属于 `100.64.0.0/10` 并不能证明 Linux 会通过 `tailscale0` 路由；未分配地址可能回落到底层网络。RFC1918 Subnet Routes、短主机名、公网/混合 DNS 结果和端口 25 也会被拒绝。现有 `direct` 模式的公网 SSRF 防护没有放宽。

## 1. 配置 Tailscale ACL

推荐给 Connector 节点和允许登录的 SSH 节点使用不同 tag。下面是 Tailscale grants 示例，合并到自己的 tailnet policy 后先使用 Tailscale policy tests 验证：

```json
{
  "tagOwners": {
    "tag:webssh-connector": ["autogroup:admin"],
    "tag:ssh-target": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:webssh-connector"],
      "dst": ["tag:ssh-target"],
      "ip": ["tcp:22"]
    }
  ]
}
```

给运行 Connector 的 VPS 分配 `tag:webssh-connector`，只给允许 WebSSH 登录的 VPS 分配 `tag:ssh-target`。不要授权 Connector 访问整个 Tailnet 或任意端口。目标机的 `sshd` 仍应保留公钥认证、登录用户和主机防火墙限制。

policy 生效后，可在对应节点的 Tailscale 管理页面设置 tag，或在节点上执行：

```bash
sudo tailscale set --advertise-tags=tag:webssh-connector
# 只在允许被 WebSSH 连接的目标节点执行：
sudo tailscale set --advertise-tags=tag:ssh-target
```

在 Connector VPS 上确认 Tailscale 已连接，并能以完整 MagicDNS 名称访问目标：

```bash
tailscale status
tailscale ping vps-1.example-tailnet.ts.net
nc -vz vps-1.example-tailnet.ts.net 22
```

## 2. 安装 Connector

Connector 要求 Node.js 22。建议使用专用的无登录用户，并把打包后的单文件服务放到 `/opt`：

```bash
npm ci
npm run build:connector
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin edgesh
sudo install -d -o root -g root -m 0755 /opt/edge-ssh-tailnet-connector
sudo install -o root -g root -m 0755 apps/tailnet-connector/dist/server.cjs /opt/edge-ssh-tailnet-connector/server.cjs
sudo install -d -o root -g edgesh -m 0750 /etc/edgesh
```

生成一枚独立的 32-byte base64url HMAC key。它不能与 `SESSION_HMAC_KEY`、`CREDENTIAL_MASTER_KEY` 或 Cloudflare Access token 共用：

```bash
umask 077
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

将结果写入 `/etc/edgesh/tailnet-connector.env`，文件 owner 为 `root:edgesh`、mode 为 `0640`：

```dotenv
CONNECTOR_HMAC_KEY=<上一步生成的值>
TAILNET_ALLOWED_SUFFIX=example-tailnet.ts.net
TAILNET_ALLOWED_PORTS=22
LISTEN_HOST=127.0.0.1
PORT=8789
CONNECT_TIMEOUT_MS=10000
AUTH_WINDOW_SECONDS=30
MAX_CONNECTIONS=20
IDLE_TIMEOUT_MS=1800000
MAX_SESSION_MS=28800000
MAX_BUFFERED_BYTES=1048576
```

```bash
sudo chown root:edgesh /etc/edgesh/tailnet-connector.env
sudo chmod 0640 /etc/edgesh/tailnet-connector.env
```

`TAILNET_ALLOWED_SUFFIX` 是必填项，应使用管理控制台显示的 tailnet DNS 名，例如 `example-tailnet.ts.net`。先在 Tailscale DNS 页面启用 MagicDNS。Connector 与 Cloudflare 的系统时间必须通过 NTP 保持同步；认证只容忍最多 5 秒正向时钟偏差。

安装并启动 systemd unit：

```bash
sudo install -o root -g root -m 0644 apps/tailnet-connector/deploy/edge-ssh-tailnet-connector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now edge-ssh-tailnet-connector
curl --fail http://127.0.0.1:8789/health
```

健康响应只包含状态与连接计数，不测试目标 VPS 的 SSH 可达性。

## 3. 配置 Cloudflare Tunnel

在同一 VPS 安装 `cloudflared`，创建 Tunnel 和 DNS hostname：

```bash
cloudflared tunnel login
cloudflared tunnel create edge-ssh-tailnet
cloudflared tunnel route dns edge-ssh-tailnet ssh-connector.example.com
```

将 Tunnel credentials 安装到 systemd 服务可读的位置：

```bash
sudo install -d -o root -g root -m 0755 /etc/cloudflared
sudo install -o root -g root -m 0600 ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/<TUNNEL_UUID>.json
```

参考 `apps/tailnet-connector/deploy/cloudflared-config.yml.example`，把生成的 Tunnel UUID 和 credentials 文件路径写入 `/etc/cloudflared/config.yml`，并将外部 hostname 指向本机 HTTP 服务：

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: ssh-connector.example.com
    service: http://127.0.0.1:8789
  - service: http_status:404
```

校验并启动 Tunnel：

```bash
sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
sudo systemctl enable --now cloudflared
```

不要在安全组、云防火墙或主机防火墙中开放 `8789`，也不要让 Connector 监听公网地址。Cloudflare Tunnel 原生支持 WebSocket，不需要额外 TCP Tunnel。

如选择 Docker，可从仓库根目录构建，并在 Linux 上使用 host network 保持应用只监听宿主机 loopback；不要使用不受限制的 `-p 8789:8789`：

```bash
docker build -f apps/tailnet-connector/Dockerfile -t edge-ssh-tailnet-connector .
docker run -d --name edge-ssh-tailnet-connector --restart unless-stopped \
  --network host --read-only --cap-drop ALL \
  --env-file /etc/edgesh/tailnet-connector.env \
  edge-ssh-tailnet-connector
```

### 使用 Dokploy Compose

仓库根目录的 `docker-compose.dokploy.yml` 会同时部署 Connector 和 `cloudflared`。两个容器共享网络命名空间，因此 `cloudflared` 可以访问 Connector 的 `127.0.0.1:8789`，但该端口不会发布到宿主机或 Dokploy 网络。不要在 Dokploy 中为 Connector 添加 Traefik domain、port mapping 或 public route；`ssh-connector.example.com` 应在 Cloudflare Tunnel 的 Public Hostname 中配置，并指向：

```text
http://127.0.0.1:8789
```

在 Dokploy 项目环境变量中配置：

```dotenv
CLOUDFLARED_VERSION=<固定的 cloudflared 版本>
CLOUDFLARED_TUNNEL_TOKEN=<Cloudflare remotely-managed Tunnel token>
CONNECTOR_HMAC_KEY=<独立的 32-byte base64url key>
TAILNET_ALLOWED_SUFFIX=example-tailnet.ts.net
TAILNET_ALLOWED_PORTS=22
```

`CLOUDFLARED_TUNNEL_TOKEN` 和 `CONNECTOR_HMAC_KEY` 是 Secret，不要写入 Compose、Git 或构建参数。Connector 使用 Tailscale MagicDNS `100.100.100.100`；部署后应从 Connector 容器验证完整 MagicDNS FQDN 能解析且目标 SSH 端口可达。若宿主机防火墙阻止 Docker bridge 转发到 `tailscale0`，只允许 `dokploy-network` 到目标 Tailnet 网段和 `TAILNET_ALLOWED_PORTS` 的出站流量，不要开放入站 `8789`。

## 4. 配置 Cloudflare Access

在 Cloudflare Zero Trust 中为 `ssh-connector.example.com` 创建 Self-hosted Access application，并创建 Service Token。Access policy 只允许该 Service Token，不增加 public/bypass policy。记下 Client ID 和 Client Secret；Secret 离开页面后通常无法再次查看。

HMAC 是 Connector 自己验证的第二层认证，不能用 Access 替代。Tailscale ACL 是第三层网络授权。

## 5. 配置并部署 Worker

在 `wrangler.toml` 的 `[vars]` 中启用部署级 transport。URL 必须使用 HTTPS/WSS，且包含 Connector 的固定 Upgrade path：

```toml
SSH_TRANSPORT = "tailnet_connector"
TAILNET_CONNECTOR_URL = "https://ssh-connector.example.com/v1/connect"
ALLOWED_SSH_PORTS = "22"
```

将 Connector 中同一枚 HMAC key 和 Access Service Token 上传为 Worker secrets：

```bash
npx wrangler secret put TAILNET_CONNECTOR_HMAC_KEY --config .wrangler.production.toml
npx wrangler secret put TAILNET_CONNECTOR_ACCESS_CLIENT_ID --config .wrangler.production.toml
npx wrangler secret put TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET --config .wrangler.production.toml
npm run build:web
npx wrangler deploy --config .wrangler.production.toml
```

不要把这些真实值写进 `.dev.vars.example`、`wrangler.toml`、systemd unit 或 Git。Connector 端环境变量名是 `CONNECTOR_HMAC_KEY`，Worker 端变量名是 `TAILNET_CONNECTOR_HMAC_KEY`，两者的值必须相同。Access 是可选的代码配置，但生产部署强烈建议启用。

`ALLOWED_SSH_PORTS` 是 Worker 侧白名单，`TAILNET_ALLOWED_PORTS` 是 Connector 侧白名单；连接必须同时通过两者。修改 SSH 端口时应同步更新两处，然后先重启 Connector，再部署 Worker。

## 6. 创建和使用 SSH Profile

Web 界面的服务器 Profile 不需要新增模式字段。`SSH_TRANSPORT` 是整个 Worker deployment 的模式，启用后所有 Profile 都经 Connector 连接。

Profile 示例：

```text
名称: production-web-1
主机: web-1.example-tailnet.ts.net
端口: 22
用户: deploy
认证: 加密保存的私钥，或每次连接询问
```

主机必须填写完整 MagicDNS FQDN，不能只写 `web-1`，也不能填写 `100.x.y.z` 或字面 Tailscale IPv6。浏览器操作、首次主机密钥确认、终端、监控和 SFTP 用法与 direct 模式相同。

Connector 不会绕过目标 SSH 的认证。继续优先使用带 passphrase 的专用 SSH key；不要把本地私钥上传到 Connector VPS。保存到 EdgeSSH 的凭据仍由 Worker 使用 `CREDENTIAL_MASTER_KEY` 加密后写入 D1。

## 切换回 direct 模式

如果目标 VPS 仍有可达公网 SSH 地址，可在 `wrangler.toml` 中切回：

```toml
SSH_TRANSPORT = "direct"
```

部署后 Worker 会恢复使用 `cloudflare:sockets` 和原有公网 SSRF 校验。确认回滚成功后，可删除 Connector 专用 secrets；删除操作不可撤销，先确认 direct 模式已部署：

```bash
npx wrangler secret delete TAILNET_CONNECTOR_HMAC_KEY
npx wrangler secret delete TAILNET_CONNECTOR_ACCESS_CLIENT_ID
npx wrangler secret delete TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET
```

## 运维与排障

```bash
systemctl status edge-ssh-tailnet-connector cloudflared tailscaled
journalctl -u edge-ssh-tailnet-connector -u cloudflared --since "15 minutes ago"
curl --fail http://127.0.0.1:8789/health
tailscale ping <目标完整 MagicDNS 名称>
```

- `401 Unauthorized`：HMAC key 不一致、认证头被代理删除、nonce 重放，或两端时间不同步。
- Access 返回登录页或 `403`：Service Token、Access application hostname 或 policy 不匹配。
- `Target hostname is outside...`：Profile 没有使用完整 FQDN，或 `TAILNET_ALLOWED_SUFFIX` 不匹配。
- `Literal target IPs are disabled`：把 Profile 主机改为同一节点的完整 MagicDNS FQDN。
- `MagicDNS returned a non-Tailscale address`：DNS 结果包含非 Tailnet 地址；Connector 会整体拒绝以防 DNS rebinding。
- `Target port is not allowed`：Worker 与 Connector 的端口白名单至少有一处未更新。
- `503 Connection Limit Reached`：已达到 `MAX_CONNECTIONS`，检查是否存在异常长连接后再谨慎扩容。
- SSH host key changed：先在目标 VPS 独立核验指纹，不要直接接受未知变更。

Connector 日志不会记录认证密钥或数据内容。轮换 HMAC key 时当前版本需要短维护窗口：先停止新连接，更新 Connector 的 `CONNECTOR_HMAC_KEY` 并重启，再立刻更新 Worker secret 和部署；已有 WebSocket 会话不依赖后续 HMAC，但重启 Connector 会断开它们。Access Service Token 可用 Cloudflare 的多 token policy 做无中断轮换。
