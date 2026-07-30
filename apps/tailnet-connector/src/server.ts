import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { authenticateUpgrade, NonceReplayCache } from "./auth";
import type { ConnectorConfig } from "./config";
import { resolveTailnetTarget, type LookupAll, type VerifiedTailnetTarget } from "./targets";

export interface ConnectorServer {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
  activeConnections(): number;
}

export interface ConnectorServerDependencies {
  now?: () => number;
  lookupAll?: LookupAll;
  connectTcp?: typeof connectVerifiedTarget;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export function createConnectorServer(config: ConnectorConfig, dependencies: ConnectorServerDependencies = {}): ConnectorServer {
  const now = dependencies.now ?? Date.now;
  const lookupAll = dependencies.lookupAll;
  const connectTcp = dependencies.connectTcp ?? connectVerifiedTarget;
  const logger = dependencies.logger ?? console;
  const replayCache = new NonceReplayCache();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: config.maxBufferedBytes, perMessageDeflate: false });
  const active = new Set<WebSocket>();
  let reservedConnections = 0;

  const server = createServer((request, response) => routeHttp(request, response, reservedConnections, config.maxConnections));
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      logger.error(`Connector upgrade failed: ${safeMessage(error)}`);
      rejectUpgrade(socket, 500, "Internal Server Error");
    });
  });

  async function handleUpgrade(request: IncomingMessage, upgradeSocket: Duplex, head: Buffer): Promise<void> {
    if (request.url !== "/v1/connect") {
      rejectUpgrade(upgradeSocket, 404, "Not Found");
      return;
    }
    let handshake;
    try {
      handshake = authenticateUpgrade(request.headers, config.hmacKey, config.authWindowMs, replayCache, now());
    } catch (error) {
      logger.warn(`Connector upgrade rejected: ${safeMessage(error)}`);
      rejectUpgrade(upgradeSocket, 401, "Unauthorized");
      return;
    }
    if (reservedConnections >= config.maxConnections) {
      rejectUpgrade(upgradeSocket, 503, "Connection Limit Reached");
      return;
    }
    reservedConnections += 1;
    let pending = true;
    let rejectDisconnected: (error: Error) => void = () => undefined;
    let pendingDisconnected = false;
    const disconnected = new Promise<never>((_resolve, reject) => {
      rejectDisconnected = reject;
    });
    const onPendingDisconnect = () => {
      pendingDisconnected = true;
      rejectDisconnected(new PendingClientDisconnected());
    };
    upgradeSocket.once("close", onPendingDisconnect);
    upgradeSocket.once("end", onPendingDisconnect);
    upgradeSocket.once("error", onPendingDisconnect);
    const removePendingListeners = () => {
      upgradeSocket.off("close", onPendingDisconnect);
      upgradeSocket.off("end", onPendingDisconnect);
      upgradeSocket.off("error", onPendingDisconnect);
    };
    const releasePending = () => {
      if (!pending) return;
      pending = false;
      removePendingListeners();
      reservedConnections -= 1;
    };
    const deadline = Date.now() + config.connectTimeoutMs;
    let target: VerifiedTailnetTarget;
    try {
      target = await pendingOperation(
        resolveTailnetTarget(handshake.host, handshake.port, config.allowedPorts, config.allowedSuffix, lookupAll),
        deadline,
        disconnected,
      );
    } catch (error) {
      releasePending();
      if (error instanceof PendingClientDisconnected) {
        upgradeSocket.destroy();
        return;
      }
      logger.warn(`Connector target rejected: ${safeMessage(error)}`);
      rejectUpgrade(
        upgradeSocket,
        error instanceof ConnectorTimeoutError ? 504 : 403,
        error instanceof ConnectorTimeoutError ? "Tailnet Connection Timed Out" : "Target Rejected",
      );
      return;
    }
    let tcp: Socket;
    let tcpOperation: Promise<Socket> | null = null;
    try {
      tcpOperation = connectTcp(target, handshake.port, remainingMs(deadline));
      tcp = await pendingOperation(
        tcpOperation,
        deadline,
        disconnected,
      );
    } catch (error) {
      if (tcpOperation) void tcpOperation.then((lateSocket) => lateSocket.destroy(), () => undefined);
      releasePending();
      if (error instanceof PendingClientDisconnected) {
        upgradeSocket.destroy();
        return;
      }
      logger.warn(`Connector target connection failed: ${safeMessage(error)}`);
      rejectUpgrade(
        upgradeSocket,
        error instanceof ConnectorTimeoutError ? 504 : 502,
        error instanceof ConnectorTimeoutError ? "Tailnet Connection Timed Out" : "Tailnet Connection Failed",
      );
      return;
    }
    if (pendingDisconnected || upgradeSocket.destroyed || !upgradeSocket.readable || !upgradeSocket.writable) {
      releasePending();
      tcp.destroy();
      upgradeSocket.destroy();
      return;
    }
    let accepted = false;
    try {
      webSockets.handleUpgrade(request, upgradeSocket, head, (webSocket) => {
        accepted = true;
        if (!pending || pendingDisconnected) {
          releasePending();
          webSocket.terminate();
          tcp.destroy();
          return;
        }
        pending = false;
        removePendingListeners();
        active.add(webSocket);
        relay(webSocket, tcp, config, () => {
          active.delete(webSocket);
          reservedConnections -= 1;
        });
      });
      if (!accepted) {
        releasePending();
        tcp.destroy();
      }
    } catch (error) {
      releasePending();
      tcp.destroy();
      throw error;
    }
  }

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.listenHost, () => {
        server.off("error", reject);
        logger.info(`Tailnet Connector listening on ${config.listenHost}:${config.port}`);
        resolve();
      });
    }),
    close: async () => {
      for (const webSocket of active) webSocket.close(1001, "Connector shutting down");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      webSockets.close();
    },
    activeConnections: () => reservedConnections,
  };
}

