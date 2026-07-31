import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import {
  Client,
  type Algorithms,
  type ClientChannel,
  type ConnectConfig,
  type FileEntryWithStats,
  type HostVerifier,
  type SFTPWrapper
} from "ssh2";
import { METRICS_COMMAND, parseMetrics } from "./metrics";
import type {
  HostKeyDecision,
  HostKeyRecord,
  MetricsSnapshot,
  RemoteFile,
  SFTPDownloadOptions,
  SSHConnectionProfile,
  SSHAuthentication,
  SSHEngine,
  SSHEngineDependencies,
  SSHEngineEvent,
  SSHTransport,
  TerminalOptions
} from "./types";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024;

type SSHClientAuthenticationOptions = Pick<ConnectConfig, "authHandler" | "password" | "privateKey" | "passphrase">;

export function sshClientAuthenticationOptions(authentication: SSHAuthentication): SSHClientAuthenticationOptions {
  if (authentication.kind === "tailscale-ssh") return { authHandler: ["none"] };
  if (authentication.kind === "password") return { password: authentication.password };
  return { privateKey: authentication.privateKey, passphrase: authentication.passphrase };
}

export const WORKER_SAFE_ALGORITHMS = {
  // ssh2 builds its defaults from the crypto algorithms exposed by the current
  // runtime. Preserve that capability filtering and remove only legacy SHA-1
  // fallbacks instead of forcing Node-only algorithms in Workers.
  serverHostKey: {
    append: [],
    prepend: [],
    remove: ["ssh-rsa"]
  },
  // Workers requires an AEAD auth tag before decipher.update(), while ssh2
  // supplies the OpenSSH GCM tag after the encrypted packet body. Prefer the
  // runtime-supported AES-CTR ciphers with SHA-2 EtM instead.
  cipher: {
    append: [],
    prepend: [],
    remove: [
      "aes128-gcm@openssh.com",
      "aes256-gcm@openssh.com",
      "aes128-gcm",
      "aes256-gcm"
    ]
  },
  hmac: {
    append: [],
    prepend: [],
    remove: ["hmac-sha1-etm@openssh.com", "hmac-sha1"]
  }
} satisfies Algorithms;

interface PendingHostKey {
  fingerprint: string;
  resolve(decision: HostKeyDecision): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface UploadState {
  path: string;
  offset: number;
  stream: Writable;
}

export class SSH2Engine implements SSHEngine {
  private currentState: SSHEngine["state"] = "idle";
  private readonly client = new Client();
  private transport: SSHTransport | null = null;
  private shell: ClientChannel | null = null;
  private sftp: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private profile: SSHConnectionProfile | null = null;
  private terminal: TerminalOptions = { cols: 120, rows: 40, term: "xterm-256color" };
  private pendingHostKey: PendingHostKey | null = null;
  private readonly uploads = new Map<string, UploadState>();
  private closePromise: Promise<void> | null = null;
  private closeEventSent = false;
  private handshakeCount = 0;

  constructor(private readonly dependencies: SSHEngineDependencies) {}

  get state(): SSHEngine["state"] {
    return this.currentState;
  }

  async connect(profile: SSHConnectionProfile, terminal: TerminalOptions): Promise<void> {
    if (this.currentState !== "idle") throw new Error("SSH engine has already been started");
    validateProfile(profile);
    this.terminal = normalizeTerminal(terminal);
    this.profile = profile;
    this.currentState = "connecting";
    this.emit({ type: "status", phase: "tcp_connecting", message: `Connecting to ${profile.host}:${profile.port}` });

    try {
      this.transport = await this.dependencies.transportFactory.connect(
        profile.host,
        profile.port,
        clamp(this.dependencies.connectTimeoutMs ?? 10_000, 2_000, 30_000)
      );
      if (this.isClosed()) throw new Error("SSH connection was cancelled");
      this.emit({ type: "status", phase: "ssh_handshake", message: "Negotiating a secure SSH session" });
      await this.connectClient(profile);
      if (this.isClosed()) throw new Error("SSH connection was cancelled");
      await this.openShell();
      this.currentState = "ready";
      this.emit({ type: "status", phase: "ready", message: "SSH terminal is ready" });
    } catch (error) {
      const cause = asError(error);
      this.emit({ type: "error", code: "SSH_CONNECT_FAILED", message: cause.message });
      await this.close("SSH connection failed");
      throw cause;
    }
  }

