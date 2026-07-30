# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EdgeSSH Workbench: a WebSSH management workbench that runs on Cloudflare Workers. Browsers talk HTTPS + authenticated WebSocket to one Worker origin; the Worker holds the SSH client and private keys and opens the actual SSH/SFTP connection. Browsers never touch SSH servers directly. Not yet release-ready — see the "Current status" section of README.md for the explicit acceptance gaps.

## Commands

All run from the repo root unless noted. npm workspaces: `@edgesh/contracts`, `@edgesh/worker`, `@edgesh/web`, `@edgesh/tailnet-connector`.

```bash
npm install                 # install all workspaces
npm run secrets:init        # generate .dev.vars (mode 0600); refuses to overwrite
npm run db:migrate:local    # apply D1 migrations to local SQLite
npm run build               # build web + connector (Worker bundles at deploy)
npm run dev:worker          # wrangler dev on http://127.0.0.1:8787 (serves built web assets)
npm run dev:web             # standalone Vite on :5173, proxies /api and /ws to :8787

npm run typecheck           # tsc --noEmit across all four workspaces
npm test                    # vitest run (whole repo)
npx vitest run apps/worker/src/ssh/ssh2-engine.ts   # single file
npx vitest run -t "rejects private targets"          # single test by name
npm run build               # build:web + build:connector
npm run check               # typecheck + test + build + wrangler deploy --dry-run (full CI gate)
npm run deploy              # build:web + wrangler deploy
```

Run the full app locally: `secrets:init` → `db:migrate:local` → `build` → `dev:worker`, then open `http://127.0.0.1:8787`. There is no separate lint config; `typecheck` is the static gate.

## High-level architecture

Four packages, strict dependency direction. `packages/contracts` (Zod schemas + protocol types, the only shared code) is imported by all three apps. **The web frontend must not import Worker storage/SSH modules; the Worker must not depend on React or browser state.** This boundary is the main architectural invariant — keep it.

```
apps/web (React + xterm.js)
  |  HTTPS /api/*  +  WSS /ws/ssh        (validated against @edgesh/contracts Zod schemas)
apps/worker (Cloudflare Worker)
  |-- D1  (users, profiles, settings, history, known_hosts, security_events)
  |-- Durable Objects  (per-session SSH, session registry, auth rate limiter)
  |-- R2  (reserved for resumable large-file staging; not yet implemented)
  `-- SSH transport (pluggable, see below)