class PendingClientDisconnected extends Error {}
class ConnectorTimeoutError extends Error {}

async function pendingOperation<T>(operation: Promise<T>, deadline: number, disconnected: Promise<never>): Promise<T> {
  const timeoutMs = remainingMs(deadline);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      disconnected,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ConnectorTimeoutError("Tailnet connection timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ConnectorTimeoutError("Tailnet connection timed out");
  return remaining;
}

export async function connectVerifiedTarget(target: VerifiedTailnetTarget, port: number, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error = new Error("No verified Tailnet address is available");
  for (const entry of target.addresses) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host: entry.address, port, family: entry.family });
        const fail = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        socket.setTimeout(remainingMs, () => fail(new Error("Tailnet TCP connection timed out")));
        socket.once("error", fail);
        socket.once("connect", () => {
          socket.off("error", fail);
          socket.setTimeout(0);
          resolve(socket);
        });
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError;
}

function relay(webSocket: WebSocket, tcp: Socket, config: ConnectorConfig, release: () => void): void {
  let finished = false;
  let idleTimer: NodeJS.Timeout;
  const maxSessionTimer = setTimeout(() => finish(1000, "Maximum session duration reached"), config.maxSessionMs);
  maxSessionTimer.unref();

  const refreshIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(1000, "Idle timeout reached"), config.idleTimeoutMs);
    idleTimer.unref();
  };
  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(maxSessionTimer);
    release();
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(code, reason);
    tcp.destroy();
  };

  refreshIdleTimer();
  webSocket.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      finish(1003, "Binary frames are required");
      return;
    }
    refreshIdleTimer();
    if (!tcp.write(toBuffer(data))) webSocket.pause();
  });
  tcp.on("drain", () => webSocket.resume());
  tcp.on("data", (chunk) => {
    refreshIdleTimer();
    if (webSocket.readyState !== WebSocket.OPEN) return;
    if (webSocket.bufferedAmount + chunk.byteLength > config.maxBufferedBytes) {
      finish(1011, "Relay backpressure limit exceeded");
      return;
    }
    tcp.pause();
    webSocket.send(chunk, { binary: true }, (error) => {
      if (error) finish(1011, "WebSocket relay failed");
      else if (!finished) tcp.resume();
    });
  });
  webSocket.on("close", () => finish(1000, "WebSocket closed"));
  webSocket.on("error", () => finish(1011, "WebSocket relay failed"));
  tcp.on("end", () => finish(1000, "Tailnet target closed"));
  tcp.on("error", () => finish(1011, "Tailnet TCP relay failed"));
  tcp.on("close", () => finish(1000, "Tailnet target closed"));
}

function routeHttp(request: IncomingMessage, response: ServerResponse, activeConnections: number, maxConnections: number): void {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", activeConnections, maxConnections }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Not Found\n");
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "request rejected";
  if (/signature|authentication|header|replay|expired/i.test(error.message)) return "authentication failed";
  return error.message.replace(/[\r\n]/g, " ").slice(0, 160);
}
