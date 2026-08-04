# GitHub and Dokploy deployment

The repository separates public source configuration from production deployment metadata. The checked-in `wrangler.toml` contains valid example values, while GitHub Actions generates `.wrangler.production.toml` from validated GitHub Environment Variables. The generated file is mode `0600`, ignored by Git, and contains no Worker secrets.

The deployment paths are intentionally separate:

```text
GitHub main push
  -> GitHub Actions: validate, migrate D1, deploy Web assets + Worker
  -> Dokploy webhook: build and deploy Tailnet Connector + cloudflared
```

The Web frontend is bundled into the Worker assets binding. Do not deploy it separately to Pages unless the authentication and same-origin design is changed.

## Cloudflare prerequisites

Create these resources before the first GitHub deployment:

- The production Worker and custom domain, or permission for Wrangler to create the Worker.
- The D1 database and all migrations under `apps/worker/migrations`.
- The R2 bucket used by the `FILES` binding.
- The remotely managed Cloudflare Tunnel and its Public Hostname, routed to `http://127.0.0.1:8789` inside the Dokploy Compose network namespace.
- A Cloudflare Access Self-hosted application for the Connector hostname and a Service Token-only policy.
- Optional: a production Google OAuth Web client with `${DEPLOY_APP_ORIGIN}/api/auth/google/callback` registered exactly.

Use a scoped Cloudflare API token rather than the Global API Key. It must be able to deploy Workers, update Worker secrets, and apply D1 migrations in the target account. Add further permissions only when the workflow is expected to create or modify other Cloudflare resources.

## GitHub production environment

Create a GitHub Environment named `production`. Add environment protection rules for a public repository, then configure these non-secret Variables:

| Variable | Example | Purpose |
| --- | --- | --- |
| `DEPLOY_WORKER_NAME` | `edge-ssh-workbench` | Cloudflare Worker name |
| `DEPLOY_APP_ORIGIN` | `https://terminal.example.com` | Exact application origin; no trailing slash or path |
| `DEPLOY_GOOGLE_CLIENT_ID` (optional) | `...apps.googleusercontent.com` | Google OAuth Web client ID; configure with the email allowlist and client secret |
| `DEPLOY_GOOGLE_ALLOWED_EMAILS` (optional) | `admin@example.com` | Exact comma-separated allowlist; configure with the Google client ID and secret |
| `DEPLOY_D1_DATABASE_ID` | D1 UUID | Existing production D1 identifier |
| `DEPLOY_D1_DATABASE_NAME` | `edge-ssh-workbench` | Existing production D1 name |
| `DEPLOY_R2_BUCKET_NAME` | `edge-ssh-workbench-files` | Existing production R2 bucket |
| `DEPLOY_TAILNET_CONNECTOR_URL` | `https://ssh-connector.example.com/v1/connect` | Connector WebSocket Upgrade endpoint |
| `DEPLOY_ALLOWED_SSH_PORTS` | `22,7022` | Worker-side SSH port allowlist |
| `DEPLOY_TAILSCALE_TAILNET` (optional) | `example.com` | Tailnet organization/name used for device discovery; requires the API token secret |

Add these GitHub Environment Secrets:

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
TAILSCALE_API_TOKEN
```

`CREDENTIAL_MASTER_KEY` decrypts saved credentials and TOTP records. `SESSION_HMAC_KEY` authenticates sessions. Do not regenerate either value during a normal deployment. `TAILNET_CONNECTOR_HMAC_KEY` must equal the Connector-side `CONNECTOR_HMAC_KEY`, but it must remain distinct from the other two keys.
`GOOGLE_CLIENT_SECRET`, the two Cloudflare Access values, and `TAILSCALE_API_TOKEN` are optional; configure each only with its matching variables. The workflow uploads only non-empty optional secrets.

## Dokploy configuration

Connect Dokploy to the same GitHub repository and production branch, then select `docker-compose.dokploy.yml`. Enable automatic deployment from the GitHub webhook and configure:

```dotenv
CLOUDFLARED_VERSION=<pinned cloudflared version>
CLOUDFLARED_TUNNEL_TOKEN=<remotely managed Tunnel token>
CONNECTOR_HMAC_KEY=<same value as Worker TAILNET_CONNECTOR_HMAC_KEY>
TAILNET_ALLOWED_SUFFIX=<tailnet-name>.ts.net
TAILNET_ALLOWED_PORTS=22,7022
```

The external Docker network `dokploy-network` must already exist. Do not configure a Dokploy/Traefik domain, public port, or `8789` port mapping for the Connector. `cloudflared` shares the Connector network namespace and reaches its loopback listener directly.

The Dokploy host must already be a Tailnet node. After deployment, verify from the Connector container that a complete MagicDNS FQDN resolves and that each allowed SSH port is reachable.

## Workflow behavior

`.github/workflows/deploy-worker.yml` runs on relevant changes to `main` and can also be started manually. It performs these steps in order:

1. Install dependencies with the lockfile.
2. Typecheck all workspaces and run all tests.
3. Build the Web frontend and Connector.
4. Generate `.wrangler.production.toml` with strict URL, UUID, email, resource-name and port validation.
5. Run a production-configured Wrangler dry-run.
6. Apply remote D1 migrations.
7. Upload the named Worker secrets and deploy the Worker with its Web assets.

GitHub Actions and Dokploy may start concurrently after a push. Keep Connector protocol changes backward-compatible. For a future breaking protocol change, deploy a compatible Connector first, verify its health, and only then deploy the Worker.

## Pre-push check

Before the first public push, confirm that ignored local data is absent from the candidate set:

```bash
git status --short --ignored
git add --dry-run .
npm run check
```

Never commit `.dev.vars`, `.wrangler.production.toml`, `.env` files, Tunnel credentials, private keys, local Wrangler state, database files, or generated build output.
