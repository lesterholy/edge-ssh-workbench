# Importing Tailscale devices

EdgeSSH can read the Tailscale device inventory and create SSH profiles in bulk. Discovery runs in the Worker: the Tailscale API token is never returned to the browser, stored in D1, or sent to the Tailnet Connector.

## Prerequisites

- The Worker uses `SSH_TRANSPORT=tailnet_connector`.
- The Connector host is a Tailnet node and its `TAILNET_ALLOWED_SUFFIX` matches the imported MagicDNS suffix.
- Each imported device has a full `*.ts.net` MagicDNS name. Literal Tailnet IPs and short hostnames are deliberately not imported.
- Tailscale SSH is enabled on targets selected with the `tailscale_ssh` authentication mode. Otherwise select password/private-key prompt mode and provide the credential when connecting.

## Tailscale configuration

Create an API access token in **Tailscale Admin Console -> Settings -> Keys**. Tailscale API access tokens expire after at most 90 days, so set a rotation reminder and revoke the old token after replacement.

For local development, append these values to the existing ignored `.dev.vars`:

```dotenv
TAILSCALE_TAILNET=example.com
TAILSCALE_API_TOKEN=tskey-api-REPLACE_ME
```

`TAILSCALE_TAILNET` is the tailnet organization/name accepted by the Tailscale API. It is not the `*.ts.net` DNS suffix in `TAILNET_ALLOWED_SUFFIX`; the two values can differ.

For GitHub deployment, add `DEPLOY_TAILSCALE_TAILNET` as a `production` Environment Variable and `TAILSCALE_API_TOKEN` as a `production` Environment Secret. The workflow writes only the tailnet name into the generated Wrangler config and uploads the token as a Worker secret.

For a manual deployment:

```bash
npx wrangler secret put TAILSCALE_API_TOKEN --config .wrangler.production.toml
```

## Import behavior

Open **Servers -> Import from Tailscale**, refresh the inventory, select up to 50 authorized devices, and choose the common SSH username, port, and authentication mode.

- `tailscale_ssh` always uses port 22 and stores no SSH credential.
- Password and private-key imports use prompt-only credentials; no shared secret is copied across the imported profiles.
- Existing profiles with the same normalized host, port, and username are skipped.
- Unauthorized devices and devices that lose their MagicDNS name between discovery and import are skipped.
- Device online state is best-effort: the API's explicit online/control state is preferred, otherwise a `lastSeen` value within five minutes is treated as online.

The imported Profile target is resolved and restricted again by the Tailnet Connector. Device discovery does not bypass the Connector's MagicDNS suffix or SSH port allowlists.
