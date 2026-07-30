# Google 登录部署

EdgeSSH 使用 Google OpenID Connect 作为可选的第二种登录方式。它不会创建应用用户：所有获准的 Google 身份都会绑定到唯一且已存在的 `admin` 记录，同时保留密码登录作为应急恢复入口。

## 安全模型

- 只有 `GOOGLE_ALLOWED_EMAILS` 中的地址才能完成登录。
- 系统将稳定的 Google `sub` 声明保存为身份键；邮箱仅用于授权白名单，不作为主键。
- Worker 会验证 ID token 的签名、签发者、受众、有效期、nonce 和 `email_verified` 声明。
- 只有同源 `POST` 请求才能发起授权流程；后续流程使用 `state`、与浏览器绑定的 HttpOnly Cookie 和 PKCE。登录尝试会在十分钟后过期，并以原子方式消费。
- Google 登录是另一种认证方式，不会要求输入本应用的 TOTP 验证码。启用 TOTP 后，密码登录仍需通过 TOTP 验证。
- 从白名单移除邮箱会阻止该账号后续通过 Google 登录，但不会撤销现有应用会话。如需立即登出，还应单独撤销 `auth_sessions`。

## Google Cloud Console

1. 配置 OAuth 同意屏幕；应用处于测试模式时，将管理员添加为测试用户。
2. 创建应用类型为 **Web application** 的 OAuth 客户端。
3. 添加精确的已获授权重定向 URI，不支持通配符匹配：

```text
http://localhost:8787/api/auth/google/callback
https://your-domain.example/api/auth/google/callback
```

条件允许时，本地环境和生产环境应使用不同的 Google 客户端。不要使用为原生应用或移动应用创建的 OAuth Client Secret。

## 本地开发

应用新的 D1 migration：

```bash
npm run db:migrate:local
```

在不删除现有认证和加密密钥的前提下，将以下四项加入 `.dev.vars`：

```dotenv
APP_ENV=development
GOOGLE_CLIENT_ID=your-google-oauth-web-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-web-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8787/api/auth/google/callback
GOOGLE_ALLOWED_EMAILS=admin@example.com
```

多个应急账号可用逗号分隔，但它们仍会映射到同一个应用管理员：

```dotenv
GOOGLE_ALLOWED_EMAILS=primary@example.com,recovery@example.com
```

修改 `.dev.vars` 后重启 Wrangler，并通过集成本地地址 `http://localhost:8787` 完成 OAuth 流程。当回调使用 `localhost` 时，不要打开 `127.0.0.1`：应用 origin 必须与 `GOOGLE_REDIRECT_URI` 的 origin 完全一致，浏览器才能返回仅限该主机的事务 Cookie。

## Cloudflare 部署

首先对远程 D1 数据库应用 migration：

```bash
npm run db:migrate:remote
```

在 `wrangler.toml` 的 `[vars]` 中配置非敏感绑定：

```toml
GOOGLE_CLIENT_ID = "your-google-oauth-web-client-id"
GOOGLE_REDIRECT_URI = "https://your-domain.example/api/auth/google/callback"
GOOGLE_ALLOWED_EMAILS = "admin@example.com"
```

只通过 Wrangler 上传 Client Secret，然后部署：

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

回调的 origin 和路径必须与 `GOOGLE_REDIRECT_URI` 完全一致。生产环境回调必须使用 HTTPS。

## 禁用或轮换

如需禁用 Google 登录按钮，从 `wrangler.toml` 中删除三个 `GOOGLE_*` 变量，删除 Secret，然后部署变更后的配置：

```bash
npx wrangler secret delete GOOGLE_CLIENT_SECRET
npm run deploy
```

删除 Google Secret 不会影响管理员密码、已保存的 SSH 凭据、TOTP Secret 或现有应用会话。轮换时，先在 Google Cloud Console 中生成新的 Client Secret，通过 `wrangler secret put` 上传替代值，验证登录成功后再撤销旧的 Google Secret。
