import { chmod, readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "smol-toml";

const sourcePath = new URL("../wrangler.toml", import.meta.url);
const outputPath = new URL("../.wrangler.production.toml", import.meta.url);

function required(name, maxLength = 2048) {
  const value = process.env[name]?.trim();
  if (!value || value.length > maxLength || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function deploymentName(name) {
  const value = required(name, 64);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a lowercase Cloudflare resource name`);
  }
  return value;
}

function appOrigin() {
  const value = required("DEPLOY_APP_ORIGIN");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || value !== url.origin) {
    throw new Error("DEPLOY_APP_ORIGIN must be an HTTPS origin without a path");
  }
  return url.origin;
}

function connectorUrl() {
  const value = required("DEPLOY_TAILNET_CONNECTOR_URL");
  const url = new URL(value);
  if (!["https:", "wss:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/v1/connect" || url.search || url.hash) {
    throw new Error("DEPLOY_TAILNET_CONNECTOR_URL must be an HTTPS/WSS URL ending in /v1/connect");
  }
  return url.toString();
}

function googleClientId() {
  const value = required("DEPLOY_GOOGLE_CLIENT_ID", 512);
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(value)) {
    throw new Error("DEPLOY_GOOGLE_CLIENT_ID must be a Google Web client ID");
  }
  return value;
}

function allowedEmails() {
  const value = required("DEPLOY_GOOGLE_ALLOWED_EMAILS", 8192);
  const emails = value.split(",").map((email) => email.trim().toLowerCase());
  if (emails.some((email) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))) {
    throw new Error("DEPLOY_GOOGLE_ALLOWED_EMAILS must contain comma-separated email addresses");
  }
  return [...new Set(emails)].join(",");
}

function databaseId() {
  const value = required("DEPLOY_D1_DATABASE_ID", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || value === "00000000-0000-0000-0000-000000000000") {
    throw new Error("DEPLOY_D1_DATABASE_ID must be a non-placeholder D1 UUID");
  }
  return value;
}

function allowedPorts() {
  const value = required("DEPLOY_ALLOWED_SSH_PORTS", 512);
  const ports = value.split(",").map((port) => port.trim());
  if (ports.some((port) => !/^\d+$/.test(port)
    || Number(port) < 1 || Number(port) > 65_535 || Number(port) === 25)) {
    throw new Error("DEPLOY_ALLOWED_SSH_PORTS contains an invalid or prohibited port");
  }
  return [...new Set(ports)].join(",");
}

const config = parse(await readFile(sourcePath, "utf8"));
const origin = appOrigin();
config.name = deploymentName("DEPLOY_WORKER_NAME");
config.vars.ALLOWED_ORIGINS = origin;
config.vars.ALLOWED_SSH_PORTS = allowedPorts();
config.vars.SSH_TRANSPORT = "tailnet_connector";
config.vars.TAILNET_CONNECTOR_URL = connectorUrl();
config.vars.GOOGLE_CLIENT_ID = googleClientId();
config.vars.GOOGLE_REDIRECT_URI = `${origin}/api/auth/google/callback`;
config.vars.GOOGLE_ALLOWED_EMAILS = allowedEmails();

const database = config.d1_databases.find((binding) => binding.binding === "DB");
if (!database) throw new Error("wrangler.toml is missing the DB binding");
database.database_name = deploymentName("DEPLOY_D1_DATABASE_NAME");
database.database_id = databaseId();

const bucket = config.r2_buckets.find((binding) => binding.binding === "FILES");
if (!bucket) throw new Error("wrangler.toml is missing the FILES binding");
bucket.bucket_name = deploymentName("DEPLOY_R2_BUCKET_NAME");

await writeFile(outputPath, stringify(config), { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log("Generated .wrangler.production.toml from validated deployment variables");