  async decideHostKey(decision: HostKeyDecision): Promise<void> {
    const pending = this.pendingHostKey;
    if (!pending || decision.fingerprint !== pending.fingerprint) throw new Error("No matching host-key decision is pending");
    this.pendingHostKey = null;
    clearTimeout(pending.timeout);
    pending.resolve(decision);
  }

  async input(data: Uint8Array): Promise<void> {
    const shell = this.requireShell();
    if (data.byteLength === 0) return;
    if (data.byteLength > MAX_INPUT_BYTES) throw new Error("Terminal input exceeds 256 KiB");
    await writeStream(shell, Buffer.from(data));
  }

  async resize(cols: number, rows: number): Promise<void> {
    const normalized = normalizeTerminal({ ...this.terminal, cols, rows });
    this.terminal = normalized;
    this.shell?.setWindow(normalized.rows, normalized.cols, normalized.rows * 16, normalized.cols * 8);
  }

  async execMetrics(): Promise<MetricsSnapshot> {
    this.requireReady();
    const output = await this.exec(METRICS_COMMAND, MAX_EXEC_OUTPUT_BYTES);
    return parseMetrics(output);
  }

  async listDirectory(path: string): Promise<RemoteFile[]> {
    const sftp = await this.getSftp();
    const list = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(path, (error, entries) => error ? reject(error) : resolve(entries));
    });
    if (list.length > 10_000) throw new Error("Remote directory contains too many entries");
    const parent = path === "/" ? "" : path.replace(/\/+$/, "");
    return list.map((entry): RemoteFile => {
      const entryPath = `${parent}/${entry.filename}` || "/";
      if (!entry.filename || entry.filename.length > 1_024 || entry.filename.includes("\0") || entryPath.length > 4_096) {
        throw new Error("Remote directory contains an invalid entry name");
      }
      return {
        name: entry.filename,
        path: entryPath,
        type: entry.attrs.isDirectory() ? "directory"
          : entry.attrs.isFile() ? "file"
            : entry.attrs.isSymbolicLink() ? "symlink" : "other",
        size: entry.attrs.size,
        mode: entry.attrs.mode & 0o7777,
        modifiedAt: new Date(entry.attrs.mtime * 1000).toISOString()
      };
    }).sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : right.type === "directory" ? 1 : 0;
      return left.name.localeCompare(right.name);
    });
  }

  async stat(path: string): Promise<import("./types").RemoteFileMetadata> {
    const value = await statFile(await this.getSftp(), path);
    return { size: value.size, mode: value.mode & 0o7777, modifiedAt: new Date(value.mtime * 1000).toISOString() };
  }

  async readFile(path: string, maxBytes = MAX_TEXT_FILE_BYTES): Promise<import("./types").RemoteTextFile> {
    const sftp = await this.getSftp();
    const limit = clamp(maxBytes, 1, MAX_TEXT_FILE_BYTES);
    const stat = await statFile(sftp, path);
    if (stat.size > limit) throw new Error(`Remote file exceeds the ${limit} byte text limit`);
    const content = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (error, value) => error ? reject(error) : resolve(Buffer.from(value as Buffer)));
    });
    if (content.byteLength > limit) throw new Error(`Remote file exceeds the ${limit} byte text limit`);
    return {
      content: content.toString("utf8"),
      size: content.byteLength,
      mode: stat.mode & 0o7777,
      modifiedAt: new Date(stat.mtime * 1000).toISOString()
    };
  }

  async createDirectory(path: string, mode: number): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, { mode }, (error) => error ? reject(error) : resolve());
    });
  }

  async rename(sourcePath: string, destinationPath: string): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.rename(sourcePath, destinationPath, (error) => error ? reject(error) : resolve());
    });
  }

  async deletePath(path: string, kind: "file" | "empty_directory"): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null) => error ? reject(error) : resolve();
      if (kind === "empty_directory") sftp.rmdir(path, callback);
      else sftp.unlink(path, callback);
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const sftp = await this.getSftp();
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(path, mode, (error) => error ? reject(error) : resolve());
    });
  }

  async writeFile(path: string, content: string, maxBytes = MAX_TEXT_FILE_BYTES): Promise<void> {
    const sftp = await this.getSftp();
    const limit = clamp(maxBytes, 1, MAX_TEXT_FILE_BYTES);
    if (Buffer.byteLength(content, "utf8") > limit) throw new Error(`Remote file exceeds the ${limit} byte text limit`);
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, content, { encoding: "utf8" }, (error) => error ? reject(error) : resolve());
    });
  }

  async upload(
    requestId: string,
    path: string,
    offset: number,
    chunk: Uint8Array,
    done: boolean
  ): Promise<number> {
    if (!requestId || chunk.byteLength > MAX_UPLOAD_CHUNK_BYTES) throw new Error("Invalid SFTP upload chunk");
    const sftp = await this.getSftp();
    let upload = this.uploads.get(requestId);
    if (offset === 0) {
      if (upload) upload.stream.destroy(new Error("Upload restarted"));
      upload = { path, offset: 0, stream: sftp.createWriteStream(path, { flags: "w" }) };
      this.uploads.set(requestId, upload);
      const created = upload;
      upload.stream.on("error", () => {
        if (this.uploads.get(requestId) === created) this.uploads.delete(requestId);
      });
    }
    if (!upload || upload.path !== path || !Number.isSafeInteger(offset) || offset !== upload.offset) {
      throw new Error("Unexpected SFTP upload offset");
    }
    try {
      if (chunk.byteLength > 0) {
        await writeStream(upload.stream, Buffer.from(chunk));
        upload.offset += chunk.byteLength;
      }
      if (done) {
        await endStream(upload.stream);
        this.uploads.delete(requestId);
      }
      return upload.offset;
    } catch (error) {
      this.uploads.delete(requestId);
      upload.stream.destroy(asError(error));
      throw error;
    }
  }

  async download(path: string, options: SFTPDownloadOptions): Promise<number> {
    const sftp = await this.getSftp();
    const stat = await statFile(sftp, path);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) throw new Error("Invalid SFTP download offset");
    const remaining = stat.size - offset;
    const length = options.length === undefined ? remaining : Math.min(remaining, options.length);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`SFTP download is limited to ${MAX_DOWNLOAD_BYTES} bytes per request`);
    }
    await options.onStart?.(length, offset);
    if (length === 0) return offset;
    const stream = sftp.createReadStream(path, { start: offset, end: offset + length - 1 });
    let cursor = offset;
    try {
      for await (const value of stream) {
        const chunk = new Uint8Array(Buffer.from(value as Buffer));
        await options.onChunk(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return cursor;
    } catch (error) {
      stream.destroy(asError(error));
      throw error;
    }
  }

  async close(reason = "SSH session closed"): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.currentState = "closed";
    this.closePromise = (async () => {
      const pending = this.pendingHostKey;
      this.pendingHostKey = null;
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("SSH session closed during host-key confirmation"));
      }
      for (const upload of this.uploads.values()) upload.stream.destroy(new Error("SSH session closed"));
      this.uploads.clear();
      try { this.sftp?.end(); } catch { /* already closed */ }
      this.sftp = null;
      try { this.shell?.end(); } catch { /* already closed */ }
      this.shell = null;
      try { this.client.end(); } catch { /* already closed */ }
      try { this.client.destroy(); } catch { /* already closed */ }
      const transport = this.transport;
      this.transport = null;
      if (transport) await transport.close().catch(() => undefined);
      if (!this.closeEventSent) {
        this.closeEventSent = true;
        this.emit({ type: "closed", reason });
      }
    })();
    return this.closePromise;
  }

  private async connectClient(profile: SSHConnectionProfile): Promise<void> {
    const transport = this.transport;
    if (!transport) throw new Error("SSH transport is unavailable");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      this.client
        .once("ready", () => finish())
        .once("error", (error) => finish(error))
        .on("banner", (message) => this.emit({ type: "banner", message }))
        .on("handshake", (negotiated) => {
          this.emit({
            type: "handshake",
            rekey: this.handshakeCount++ > 0,
            keyExchange: negotiated.kex,
            hostKeyAlgorithm: negotiated.serverHostKey,
            cipherIn: negotiated.sc.cipher,
            cipherOut: negotiated.cs.cipher,
            macIn: negotiated.sc.mac,
            macOut: negotiated.cs.mac
          });
        })
        .on("error", (error) => {
          if (!settled) return;
          this.emit({ type: "error", code: "SSH_CONNECTION_ERROR", message: error.message });
          void this.close("SSH transport error");
        })
        .on("close", () => void this.close("SSH server closed the connection"));

      this.client.connect({
        host: profile.host,
        port: profile.port,
        sock: transport as unknown as import("node:stream").Readable,
        username: profile.username,
        ...sshClientAuthenticationOptions(profile.authentication),
        readyTimeout: clamp(this.dependencies.connectTimeoutMs ?? 20_000, 2_000, 30_000),
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        algorithms: WORKER_SAFE_ALGORITHMS,
        hostVerifier: ((key, verify) => {
          void this.verifyHostKey(new Uint8Array(key), profile).then(verify, () => verify(false));
        }) satisfies HostVerifier
      });
    });
  }

  private async verifyHostKey(key: Uint8Array, profile: SSHConnectionProfile): Promise<boolean> {
    const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    const keyType = readHostKeyType(key);
    const reference = {
      ownerId: profile.ownerId,
      profileId: profile.profileId,
      host: profile.host,
      port: profile.port
    };
    try {
      const stored = await this.dependencies.hostKeys.get(reference);
      const expected = stored?.fingerprint ?? profile.expectedFingerprint;
      if (expected) {
        const trusted = expected === fingerprint;
        this.emit({ type: "host_key", fingerprint, keyType, trusted, previousFingerprint: trusted ? undefined : expected });
        if (!trusted) {
          this.emit({
            type: "error",
            code: "HOST_KEY_MISMATCH",
            message: `Host key mismatch: expected ${expected}, received ${fingerprint}`
          });
        }
        if (trusted) this.emit({ type: "status", phase: "authenticating", message: "Authenticating with the SSH server" });
        return trusted;
      }

      this.emit({ type: "host_key", fingerprint, keyType, trusted: false });
      const decision = await this.waitForHostKeyDecision(fingerprint);
      if (!decision.accept) {
        this.emit({ type: "error", code: "HOST_KEY_REJECTED", message: "SSH host key was rejected" });
        return false;
      }
      if (!decision.remember) {
        this.emit({ type: "status", phase: "authenticating", message: "Authenticating with the SSH server" });
        return true;
      }
      const candidate: HostKeyRecord = {
        ...reference,
        fingerprint,
        keyType,
        keyBlob: Buffer.from(key).toString("base64"),
        pinnedAt: new Date().toISOString()
      };
      const pinned = await this.dependencies.hostKeys.pinIfAbsent(candidate);
      if (pinned.fingerprint === fingerprint) {
        this.emit({ type: "status", phase: "authenticating", message: "Authenticating with the SSH server" });
        return true;
      }
      this.emit({
        type: "error",
        code: "HOST_KEY_PIN_RACE",
        message: "The host key changed while it was being confirmed"
      });
      return false;
    } catch (error) {
      this.emit({ type: "error", code: "HOST_KEY_VERIFICATION_FAILED", message: asError(error).message });
      return false;
    }
  }

  private waitForHostKeyDecision(fingerprint: string): Promise<HostKeyDecision> {
    if (this.pendingHostKey) return Promise.reject(new Error("Another host key is already awaiting confirmation"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingHostKey?.fingerprint === fingerprint) this.pendingHostKey = null;
        reject(new Error("Host-key confirmation timed out"));
      }, clamp(this.dependencies.hostConfirmationTimeoutMs ?? 30_000, 5_000, 60_000));
      this.pendingHostKey = { fingerprint, resolve, reject, timeout };
    });
  }

  private async openShell(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.shell({
        term: this.terminal.term,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        width: this.terminal.cols * 8,
        height: this.terminal.rows * 16
      }, (error, channel) => {
        if (error) return reject(error);
        this.shell = channel;
        channel.on("data", (data: Buffer | string) => {
          this.emit({ type: "output", data: data.toString() });
        });
        channel.stderr.on("data", (data: Buffer | string) => {
          this.emit({ type: "output", data: data.toString() });
        });
        channel.on("error", (channelError: Error) => {
          this.emit({ type: "error", code: "SSH_CHANNEL_ERROR", message: channelError.message });
          void this.close("SSH shell failed");
        });
        channel.once("close", () => void this.close("SSH shell closed"));
        resolve();
      });
    });
  }

  private async getSftp(): Promise<SFTPWrapper> {
    this.requireReady();
    if (this.sftp) return this.sftp;
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        this.client.sftp((error, sftp) => {
          if (error) return reject(error);
          this.sftp = sftp;
          sftp.once("end", () => { this.sftp = null; this.sftpPromise = null; });
          resolve(sftp);
        });
      }).catch((error) => {
        this.sftpPromise = null;
        throw error;
      });
    }
    return await this.sftpPromise;
  }

  private async exec(command: string, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, channel) => {
        if (error) return reject(error);
        const chunks: Buffer[] = [];
        let bytes = 0;
        let failure: Error | null = null;
        const consume = (value: Buffer | string) => {
          if (failure) return;
          const chunk = Buffer.from(value);
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            failure = new Error("SSH exec output exceeds the configured limit");
            channel.close();
            return;
          }
          chunks.push(chunk);
        };
        channel.on("data", consume);
        channel.stderr.on("data", consume);
        channel.once("error", reject);
        channel.once("close", () => failure ? reject(failure) : resolve(Buffer.concat(chunks).toString("utf8")));
      });
    });
  }

  private requireReady(): void {
    if (this.currentState !== "ready") throw new Error("SSH session is not ready");
  }

  private isClosed(): boolean {
    return this.currentState === "closed";
  }

  private requireShell(): ClientChannel {
    this.requireReady();
    if (!this.shell) throw new Error("SSH shell is not available");
    return this.shell;
  }

  private emit(event: SSHEngineEvent): void {
    try { this.dependencies.onEvent(event); } catch { /* event consumers do not own the SSH lifecycle */ }
  }
}

