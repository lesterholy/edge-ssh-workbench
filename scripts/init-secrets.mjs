import { pbkdf2, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../.dev.vars", import.meta.url));
const force = process.argv.includes("--force");

if (!force) {
  try {
    await access(target, constants.F_OK);
    console.error(".dev.vars already exists. Re-run with --force only when rotating local secrets.");
    process.exit(1);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const password = await readPassword();
if (password.length < 12 || password.length > 4096) {
  console.error("The administrator password must contain 12 to 4096 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const digest = await new Promise((resolve, reject) => {
  pbkdf2(password, salt, 600_000, 32, "sha256", (error, value) => {
    if (error) reject(error);
    else resolve(value);
  });
});

const values = [
  "APP_ENV=development",
  `ADMIN_PASSWORD_HASH=pbkdf2-sha256$600000$${salt.toString("base64url")}$${digest.toString("base64url")}`,
  `CREDENTIAL_MASTER_KEY=${randomBytes(32).toString("base64url")}`,
  `SESSION_HMAC_KEY=${randomBytes(32).toString("base64url")}`,
  "ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173",
  "",
].join("\n");

await writeFile(target, values, { encoding: "utf8", mode: 0o600 });
await chmod(target, 0o600);
salt.fill(0);
digest.fill(0);
console.log("Created .dev.vars with mode 0600. The administrator password was not stored.");

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
  }

  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write("Administrator password: ");
  muted = true;
  try {
    return await prompt.question("");
  } finally {
    muted = false;
    prompt.close();
    process.stdout.write("\n");
  }
}