```

### Request flow (apps/worker/src)

`index.ts` → `http/router.ts` is the single entry. `routeRequest` enforces TLS redirect, CORS/origin checks, security headers, and dispatches:
- `/api/*` → `http/{auth,settings,profiles,history,ssh}.ts` route handlers. All JSON in/out is parsed with a contract Zod schema.
- `/ws/ssh` → `http/ssh.ts` `upgradeSsh`, which forwards the WebSocket upgrade into the per-session `SSHSessionDO`.

Layers by folder:
- `http/` — thin route handlers: parse input with contracts, call storage/auth, return `apiJson`/`HttpError`. No business logic lives here.
- `auth/` — password (PBKDF2), TOTP, optional Google OIDC, session tokens. `http/auth.ts` `requireAuthentication` is the guard every protected route calls.
- `security/` — credential encryption envelope (`envelope.ts`, AES via `CREDENTIAL_MASTER_KEY`), HTTP/origin/CORS headers, network target validation, one-time SSH tickets.
- `storage/` — D1 repositories, one class per table. `storage/index.ts` `createRepositories(env)` builds them all. Secrets columns (`*_ciphertext`/`*_iv`) are encrypted with `CREDENTIAL_MASTER_KEY`.
- `ssh/` — the SSH engine and transport abstraction (see below).
- `durable/` — Durable Objects (see below).

### SSH engine & pluggable transport

`ssh/types.ts` defines the core interfaces. `SSHEngine` (implemented by `ssh/ssh2-engine.ts` wrapping the `ssh2` npm package) owns one SSH connection: shell I/O, SFTP, metrics, host-key verification. The engine is transport-agnostic — it drives an `SSHTransport` (a `NodeJS.ReadWriteStream`) produced by an `SSHTransportFactory`.

`ssh/transport-factory.ts` selects the transport from `SSH_TRANSPORT` env (`env.ts` `getRuntimeConfig`):
- `direct` (default): `cloudflare-transport.ts` uses `cloudflare:sockets` TCP. Public targets only — `ssh/network.ts` rejects private/reserved IPs (SSRF guard).
- `tailnet_connector`: `tailnet-connector-transport.ts` opens an authenticated WSS to the separate Connector service.

`env.ts` is the single source of truth for env parsing/validation; `getRuntimeConfig(env)` throws on bad config. Add new env vars there and to the `Env` interface.

### Durable Objects (apps/worker/src/durable)

Three DO classes, exported from `index.ts` and bound in `wrangler.toml`:
- `SSHSessionDO` — one instance per SSH session (id = `sessionId` UUID). Holds the live `SSHEngine`, the WebSocket to the browser, the one-time ticket, command capture, metrics timer, and lease renewal. This is where the browser WebSocket actually terminates and where SSH bytes flow.
- `SSHSessionRegistryDO` — enforces the atomic per-user concurrent-session limit (`MAX_SESSIONS_PER_USER`).
- `AuthRateLimiterDO` — login rate limiting.

The browser connects with a one-time ticket: `POST /api/ssh/tickets` (`http/ssh.ts createSshTicket`) stores an encrypted ticket in the DO, returns `{ticket, sessionId}`. The browser then opens `/ws/ssh?session=…&ticket=…&protocolVersion=…`, and `upgradeSsh` forwards the upgrade to the same DO which redeems the ticket. Tickets are single-use and short-lived (60s).

### Tailnet Connector (apps/tailnet-connector)

A standalone Node.js 22 service for reaching Tailscale-only hosts (Workers can't join a Tailnet and `cloudflare:sockets` can't reach private IPs). It is a **locked-down byte relay only**: it forwards the SSH transport byte stream between a WSS and a Tailnet TCP connection. SSH keys, credentials, and auth stay in the Worker. It never sees plaintext SSH content.

Three layers of defense: Cloudflare Access service token (optional), then the Connector's own HMAC auth (`auth.ts`, with nonce replay cache), then Tailscale ACL. Target allowlisting (`targets.ts`) only permits full MagicDNS FQDNs under `TAILNET_ALLOWED_SUFFIX` resolving to Tailscale CGNAT ranges, on `TAILNET_ALLOWED_PORTS`; literal IPs and port 25 are refused. Build with `npm run build:connector` (esbuild → single CJS file). Full trust model and deployment in `docs/tailnet-connector.md`.

## Conventions & constraints

- **Contracts first.** Any new HTTP/WS field or message is defined as a Zod schema in `packages/contracts/src/*` and parsed at both ends. Worker handlers parse request bodies with `parseJson(request, SomeSchema)`; responses are built with `apiJson(Schema.parse(...))`. Don't hand-construct payloads that bypass the schemas.
- **WebSocket protocol** is versioned (`WS_PROTOCOL_VERSION` in contracts) and split into JSON control messages and binary transfer frames (`binary-frame.ts` on the web side, `BinaryFrameHeaderSchema` in contracts). SFTP upload/download uses binary frames; terminal output and control use JSON.
- **Tests** are colocated `*.test.ts` next to source, run by Vitest. `vitest.config.ts` aliases `cloudflare:sockets` to `apps/worker/shims/cloudflare-sockets-test.ts` so Worker SSH code is testable outside Workers. The `ssh2` package needs the `cpu-features` shim (`apps/worker/shims/`) and the `sshcrypto.node` alias in `wrangler.toml` to run in the Workers runtime — don't remove these.
- **Migrations** are plain SQL in `apps/worker/migrations/`, applied with `wrangler d1 migrations apply edge-ssh-workbench --local|--remote`. DO SQLite-class migrations are declared in `wrangler.toml` `[[migrations]]`.

## Security rules (do not violate)

- No secrets in Git. Local secrets in `.dev.vars` (gitignored, generated by `secrets:init`); production secrets via `wrangler secret put`. `wrangler.toml` holds only non-secret vars.
- `CREDENTIAL_MASTER_KEY`, `SESSION_HMAC_KEY`, and `TAILNET_CONNECTOR_HMAC_KEY` are three **independent** base64url 32-byte keys. Never reuse one for another's purpose. Rotating `CREDENTIAL_MASTER_KEY` makes stored encrypted credentials unreadable.
- Keep `APP_ENV=production` in deployed config; `.dev.vars` sets `APP_ENV=development` for local HTTP. Don't commit a production override.
- SSRF/target validation is defense-in-depth and exists on both Worker (`ssh/network.ts`, `env.ts` `ALLOWED_SSH_PORTS`) and Connector (`targets.ts`, `TAILNET_ALLOWED_PORTS`). A connection must pass both port allowlists. Don't weaken these to make a test pass.
- Terminal output is never written to D1; only lifecycle events, negotiated algorithms, safe connection metadata, and echo-confirmed commands are persisted.

## Notes

- Node.js >= 22.12 required.
- Docs are bilingual: most `docs/*.md` have a `_zh.md` counterpart (the `_zh` version is sometimes the primary/most-detailed).
- `docs/provenance.md` records which reference repos influenced the design and the license obligations — update it if you adapt code from an upstream reference.
