import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { connect } from "cloudflare:sockets";
import { assertPublicTarget, toSocketHostname } from "../security/network";
import type { SSHTransport, SSHTransportFactory } from "./types";

// The Web Streams-to-Duplex bridge is adapted from tafeng/worker/sshBridge.ts (MIT).

export class CloudflareSocketDuplex extends Duplex implements SSHTransport {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private closing: Promise<void> | null = null;
  private pumping = true;

  constructor(private readonly socket: Socket) {
    super();
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    void this.pump();
  }

  override _read(): void {
    // The Web Stream reader drives incoming data.
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : new Uint8Array(chunk);
    this.writer.write(bytes).then(() => callback(), (error: unknown) => callback(asError(error)));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.writer.close().then(() => callback(), (error: unknown) => callback(asError(error)));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.close().then(() => callback(error), (closeError: unknown) => callback(asError(closeError)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.pumping = false;
    this.closing = (async () => {
      await Promise.allSettled([
        this.reader.cancel(),
        this.writer.abort(new Error("SSH transport closed")),
        this.socket.close()
      ]);
    })();
    return this.closing;
  }

  private async pump(): Promise<void> {
    try {
      while (this.pumping) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.byteLength) this.push(Buffer.from(value));
      }
      if (!this.destroyed) this.push(null);
    } catch (error) {
      if (this.pumping && !this.destroyed) this.destroy(asError(error));
    }
  }
}

export class CloudflareSSHTransportFactory implements SSHTransportFactory {
  constructor(private readonly allowedPorts: ReadonlySet<number> | null = null) {}

  async connect(host: string, port: number, timeoutMs: number): Promise<SSHTransport> {
    // This is the final policy check before cloudflare:sockets.connect().
    const target = await assertPublicTarget(host, port, this.allowedPorts);
    let lastError: Error = new Error("No verified SSH address is available");
    const deadline = Date.now() + timeoutMs;
    for (const address of target.addresses) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const socket = connect({ hostname: toSocketHostname(address), port }, { secureTransport: "off", allowHalfOpen: false });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          socket.opened,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("TCP connection timed out")), remainingMs);
          })
        ]);
        return new CloudflareSocketDuplex(socket);
      } catch (error) {
        lastError = asError(error);
        await socket.close().catch(() => undefined);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
