# 从 Tailscale 导入设备

EdgeSSH 可以读取 Tailscale 设备清单并批量创建 SSH Profile。设备发现由 Worker 执行：配置 API 不会回传 Tailscale API Token，Token 也不会发送给 Tailnet Connector。在工作台中输入的 Token 会使用 `CREDENTIAL_MASTER_KEY` 加密后写入 D1。

## 前置条件

- Worker 使用 `SSH_TRANSPORT=tailnet_connector`。
- Connector 所在主机已经加入 Tailnet，并且 `TAILNET_ALLOWED_SUFFIX` 与导入设备的 MagicDNS 后缀一致。
- 每台待导入设备都具有完整的 `*.ts.net` MagicDNS 名称。系统刻意不导入 Tailnet IP 或短主机名。
- 选择 `tailscale_ssh` 认证时，目标设备已经启用 Tailscale SSH。否则选择密码/私钥的“连接时询问”模式，在连接时提供凭据。

## 配置 Tailscale

在 **Tailscale Admin Console -> Settings -> Keys** 创建 API access token。Tailscale API Token 最长 90 天过期，需要设置轮换提醒；替换后及时撤销旧 Token。

登录工作台后，点击服务器侧边栏中的 Tailscale 状态，填写 Tailnet 名称和 API Token 后保存。受认证保护的配置接口只接收 Token，不回传 Token；Worker 使用 AES-GCM 加密后写入 D1，响应只说明是否已配置。此方式要求有效的 `CREDENTIAL_MASTER_KEY`。

部署绑定仍可作为回退配置。本地开发时，将以下内容追加到现有且被 Git 忽略的 `.dev.vars`：

```dotenv
TAILSCALE_TAILNET=example.com
TAILSCALE_API_TOKEN=tskey-api-REPLACE_ME
```

`TAILSCALE_TAILNET` 是 Tailscale API 接受的 Tailnet 组织名/名称，不是 `TAILNET_ALLOWED_SUFFIX` 中的 `*.ts.net` DNS 后缀，两者可能不同。网页保存的配置优先于这些绑定。

通过 GitHub 部署时，在 `production` Environment 中添加 Variable `DEPLOY_TAILSCALE_TAILNET` 和 Secret `TAILSCALE_API_TOKEN`。Workflow 只把 Tailnet 名称写入 Wrangler 配置，并将 Token 作为 Worker Secret 上传。

手动部署时执行：

```bash
npx wrangler secret put TAILSCALE_API_TOKEN --config .wrangler.production.toml
```

## 导入行为

打开 **服务器 -> 从 Tailscale 导入**，刷新设备列表，最多选择 50 台已授权设备，然后设置统一的 SSH 用户名、端口和认证方式。

- 设备列表会分别显示管理员设置的 Tailscale 机器名称和操作系统主机名。导入后的 Profile 使用 Tailscale 名称作为显示名称，并保留完整 MagicDNS 名称作为连接目标。
- `tailscale_ssh` 固定使用 22 端口，并且不保存 SSH 凭据。
- 密码和私钥导入使用“连接时询问”，不会把同一份 Secret 批量复制到所有 Profile。
- 已存在相同标准化 host、port 和 username 的 Profile 会被跳过。
- 未授权设备，以及从预览到提交期间丢失 MagicDNS 名称的设备会被跳过。
- 在线状态是尽力判断：优先使用 API 的在线/控制连接字段，否则把五分钟内出现过的 `lastSeen` 视为在线。

导入后的 Profile 仍会被 Tailnet Connector 再次解析并执行限制。设备发现不会绕过 Connector 的 MagicDNS 后缀或 SSH 端口白名单。
