import type { ProfileCreateRequest, ProfileUpdateRequest } from "@edgesh/contracts";

import { decryptSecret, encryptSecret, type EncryptedEnvelope, type SecretField } from "../security/envelope";
import { assertAllowedSshPort, normalizeHost } from "../security/network";
import { asBoolean, assertOwnerId, assertRecordId, createId, nowIso, toInteger } from "./internal";

export type ProfileAuthKind = "password" | "private_key" | "tailscale_ssh";
export type CredentialPersistence = "saved" | "prompt" | "none";
type StoredProfileAuthKind = Exclude<ProfileAuthKind, "tailscale_ssh">;
type StoredCredentialPersistence = Exclude<CredentialPersistence, "none">;
export type TerminalEncoding = "utf-8" | "gb18030" | "big5";
export type TerminalType = "xterm-256color" | "xterm" | "screen-256color";

export interface ProfileView {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: ProfileAuthKind;
  authenticationMethod: ProfileAuthKind;
  credentialPersistence: CredentialPersistence;
  notes: string;
  initialCommand: string | null;
  terminalType: TerminalType;
  encoding: TerminalEncoding;
  collectHistory: boolean;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  lastConnectedAt: string | null;
  lastConnectedUsername: string | null;
  lastSuccessfulUsername: string | null;
  lastHostFingerprint: string | null;
  lastHostKeyFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileCredentials {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface CreateProfileInput {
  id?: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  authKind: ProfileAuthKind;
  credentialPersistence?: CredentialPersistence;
  notes?: string;
  initialCommand?: string | null;
  terminalType?: TerminalType;
  encoding?: TerminalEncoding;
  collectHistory?: boolean;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface UpdateProfileInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  authKind?: ProfileAuthKind;
  credentialPersistence?: CredentialPersistence;
  notes?: string;
  initialCommand?: string | null;
  terminalType?: TerminalType;
  encoding?: TerminalEncoding;
  collectHistory?: boolean;
  // undefined or an empty string preserves an existing secret; null explicitly deletes it.
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
}

interface ProfileRow {
  id: string;
  owner_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_kind: StoredProfileAuthKind;
  tailscale_ssh: number;
  credential_persistence: StoredCredentialPersistence;
  notes: string;
  initial_command: string | null;
  terminal_type: TerminalType;
  encoding: TerminalEncoding;
  collect_history: number;
  password_ciphertext: string | null;
  password_iv: string | null;
  password_version: number | null;
  private_key_ciphertext: string | null;
  private_key_iv: string | null;
  private_key_version: number | null;
  passphrase_ciphertext: string | null;
  passphrase_iv: string | null;
  passphrase_version: number | null;
  last_connected_at: string | null;
  last_connected_username: string | null;
  last_host_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

function validateText(value: string, field: string, max: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid profile ${field}`);
  }
  return normalized;
}

function validateEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid profile ${field}`);
  return value as T;
}

function profileAuthKind(row: ProfileRow): ProfileAuthKind {
  return row.tailscale_ssh === 1 ? "tailscale_ssh" : row.auth_kind;
}

function toView(row: ProfileRow): ProfileView {
  const authKind = profileAuthKind(row);
  const view = {
    id: row.id, name: row.name, host: row.host, port: row.port, username: row.username,
    authenticationMethod: authKind,
    credentialPersistence: authKind === "tailscale_ssh" ? "none" as const : row.credential_persistence,
    notes: row.notes, initialCommand: row.initial_command, terminalType: row.terminal_type,
    encoding: row.encoding, hasPassword: row.password_ciphertext !== null,
    hasPrivateKey: row.private_key_ciphertext !== null, hasPassphrase: row.passphrase_ciphertext !== null,
    lastConnectedAt: row.last_connected_at,
    lastSuccessfulUsername: row.last_connected_username,
    lastHostKeyFingerprint: row.last_host_fingerprint, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  // Transitional non-enumerable aliases keep internal callers source-compatible without leaking extra API fields.
  Object.defineProperties(view, {
    authKind: { value: authKind, enumerable: false },
    collectHistory: { value: asBoolean(row.collect_history), enumerable: false },
    lastConnectedUsername: { value: row.last_connected_username, enumerable: false },
    lastHostFingerprint: { value: row.last_host_fingerprint, enumerable: false },
  });
  return view as ProfileView;
}

function fieldEnvelope(row: ProfileRow, field: Exclude<SecretField, "totp" | "pendingTotp">): EncryptedEnvelope | null {
  const prefix = field === "privateKey" ? "private_key" : field;
  const ciphertext = row[`${prefix}_ciphertext` as keyof ProfileRow];
  const iv = row[`${prefix}_iv` as keyof ProfileRow];
  const version = row[`${prefix}_version` as keyof ProfileRow];
  return typeof ciphertext === "string" && typeof iv === "string" && version === 1 ? { ciphertext, iv, version } : null;
}

async function resolveSecret(
  masterKey: string | undefined,
  ownerId: string,
  profileId: string,
  field: "password" | "privateKey" | "passphrase",
  nextValue: string | null | undefined,
  existing: EncryptedEnvelope | null,
): Promise<EncryptedEnvelope | null> {
  if (nextValue === undefined || nextValue === "") return existing;
  if (nextValue === null) return null;
  return encryptSecret(masterKey, nextValue, { ownerId, recordId: profileId, field });
}

export class ProfileRepository {
  constructor(private readonly db: D1Database, private readonly masterKey?: string) {}

  async list(ownerId: string, limit = 200): Promise<ProfileView[]> {
    assertOwnerId(ownerId);
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const result = await this.db.prepare("SELECT * FROM profiles WHERE owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?")
      .bind(ownerId, bounded).all<ProfileRow>();
    return result.results.map(toView);
  }

  async get(ownerId: string, profileId: string): Promise<ProfileView | null> {
    const row = await this.getRow(ownerId, profileId);
    return row ? toView(row) : null;
  }

  async create(ownerId: string, input: CreateProfileInput): Promise<ProfileView> {
    assertOwnerId(ownerId);
    const id = input.id ?? createId("prf");
    assertRecordId(id);
    const port = input.port ?? 22;
    assertAllowedSshPort(port);
    const authKind = validateEnum(input.authKind, ["password", "private_key", "tailscale_ssh"], "auth kind");
    if (authKind === "tailscale_ssh" && port !== 22) throw new Error("Tailscale SSH profiles must use port 22");
    if (authKind === "tailscale_ssh" && (input.password || input.privateKey || input.passphrase)) {
      throw new Error("Tailscale SSH profiles must not contain credentials");
    }
    const storedAuthKind: StoredProfileAuthKind = authKind === "tailscale_ssh" ? "password" : authKind;
    const storedPersistence: StoredCredentialPersistence = authKind === "tailscale_ssh"
      ? "saved"
      : validateEnum(input.credentialPersistence ?? "saved", ["saved", "prompt"], "credential persistence");
    const now = nowIso();
    const password = input.password ? await encryptSecret(this.masterKey, input.password, { ownerId, recordId: id, field: "password" }) : null;
    const privateKey = input.privateKey ? await encryptSecret(this.masterKey, input.privateKey, { ownerId, recordId: id, field: "privateKey" }) : null;
    const passphrase = input.passphrase ? await encryptSecret(this.masterKey, input.passphrase, { ownerId, recordId: id, field: "passphrase" }) : null;
    const row: ProfileRow = {
      id, owner_id: ownerId, name: validateText(input.name, "name", 100), host: normalizeHost(input.host), port,
      username: validateText(input.username, "username", 128), auth_kind: storedAuthKind,
      tailscale_ssh: authKind === "tailscale_ssh" ? 1 : 0,
      credential_persistence: storedPersistence,
      notes: validateText(input.notes ?? "", "notes", 4000, true),
      initial_command: input.initialCommand == null ? null : validateText(input.initialCommand, "initial command", 8192, true),
      terminal_type: validateEnum(input.terminalType ?? "xterm-256color", ["xterm-256color", "xterm", "screen-256color"], "terminal type"),
      encoding: validateEnum(input.encoding ?? "utf-8", ["utf-8", "gb18030", "big5"], "encoding"), collect_history: toInteger(input.collectHistory ?? true),
      password_ciphertext: password?.ciphertext ?? null, password_iv: password?.iv ?? null, password_version: password?.version ?? null,
      private_key_ciphertext: privateKey?.ciphertext ?? null, private_key_iv: privateKey?.iv ?? null, private_key_version: privateKey?.version ?? null,
      passphrase_ciphertext: passphrase?.ciphertext ?? null, passphrase_iv: passphrase?.iv ?? null, passphrase_version: passphrase?.version ?? null,
      last_connected_at: null, last_connected_username: null, last_host_fingerprint: null, created_at: now, updated_at: now,
    };
    await this.db.prepare(
      `INSERT INTO profiles (id, owner_id, name, host, port, username, auth_kind, tailscale_ssh, credential_persistence, notes, initial_command,
        terminal_type, encoding, collect_history, password_ciphertext, password_iv, password_version,
        private_key_ciphertext, private_key_iv, private_key_version, passphrase_ciphertext, passphrase_iv,
        passphrase_version, last_connected_at, last_connected_username, last_host_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).bind(
      row.id, row.owner_id, row.name, row.host, row.port, row.username, row.auth_kind, row.tailscale_ssh,
      row.credential_persistence, row.notes, row.initial_command,
      row.terminal_type, row.encoding, row.collect_history, row.password_ciphertext, row.password_iv, row.password_version,
      row.private_key_ciphertext, row.private_key_iv, row.private_key_version, row.passphrase_ciphertext, row.passphrase_iv,
      row.passphrase_version, row.created_at, row.updated_at,
    ).run();
    return toView(row);
  }

  async createFromRequest(ownerId: string, request: ProfileCreateRequest): Promise<ProfileView> {
    const shouldSave = request.credential.method !== "tailscale_ssh" && request.credential.persistence === "saved";
    return this.create(ownerId, {
      name: request.name,
      host: request.host,
      port: request.port,
      username: request.username,
      authKind: request.credential.method,
      credentialPersistence: request.credential.method === "tailscale_ssh" ? "none" : request.credential.persistence,
      notes: request.notes,
      initialCommand: request.initialCommand,
      terminalType: request.terminalType,
      encoding: request.encoding,
      password: request.credential.method === "password" && shouldSave ? request.credential.password : undefined,
      privateKey: request.credential.method === "private_key" && shouldSave ? request.credential.privateKey : undefined,
      passphrase: request.credential.method === "private_key" && shouldSave && request.credential.savePassphrase ? request.credential.passphrase : undefined,
    });
  }

  async update(ownerId: string, profileId: string, patch: UpdateProfileInput): Promise<ProfileView | null> {
    const row = await this.getRow(ownerId, profileId);
    if (!row) return null;
    const port = patch.port ?? row.port;
    assertAllowedSshPort(port);
    const authKind = patch.authKind === undefined
      ? profileAuthKind(row)
      : validateEnum(patch.authKind, ["password", "private_key", "tailscale_ssh"], "auth kind");
    if (authKind === "tailscale_ssh" && port !== 22) throw new Error("Tailscale SSH profiles must use port 22");
    if (authKind === "tailscale_ssh" && (typeof patch.password === "string" || typeof patch.privateKey === "string" || typeof patch.passphrase === "string")) {
      throw new Error("Tailscale SSH profiles must not contain credentials");
    }
    const password = authKind === "tailscale_ssh" ? null
      : await resolveSecret(this.masterKey, ownerId, profileId, "password", patch.password, fieldEnvelope(row, "password"));
    const privateKey = authKind === "tailscale_ssh" ? null
      : await resolveSecret(this.masterKey, ownerId, profileId, "privateKey", patch.privateKey, fieldEnvelope(row, "privateKey"));
    const passphrase = authKind === "tailscale_ssh" ? null
      : await resolveSecret(this.masterKey, ownerId, profileId, "passphrase", patch.passphrase, fieldEnvelope(row, "passphrase"));
    const storedPersistence: StoredCredentialPersistence = authKind === "tailscale_ssh"
      ? "saved"
      : validateEnum(
          patch.credentialPersistence === undefined
            ? row.credential_persistence
            : patch.credentialPersistence,
          ["saved", "prompt"],
          "credential persistence",
        );
    const updated: ProfileRow = {
      ...row,
      name: patch.name === undefined ? row.name : validateText(patch.name, "name", 100),
      host: patch.host === undefined ? row.host : normalizeHost(patch.host), port,
      username: patch.username === undefined ? row.username : validateText(patch.username, "username", 128),
      auth_kind: authKind === "tailscale_ssh" ? "password" : authKind,
      tailscale_ssh: authKind === "tailscale_ssh" ? 1 : 0,
      credential_persistence: storedPersistence,
      notes: patch.notes === undefined ? row.notes : validateText(patch.notes, "notes", 4000, true),
      initial_command: patch.initialCommand === undefined ? row.initial_command
        : patch.initialCommand === null ? null : validateText(patch.initialCommand, "initial command", 8192, true),
      terminal_type: patch.terminalType === undefined ? row.terminal_type : validateEnum(patch.terminalType, ["xterm-256color", "xterm", "screen-256color"], "terminal type"),
      encoding: patch.encoding === undefined ? row.encoding : validateEnum(patch.encoding, ["utf-8", "gb18030", "big5"], "encoding"),
      collect_history: patch.collectHistory === undefined ? row.collect_history : toInteger(patch.collectHistory),
      password_ciphertext: password?.ciphertext ?? null, password_iv: password?.iv ?? null, password_version: password?.version ?? null,
      private_key_ciphertext: privateKey?.ciphertext ?? null, private_key_iv: privateKey?.iv ?? null, private_key_version: privateKey?.version ?? null,
      passphrase_ciphertext: passphrase?.ciphertext ?? null, passphrase_iv: passphrase?.iv ?? null, passphrase_version: passphrase?.version ?? null,
      updated_at: nowIso(),
    };
    await this.db.prepare(
      `UPDATE profiles SET name = ?, host = ?, port = ?, username = ?, auth_kind = ?, tailscale_ssh = ?, credential_persistence = ?, notes = ?, initial_command = ?,
        terminal_type = ?, encoding = ?, collect_history = ?, password_ciphertext = ?, password_iv = ?, password_version = ?,
        private_key_ciphertext = ?, private_key_iv = ?, private_key_version = ?, passphrase_ciphertext = ?, passphrase_iv = ?,
        passphrase_version = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
    ).bind(
      updated.name, updated.host, updated.port, updated.username, updated.auth_kind, updated.tailscale_ssh,
      updated.credential_persistence, updated.notes, updated.initial_command,
      updated.terminal_type, updated.encoding, updated.collect_history, updated.password_ciphertext, updated.password_iv, updated.password_version,
      updated.private_key_ciphertext, updated.private_key_iv, updated.private_key_version, updated.passphrase_ciphertext,
      updated.passphrase_iv, updated.passphrase_version, updated.updated_at, profileId, ownerId,
    ).run();
    return toView(updated);
  }

  async updateFromRequest(ownerId: string, profileId: string, request: ProfileUpdateRequest): Promise<ProfileView | null> {
    const patch: UpdateProfileInput = {
      name: request.name,
      host: request.host,
      port: request.port,
      username: request.username,
      notes: request.notes,
      initialCommand: request.initialCommand,
      terminalType: request.terminalType,
      encoding: request.encoding,
    };
    if (request.credential) {
      patch.authKind = request.credential.method;
      const mutation = (value: { action: "keep" } | { action: "clear" } | { action: "replace"; value: string }): string | null | undefined =>
        value.action === "keep" ? undefined : value.action === "clear" ? null : value.value;
      if (request.credential.method === "tailscale_ssh") {
        patch.credentialPersistence = "none";
        patch.password = null;
        patch.privateKey = null;
        patch.passphrase = null;
      } else if (request.credential.persistence === "prompt") {
        patch.credentialPersistence = request.credential.persistence;
        patch.password = null;
        patch.privateKey = null;
        patch.passphrase = null;
      } else if (request.credential.method === "password") {
        patch.credentialPersistence = request.credential.persistence;
        patch.password = mutation(request.credential.password);
        patch.privateKey = null;
        patch.passphrase = null;
      } else {
        patch.credentialPersistence = request.credential.persistence;
        patch.password = null;
        patch.privateKey = mutation(request.credential.privateKey);
        patch.passphrase = mutation(request.credential.passphrase);
      }
    }
    return this.update(ownerId, profileId, patch);
  }

  async delete(ownerId: string, profileId: string): Promise<void> {
    await this.db.prepare("DELETE FROM profiles WHERE id = ? AND owner_id = ?").bind(profileId, ownerId).run();
  }

  async getCredentials(ownerId: string, profileId: string): Promise<ProfileCredentials | null> {
    const row = await this.getRow(ownerId, profileId);
    if (!row) return null;
    const output: ProfileCredentials = {};
    for (const field of ["password", "privateKey", "passphrase"] as const) {
      const encrypted = fieldEnvelope(row, field);
      if (encrypted) output[field] = await decryptSecret(this.masterKey, encrypted, { ownerId, recordId: profileId, field });
    }
    return output;
  }

  async markConnected(ownerId: string, profileId: string, username: string, fingerprint: string): Promise<void> {
    await this.db.prepare(
      `UPDATE profiles SET last_connected_at = ?, last_connected_username = ?, last_host_fingerprint = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).bind(nowIso(), username, fingerprint, nowIso(), profileId, ownerId).run();
  }

  private async getRow(ownerId: string, profileId: string): Promise<ProfileRow | null> {
    assertOwnerId(ownerId);
    assertRecordId(profileId);
    return this.db.prepare("SELECT * FROM profiles WHERE id = ? AND owner_id = ?").bind(profileId, ownerId).first<ProfileRow>();
  }
}
