export type SSHAuthentication =
  | { kind: "password"; password: string }
  | { kind: "private-key"; privateKey: string; passphrase?: string }
  | { kind: "tailscale-ssh" };

export type EphemeralSSHCredential =
  | { method: "password"; password: string }
  | { method: "private_key"; privateKey: string; passphrase?: string };

export interface SSHConnectionProfile {
  ownerId: string;
  profileId: string;
  profileName: string;
  host: string;
  port: number;
  username: string;
  authentication: SSHAuthentication;
  collectHistory: boolean;
  collectCommands: boolean;
  expectedFingerprint?: string;
}

export interface TerminalOptions {
  cols: number;
  rows: number;
  term: string;
}

export interface HostKeyReference {
  ownerId: string;
  profileId: string;
  host: string;
  port: number;
}

export interface HostKeyRecord extends HostKeyReference {
  fingerprint: string;
  keyType: string;
  keyBlob: string;
  pinnedAt: string;
}

/** pinIfAbsent must be atomic and return the record that owns the pin. */
export interface HostKeyRepository {
  get(reference: HostKeyReference): Promise<HostKeyRecord | null>;
  pinIfAbsent(record: HostKeyRecord): Promise<HostKeyRecord>;
}

export interface HostKeyDecision {
  fingerprint: string;
  accept: boolean;
  remember: boolean;
}

export interface RemoteFile {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  modifiedAt: string;
}

export interface RemoteTextFile {
  content: string;
  size: number;
  mode: number;
  modifiedAt: string;
}

export interface RemoteFileMetadata {
  size: number;
  mode: number;
  modifiedAt: string;
}

export interface ResourceUsage {
  usedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpuPercent: number;
  memoryPercent: number;
  command: string;
}

export interface ServerMetrics {
  cpuPercent: number;
  memory: ResourceUsage;
  swap: ResourceUsage;
  disk: ResourceUsage;
  updatedAt: string;
}

export interface MetricsSnapshot {
  metrics: ServerMetrics;
  processes: ProcessInfo[];
}

export type SSHEngineEvent =
  | { type: "status"; phase: string; message: string }
  | { type: "banner"; message: string }
  | { type: "output"; data: string }
  | { type: "host_key"; fingerprint: string; keyType: string; trusted: boolean; previousFingerprint?: string }
  | {
      type: "handshake";
      rekey: boolean;
      keyExchange: string;
      hostKeyAlgorithm: string;
      cipherIn: string;
      cipherOut: string;
      macIn: string;
      macOut: string;
    }
  | { type: "error"; code: string; message: string }
  | { type: "closed"; reason: string };

export interface SFTPDownloadOptions {
  offset?: number;
  length?: number;
  onStart?(totalBytes: number, offset: number): Promise<void> | void;
  onChunk(chunk: Uint8Array, offset: number): Promise<void> | void;
}

export interface SSHEngine {
  readonly state: "idle" | "connecting" | "ready" | "closed";
  connect(profile: SSHConnectionProfile, terminal: TerminalOptions): Promise<void>;
  decideHostKey(decision: HostKeyDecision): Promise<void>;
  input(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  execMetrics(): Promise<MetricsSnapshot>;
  listDirectory(path: string): Promise<RemoteFile[]>;
  stat(path: string): Promise<RemoteFileMetadata>;
  createDirectory(path: string, mode: number): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  deletePath(path: string, kind: "file" | "empty_directory"): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readFile(path: string, maxBytes?: number): Promise<RemoteTextFile>;
  writeFile(path: string, content: string, maxBytes?: number): Promise<void>;
  upload(requestId: string, path: string, offset: number, chunk: Uint8Array, done: boolean): Promise<number>;
  download(path: string, options: SFTPDownloadOptions): Promise<number>;
  close(reason?: string): Promise<void>;
}

export interface SSHTransport extends NodeJS.ReadWriteStream {
  close(): Promise<void>;
}

export interface SSHTransportFactory {
  connect(host: string, port: number, timeoutMs: number): Promise<SSHTransport>;
}

export interface SSHEngineDependencies {
  transportFactory: SSHTransportFactory;
  hostKeys: HostKeyRepository;
  onEvent(event: SSHEngineEvent): void;
  connectTimeoutMs?: number;
  hostConfirmationTimeoutMs?: number;
}

export interface SSHProfileRepository {
  resolve(ownerId: string, profileId: string, credential?: EphemeralSSHCredential): Promise<SSHConnectionProfile>;
}
