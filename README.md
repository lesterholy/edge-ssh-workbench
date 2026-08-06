# EdgeSSH Workbench

EdgeSSH Workbench is a WebSSH management workbench for Cloudflare Workers. The code is logically split into a React frontend and a Worker backend, while production uses one Wrangler deployment and one origin. Browsers never connect to SSH servers directly.

```text
React + xterm.js
  | HTTPS API / authenticated WebSocket
Cloudflare Worker
  |-- D1: users, profiles, settings and history
  |-- Durable Objects: login limiting, per-user session limits and isolated SSH sessions
  |-- R2: reserved for resumable large-file staging
  `-- SSH transport
      |-- direct: cloudflare:sockets -> public SSH/SFTP servers
      `-- tailnet_connector: authenticated WSS -> Tailnet Connector -> Tailscale SSH/SFTP servers
```

The frontend and backend are independently developed packages, but Wrangler serves them from one origin in production. The optional Tailnet Connector is a separate Node.js service installed on one Tailnet VPS; it forwards the SSH transport byte stream. Standard OpenSSH credentials stay in the Worker, while credentialless `tailscale_ssh` profiles rely on the Connector node's Tailnet identity and Tailscale SSH policy. See [`docs/tailnet-connector.md`](docs/tailnet-connector.md) for its trust model, deployment, Cloudflare Tunnel/Access setup, Tailscale ACL, profile usage and troubleshooting.

The detailed product and security requirements are in [`../WEBSSH_WORKBENCH_REQUIREMENTS.md`](../WEBSSH_WORKBENCH_REQUIREMENTS.md).

## Current status

The runnable vertical slice includes password and TOTP authentication with enrollment UI, optional allowlisted Google OIDC login for the single administrator, D1-backed sessions, encrypted or prompt-only OpenSSH credentials, credentialless Tailscale SSH profiles, profile/settings/history routes, login rate limiting, one-time SSH tickets, atomic per-user connection limits, direct public SSH and authenticated Tailnet Connector transports, transport-level SSH port policy, per-session Durable Objects, host-key confirmation, concurrent session tabs, selected-session batch command dispatch, a two-terminal split view, session-scoped files/history/logs, xterm, resizable workbench panels, monitoring with optional UFW status, globally serialized binary SFTP transfers with WebSocket backpressure, and basic file management. Live SSH lifecycle events, negotiated algorithms, safe connection metadata, and echo-confirmed best-effort commands are written to D1 without storing terminal output. While connected, the command-history panel can also read already-flushed entries from the remote `~/.bash_history`; obvious credential-bearing commands are filtered and the remote file is never copied into D1. UFW status is shown only when `ufw` is installed and the SSH user can read it. Shared Zod schemas validate HTTP, browser WebSocket and Connector authentication boundaries.

This is not release-ready yet. Real Cloudflare SSH compatibility, the OpenSSH algorithm matrix, Rekey, eight-hour sessions, R2 resumable transfers, large-file streaming/resume UX and 10 GB tests, a complete security center for active login sessions/key status/recent events, Durable Object WebSocket integration tests, browser E2E, and responsive visual QA remain explicit acceptance work.

## Prerequisites

- Node.js 22.12 or newer
- A Cloudflare account for remote resources and deployment
- A public test SSH server for `direct` validation, or a Tailscale node for `tailnet_connector`

No Cloudflare key or SSH credential belongs in Git. Local secrets live in `.dev.vars`; production secrets use Wrangler secret bindings.

## Local setup

```bash
npm install
npm run secrets:init
npm run db:migrate:local
npm run build
npm run dev:worker
```

Open `http://127.0.0.1:8787`. When Google login is configured with the example `http://localhost:8787` callback, open that exact origin instead; the page origin and callback origin must match. For independent frontend development, keep the Worker on port 8787 and run `npm run dev:web` in another terminal, then open `http://localhost:5173`. Vite proxies `/api` and `/ws` to Wrangler, but the integrated Worker URL should be used to test Google login.

`npm run secrets:init` prompts without echo, writes `.dev.vars` with mode `0600`, and refuses to overwrite it. Use `-- --force` only for intentional local key rotation; existing encrypted credentials become unreadable after rotating `CREDENTIAL_MASTER_KEY`.

The generated file sets `APP_ENV=development`, overriding the production default in `wrangler.toml` so local HTTP works. Keep `APP_ENV=production` in the deployed Worker configuration; do not put a production override in a checked-in secret file.

