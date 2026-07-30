# GitHub 与 Dokploy 部署

本仓库将公开源码配置与生产部署元数据分离。提交到 Git 的 `wrangler.toml` 只包含有效的示例值；GitHub Actions 使用经过校验的 GitHub Environment Variables 生成 `.wrangler.production.toml`。生成文件权限为 `0600`，已被 Git 忽略，并且不包含 Worker Secrets。

两条部署路径相互独立：

```text
GitHub main 分支 push
  -> GitHub Actions：校验、迁移 D1、部署 Web assets + Worker
  -> Dokploy webhook：构建并部署 Tailnet Connector + cloudflared
```

Web 前端会打包到 Worker 的 assets binding 中。除非修改认证和同源架构，否则不要再单独部署到 Pages。

## Cloudflare 前置条件

首次通过 GitHub 部署前，先创建：

- 生产 Worker 和 Custom Domain，或允许 Wrangler 创建 Worker。
- D1 数据库以及 `apps/worker/migrations` 下的全部 migration。
- `FILES` binding 使用的 R2 bucket。
- remotely-managed Cloudflare Tunnel；其 Public Hostname 在 Dokploy Compose 共享网络命名空间中指向 `http://127.0.0.1:8789`。
- Connector hostname 对应的 Cloudflare Access Self-hosted application，以及只允许 Service Token 的 policy。
- 生产 Google OAuth Web client，并精确注册 `${DEPLOY_APP_ORIGIN}/api/auth/google/callback`。

使用最小权限的 Cloudflare API Token，不要使用 Global API Key。它需要能够在目标账户中部署 Workers、更新 Worker Secrets 和应用 D1 migration。只有当 workflow 需要创建或修改其他 Cloudflare 资源时，才增加相应权限。

## GitHub production environment

创建名为 `production` 的 GitHub Environment。公开仓库应配置 environment protection rules，然后添加以下非敏感 Variables：

| Variable | 示例 | 用途 |
| --- | --- | --- |
| `DEPLOY_WORKER_NAME` | `edge-ssh-workbench` | Cloudflare Worker 名称 |
| `DEPLOY_APP_ORIGIN` | `https://terminal.example.com` | 精确应用 origin，不能带末尾 `/` 或路径 |
| `DEPLOY_GOOGLE_CLIENT_ID` | `...apps.googleusercontent.com` | Google OAuth Web Client ID |
| `DEPLOY_GOOGLE_ALLOWED_EMAILS` | `admin@example.com` | 逗号分隔的精确邮箱白名单 |
| `DEPLOY_D1_DATABASE_ID` | D1 UUID | 已存在的生产 D1 ID |
| `DEPLOY_D1_DATABASE_NAME` | `edge-ssh-workbench` | 已存在的生产 D1 名称 |
| `DEPLOY_R2_BUCKET_NAME` | `edge-ssh-workbench-files` | 已存在的生产 R2 bucket |
| `DEPLOY_TAILNET_CONNECTOR_URL` | `https://ssh-connector.example.com/v1/connect` | Connector WebSocket Upgrade endpoint |
| `DEPLOY_ALLOWED_SSH_PORTS` | `22,7022` | Worker 侧 SSH 端口白名单 |

添加以下 GitHub Environment Secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PASSWORD_HASH
CREDENTIAL_MASTER_KEY
SESSION_HMAC_KEY
GOOGLE_CLIENT_SECRET
TAILNET_CONNECTOR_HMAC_KEY
TAILNET_CONNECTOR_ACCESS_CLIENT_ID
TAILNET_CONNECTOR_ACCESS_CLIENT_SECRET
```

`CREDENTIAL_MASTER_KEY` 用于解密已保存凭据和 TOTP 记录，`SESSION_HMAC_KEY` 用于认证会话。正常部署时不要重新生成这两个值。`TAILNET_CONNECTOR_HMAC_KEY` 必须与 Connector 侧的 `CONNECTOR_HMAC_KEY` 相同，但必须与前两枚密钥相互独立。

## Dokploy 配置

将 Dokploy 连接到同一个 GitHub 仓库和生产分支，选择 `docker-compose.dokploy.yml`，启用 GitHub webhook 自动部署，并配置：

```dotenv
CLOUDFLARED_VERSION=<固定的 cloudflared 版本>
CLOUDFLARED_TUNNEL_TOKEN=<remotely managed Tunnel token>
CONNECTOR_HMAC_KEY=<与 Worker TAILNET_CONNECTOR_HMAC_KEY 相同>
TAILNET_ALLOWED_SUFFIX=<tailnet-name>.ts.net
TAILNET_ALLOWED_PORTS=22,7022
```

外部 Docker 网络 `dokploy-network` 必须已经存在。不要为 Connector 配置 Dokploy/Traefik domain、公开端口或 `8789` port mapping。`cloudflared` 与 Connector 共享网络命名空间，并直接访问只监听 loopback 的服务。

Dokploy 宿主机必须已经加入 Tailnet。部署后，在 Connector 容器中验证完整 MagicDNS FQDN 能够解析，并确认每个允许的 SSH 端口都可以访问。

## Workflow 行为

`.github/workflows/deploy-worker.yml` 会在 `main` 分支的相关文件变化后运行，也可以手动触发。它按顺序执行：

1. 根据 lockfile 安装依赖。
2. 对全部 workspace 执行类型检查和测试。
3. 构建 Web 前端和 Connector。
4. 严格校验 URL、UUID、邮箱、资源名和端口，生成 `.wrangler.production.toml`。
5. 使用生产配置执行 Wrangler dry-run。
6. 应用远程 D1 migration。
7. 上传指定的 Worker Secrets，并将 Worker 与 Web assets 一起部署。

一次 push 后，GitHub Actions 与 Dokploy 可能并发启动。Connector 协议变更应保持向后兼容。未来如有破坏性协议变更，应先部署兼容版本的 Connector 并确认健康，再部署 Worker。

## 推送前检查

首次公开推送前，确认候选文件中没有被忽略的本地数据：

```bash
git status --short --ignored
git add --dry-run .
npm run check
```

绝不能提交 `.dev.vars`、`.wrangler.production.toml`、`.env` 文件、Tunnel credentials、私钥、Wrangler 本地状态、数据库文件或生成的构建产物。