function normalizeTerminal(value: TerminalOptions): TerminalOptions {
  const cols = Math.floor(value.cols);
  const rows = Math.floor(value.rows);
  if (!Number.isFinite(cols) || cols < 10 || cols > 1_000 || !Number.isFinite(rows) || rows < 5 || rows > 1_000) {
    throw new Error("Invalid terminal size");
  }
  const term = /^[A-Za-z0-9._+-]{1,64}$/.test(value.term) ? value.term : "xterm-256color";
  return { cols, rows, term };
}

function validateProfile(profile: SSHConnectionProfile): void {
  if (!profile.ownerId || !profile.profileId) throw new Error("SSH profile identity is missing");
  if (!profile.host || profile.host.length > 253 || /[\0-\x20/\\?#@%]/.test(profile.host)) throw new Error("Invalid SSH host");
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535) throw new Error("Invalid SSH port");
  if (profile.authentication.kind === "tailscale-ssh" && profile.port !== 22) throw new Error("Tailscale SSH profiles must use port 22");
  if (!profile.username || profile.username.length > 128 || /[\0\r\n]/.test(profile.username)) throw new Error("Invalid SSH username");
  if (profile.authentication.kind === "password" && profile.authentication.password.length > 4_096) throw new Error("SSH password is too large");
  if (profile.authentication.kind === "private-key" && profile.authentication.privateKey.length > 256 * 1024) throw new Error("SSH private key is too large");
  if (profile.expectedFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(profile.expectedFingerprint)) {
    throw new Error("Invalid expected host-key fingerprint");
  }
}

function readHostKeyType(key: Uint8Array): string {
  if (key.byteLength < 4) return "unknown";
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const length = view.getUint32(0);
  if (length < 1 || length > 128 || length + 4 > key.byteLength) return "unknown";
  const type = new TextDecoder().decode(key.subarray(4, 4 + length));
  return /^[A-Za-z0-9@._+-]+$/.test(type) ? type : "unknown";
}

function statFile(sftp: SFTPWrapper, path: string): Promise<{ size: number; mode: number; mtime: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => error ? reject(error) : resolve({ size: stats.size, mode: stats.mode, mtime: stats.mtime }));
  });
}

function writeStream(stream: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function endStream(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    stream.once("error", onError);
    stream.end(() => {
      stream.off("error", onError);
      resolve();
    });
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