Google login is optional. It is shown only when all four `GOOGLE_*` bindings are present. See [`docs/google-oauth.md`](docs/google-oauth.md) for Google Console, local callback, allowlist and Cloudflare deployment steps. Password login remains enabled as the recovery path.

Tailscale device import is optional. Click the Tailscale status in the server sidebar to configure it, or provide `TAILSCALE_TAILNET` and the Worker secret `TAILSCALE_API_TOKEN` as deployment-level fallbacks. Browser-managed tokens are encrypted in D1 with `CREDENTIAL_MASTER_KEY` and are never returned by the configuration API. See [`docs/tailscale-import.md`](docs/tailscale-import.md) or the [Chinese guide](docs/tailscale-import_zh.md).

The checked-in production example uses `SSH_TRANSPORT=tailnet_connector`, while `.dev.vars.example` overrides local development to `direct`. Direct mode uses Cloudflare TCP sockets and accepts only public targets. To reach VPS hosts through a Tailnet, build and deploy the separate Connector with `npm run build:connector`. Do not make a local Connector listen on a public interface. The complete setup and usage sequence is in [`docs/tailnet-connector.md`](docs/tailnet-connector.md).

## Cloudflare resources

Create the remote resources and keep the returned names and identifiers for the deployment configuration:

```bash
npx wrangler d1 create edge-ssh-workbench
npx wrangler r2 bucket create edge-ssh-workbench-files
```

Do not put the returned D1 UUID, production resource names, domains or administrator email in the checked-in `wrangler.toml`. The GitHub workflow reads them from the protected `production` Environment and generates the ignored `.wrangler.production.toml`; see [`docs/github-deployment.md`](docs/github-deployment.md). It also applies D1 migrations before deployment.

Upload real secrets through the GitHub `production` Environment. For an intentional manual deployment, first generate `.wrangler.production.toml`, then target that file explicitly:

```bash
npx wrangler secret put ADMIN_PASSWORD_HASH --config .wrangler.production.toml
npx wrangler secret put CREDENTIAL_MASTER_KEY --config .wrangler.production.toml
npx wrangler secret put SESSION_HMAC_KEY --config .wrangler.production.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET --config .wrangler.production.toml
npx wrangler secret put TAILSCALE_API_TOKEN --config .wrangler.production.toml
```

The required formats are shown in `.dev.vars.example`. `CREDENTIAL_MASTER_KEY` and `SESSION_HMAC_KEY` are independent base64url-encoded 32-byte values. Omit `GOOGLE_CLIENT_SECRET` when Google login is not enabled.

For Tailnet mode, `TAILNET_CONNECTOR_HMAC_KEY` must be a third independent 32-byte key. The optional Cloudflare Access Client ID/Secret are also Wrangler secrets. Do not bulk-upload `.dev.vars` to production because it contains `APP_ENV=development` and local origins; upload only the named secrets and keep non-secret production values in protected GitHub Environment Variables.

### GitHub and Dokploy automation

The checked-in `wrangler.toml` contains public example values only. `.github/workflows/deploy-worker.yml` generates an ignored production config from validated GitHub Environment Variables, applies remote D1 migrations, and deploys the Web assets and Worker together. Use one Worker deployment pipeline at a time; disable Cloudflare native Git Builds when this GitHub workflow owns production deployment. Connector deployment remains independent in Dokploy through `docker-compose.dokploy.yml`. Configure both systems before enabling automatic deployment; see [`docs/github-deployment.md`](docs/github-deployment.md) or the [Chinese guide](docs/github-deployment_zh.md).

## Validation

```bash
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run --outdir .wrangler/build
```

`npm run check` runs those checks as one command. A dry-run does not create or mutate Cloudflare resources.

## Repository layout

```text
apps/web/               React, xterm.js and browser API/WS clients
apps/worker/            Worker routes, security, storage, SSH and Durable Objects
apps/tailnet-connector/  Locked-down WSS-to-Tailnet TCP relay and deployment assets
packages/contracts/     Shared public Zod schemas and protocol types
scripts/                Local bootstrap utilities
docs/                   Architecture and provenance records
```

The frontend may import `@edgesh/contracts`, but must not import Worker storage or SSH implementation modules. The Worker must not depend on React or browser state.
