import {
	BinaryFrameHeaderSchema,
	ClientWebSocketMessageSchema,
	EntityIdSchema,
	MAX_JSON_MESSAGE_BYTES,
	MAX_TERMINAL_CHUNK_BYTES,
	ServerWebSocketMessageSchema,
	SshTicketRequestSchema,
	WEBSOCKET_CLOSE_CODES,
	WS_PROTOCOL_VERSION,
	type ApiErrorCode,
	type BinaryFrameHeader,
	type ClientWebSocketMessage,
	type EphemeralCredential,
	type SessionCloseReason,
	type ServerWebSocketMessage,
	type SshTicketRequest,
} from "@edgesh/contracts";
import { getRuntimeConfig, type Env } from "../env";
import { decodeBase64Url, encodeBase64Url } from "../security/encoding";
import { decryptSecret, type EncryptedEnvelope } from "../security/envelope";
import { createRepositories } from "../storage";
import {
	SSH2Engine,
	SSHSessionAudit,
	TerminalCommandCapture,
	createSSHTransportFactory,
	type EphemeralSSHCredential,
	type HostKeyRecord,
	type HostKeyReference,
	type HostKeyRepository,
	type MetricsSnapshot,
	type SSHEngine,
	type SSHEngineDependencies,
	type SSHEngineEvent,
	type SSHConnectionProfile,
	type SSHProfileRepository,
} from "../ssh";
import { SSH_SESSION_LEASE_RENEW_MS } from "./ssh-session-registry";

const TICKET_STORAGE_KEY = "ssh-session-ticket";
const TICKET_TTL_MS = 60_000;
const CONNECT_MESSAGE_TIMEOUT_MS = 10_000;
const HOST_CONFIRMATION_TIMEOUT_MS = 30_000;
const METRICS_INTERVAL_MS = 8_000;
const BACKGROUND_METRICS_INTERVAL_MS = 30_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_JSON_OUTPUT_CHARS = 8 * 1024;

interface TicketEnvelope {
	iv: string;
	ciphertext: string;
}

interface StoredTicket {
	ticketHash: string;
	expiresAt: number;
	ownerId: string;
	profileId: string;
	attemptId: string;
	sessionId: string;
	origin: string;
	profile: TicketEnvelope;
}

interface TicketAuthorization {
	expiresAt: number;
	attemptId: string;
	sessionId: string;
	origin: string;
	profile: SSHConnectionProfile;
}

interface Attachment {
	phase: "waiting" | "connecting" | "connected";
	sessionId: string;
	ownerId?: string;
}

interface UploadTransfer {
	requestId: string;
	path: string;
	size: number;
	offset: number;
	startedAt: number;
	kind: "upload" | "write";
}

interface LiveSession {
	authorization: TicketAuthorization;
	engine: SSHEngine;
	audit: SSHSessionAudit;
	commandCapture: TerminalCommandCapture;
	outputSequence: number;
	binarySequence: number;
	requestId?: string;
	metricsTimer: ReturnType<typeof setTimeout> | null;
	metricsInFlight: boolean;
	metricsActivity: {
		active: boolean;
		visible: boolean;
		monitoring: boolean;
		reduceWhenHidden: boolean;
		refreshIntervalMs: number;
	};
	leaseTimer: ReturnType<typeof setTimeout> | null;
	leaseRenewalInFlight: boolean;
	leaseExpiresAt: number;
	uploads: Map<string, UploadTransfer>;
}

interface SessionClosure {
	finalState: "closed" | "error";
	closeReason: SessionCloseReason;
	message: string;
}

interface InternalTicketRequest {
	ownerId: string;
	sessionId?: string;
	request: SshTicketRequest;
}

export interface SSHSessionDODependencies {
	createProfileRepository(env: Env): SSHProfileRepository;
	createHostKeyRepository(env: Env): HostKeyRepository;
	createEngine(dependencies: SSHEngineDependencies): SSHEngine;
}

export class SSHSessionDO implements DurableObject {
	private readonly authorizations = new Map<WebSocket, TicketAuthorization>();
	private readonly sessions = new Map<WebSocket, LiveSession>();
	private readonly deadlines = new Map<
		WebSocket,
		ReturnType<typeof setTimeout>
	>();
	private readonly startingSockets = new Set<WebSocket>();
	private readonly messageQueues = new Map<WebSocket, Promise<void>>();
	private readonly dependencies: SSHSessionDODependencies;

	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
		dependencies: Partial<SSHSessionDODependencies> = {},
	) {
		this.dependencies = {
			createProfileRepository:
				dependencies.createProfileRepository ??
				((runtimeEnv) => new D1SSHProfileRepository(runtimeEnv)),
			createHostKeyRepository:
				dependencies.createHostKeyRepository ??
				((runtimeEnv) => new D1HostKeyRepository(runtimeEnv.DB)),
			createEngine:
				dependencies.createEngine ??
				((engineDependencies) => new SSH2Engine(engineDependencies)),
		};

		// The one-shot ticket and restart lifecycle follows CF-Workers-WebSSH's
		// Durable Object design (Apache-2.0); credentials use a new sealed envelope.
		void state.blockConcurrencyWhile(async () => {
			await Promise.all(
				state
					.getWebSockets()
					.map((socket) => this.recoverRestartedSocket(socket)),
			);
		});
	}

	async fetch(request: Request): Promise<Response> {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return Response.json({ error: "Invalid request URL" }, { status: 400 });
		}
		if (url.pathname === "/ticket" && request.method === "POST")
			return this.issueTicket(request);
		if (url.pathname === "/connect" && request.method === "GET")
			return this.upgrade(request, url);
		return Response.json({ error: "Not found" }, { status: 404 });
	}

	async webSocketMessage(
		socket: WebSocket,
		raw: string | ArrayBuffer,
	): Promise<void> {
		const previous = this.messageQueues.get(socket) ?? Promise.resolve();
		const operation = previous.then(() =>
			this.processWebSocketMessage(socket, raw),
		);
		this.messageQueues.set(socket, operation);
		try {
			await operation;
		} finally {
			if (this.messageQueues.get(socket) === operation)
				this.messageQueues.delete(socket);
		}
	}

	private async processWebSocketMessage(
		socket: WebSocket,
		raw: string | ArrayBuffer,
	): Promise<void> {
		let requestId: string | undefined;
		try {
			if (typeof raw !== "string") {
				await this.handleBinaryFrame(socket, new Uint8Array(raw));
				return;
			}
			if (new TextEncoder().encode(raw).byteLength > MAX_JSON_MESSAGE_BYTES) {
				throw new ProtocolError(
					"BAD_REQUEST",
					"WebSocket message exceeds 64 KiB",
					true,
					WEBSOCKET_CLOSE_CODES.MESSAGE_TOO_LARGE,
				);
			}
			let decoded: unknown;
			try {
				decoded = JSON.parse(raw);
			} catch {
				throw new ProtocolError("VALIDATION_FAILED", "Invalid WebSocket JSON");
			}
			const result = ClientWebSocketMessageSchema.safeParse(decoded);
			if (!result.success)
				throw new ProtocolError(
					"VALIDATION_FAILED",
					"Invalid WebSocket message",
				);
			requestId = result.data.requestId;
			await this.handleClientMessage(socket, result.data);
		} catch (error) {
			const live = this.sessions.get(socket);
			const failure =
				error instanceof ProtocolError
					? error
					: new ProtocolError("INTERNAL_ERROR", asError(error).message, !live);
			const context = live?.authorization ?? this.authorizations.get(socket);
			this.sendError(
				socket,
				context,
				failure.code,
				failure.message,
				failure.fatal,
				requestId,
			);
			if (failure.fatal)
				await this.closeSocket(socket, failure.closeCode, failure.message);
		}
	}

	async webSocketClose(
		socket: WebSocket,
		code: number,
		_reason: string,
		wasClean: boolean,
	): Promise<void> {
		const userInitiated = wasClean && (code === 1000 || code === 1001);
		await this.cleanup(socket, {
			finalState: userInitiated ? "closed" : "error",
			closeReason: userInitiated ? "user_disconnect" : "network_error",
			message: userInitiated
				? "Browser WebSocket closed"
				: "Browser WebSocket closed unexpectedly",
		});
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		await this.cleanup(socket, {
			finalState: "error",
			closeReason: "network_error",
			message: "Browser WebSocket failed",
		});
	}

	async alarm(): Promise<void> {
		await this.state.storage.delete(TICKET_STORAGE_KEY);
	}

	private async issueTicket(request: Request): Promise<Response> {
		if (
			!constantTimeTextEqual(
				request.headers.get("x-internal-auth") ?? "",
				this.env.SESSION_HMAC_KEY ?? "",
			)
		) {
			return Response.json(
				{ error: "Unauthorized internal request" },
				{ status: 401 },
			);
		}
		const origin = parseVerifiedOrigin(
			request.headers.get("x-verified-origin"),
		);
		if (!origin)
			return Response.json(
				{ error: "A verified origin is required" },
				{ status: 400 },
			);

		let body: InternalTicketRequest;
		try {
			const raw = await request.json<Record<string, unknown>>();
			const owner = EntityIdSchema.safeParse(raw.ownerId);
			const session =
				raw.sessionId === undefined
					? { success: true as const, data: crypto.randomUUID() }
					: EntityIdSchema.safeParse(raw.sessionId);
			const ticketCandidate = raw.request ?? {
				profileId: raw.profileId,
				attemptId: raw.attemptId,
				terminal: raw.terminal,
				ephemeralCredential: raw.ephemeralCredential,
			};
			const ticket = SshTicketRequestSchema.safeParse(ticketCandidate);
			if (!owner.success || !session.success || !ticket.success)
				throw new Error("Invalid internal ticket request");
			body = {
				ownerId: owner.data,
				sessionId: session.data,
				request: ticket.data,
			};
		} catch {
			return Response.json(
				{ error: "Invalid internal ticket request" },
				{ status: 400 },
			);
		}

		let profile: SSHConnectionProfile;
		try {
			profile = await this.dependencies
				.createProfileRepository(this.env)
				.resolve(
					body.ownerId,
					body.request.profileId,
					toEphemeralCredential(body.request.ephemeralCredential),
				);
		} catch (error) {
			const message = asError(error).message;
			const credentialRequired =
				/credential (?:is missing|required)|requires an ephemeral credential/i.test(
					message,
				);
			const tailscaleConfigurationInvalid = /Tailscale SSH profile/i.test(
				message,
			);
			return Response.json(
				{
					error: credentialRequired
						? "Credential required"
						: tailscaleConfigurationInvalid
							? "Tailscale SSH profile configuration is invalid"
							: "Profile not found",
				},
				{
					status: credentialRequired
						? 422
						: tailscaleConfigurationInvalid
							? 400
							: 404,
				},
			);
		}

		const ticketBytes = crypto.getRandomValues(new Uint8Array(32));
		const ticket = encodeBase64Url(ticketBytes);
		const expiresAt = Date.now() + TICKET_TTL_MS;
		const sessionId = body.sessionId ?? crypto.randomUUID();
		const aad = ticketAdditionalData(
			sessionId,
			body.request.attemptId,
			expiresAt,
			origin,
		);
		try {
			const stored: StoredTicket = {
				ticketHash: await sha256Base64Url(ticketBytes),
				expiresAt,
				ownerId: body.ownerId,
				profileId: body.request.profileId,
				attemptId: body.request.attemptId,
				sessionId,
				origin,
				profile: await sealProfile(ticketBytes, profile, aad),
			};
			const created = await this.state.storage.transaction(
				async (transaction) => {
					if (await transaction.get(TICKET_STORAGE_KEY)) return false;
					await transaction.put(TICKET_STORAGE_KEY, stored);
					await transaction.setAlarm(expiresAt);
					return true;
				},
			);
			if (!created)
				return Response.json(
					{ error: "A ticket has already been issued for this session" },
					{ status: 409 },
				);
			return Response.json({
				ticket,
				expiresAt: new Date(expiresAt).toISOString(),
				sessionId,
			});
		} finally {
			ticketBytes.fill(0);
		}
	}

	private async upgrade(request: Request, url: URL): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return Response.json(
				{ error: "WebSocket upgrade required" },
				{ status: 426 },
			);
		}
		const origin = parseVerifiedOrigin(
			request.headers.get("x-verified-origin"),
		);
		const ownerId = request.headers.get("x-owner-id");
		const ticket =
			url.searchParams.get("ticket") ?? request.headers.get("x-session-ticket");
		if (!ticket || !origin || !ownerId)
			return Response.json({ error: "Invalid SSH ticket" }, { status: 401 });
		const authorization = await this.consumeTicket(ticket, origin, ownerId);
		if (!authorization)
			return Response.json(
				{ error: "Invalid, expired, or already used SSH ticket" },
				{ status: 401 },
			);

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.state.acceptWebSocket(server);
		server.serializeAttachment({
			phase: "waiting",
			sessionId: authorization.sessionId,
			ownerId: authorization.profile.ownerId,
		} satisfies Attachment);
		this.authorizations.set(server, authorization);
		this.deadlines.set(
			server,
			setTimeout(() => {
				void this.closeSocket(
					server,
					WEBSOCKET_CLOSE_CODES.MESSAGE_INVALID,
					"Connect message timed out",
				);
			}, CONNECT_MESSAGE_TIMEOUT_MS),
		);
		return new Response(null, { status: 101, webSocket: client });
	}

	private async consumeTicket(
		ticket: string,
		origin: string,
		ownerId: string,
	): Promise<TicketAuthorization | null> {
		let ticketBytes: Uint8Array;
		try {
			ticketBytes = decodeBase64Url(ticket);
			if (ticketBytes.byteLength !== 32) return null;
		} catch {
			return null;
		}
		try {
			const presentedHash = await sha256Base64Url(ticketBytes);
			const stored = await this.state.storage.transaction(
				async (transaction) => {
					const value = await transaction.get<StoredTicket>(TICKET_STORAGE_KEY);
					if (!value) return null;
					// Any use attempt consumes the ticket, including a malformed or wrong-origin attempt.
					await transaction.delete(TICKET_STORAGE_KEY);
					await transaction.deleteAlarm();
					return value;
				},
			);
			if (
				!stored ||
				stored.expiresAt < Date.now() ||
				stored.expiresAt > Date.now() + TICKET_TTL_MS + 5_000 ||
				stored.origin !== origin ||
				!constantTimeTextEqual(stored.ownerId, ownerId) ||
				!constantTimeTextEqual(stored.ticketHash, presentedHash)
			)
				return null;
			const profile = await openProfile(
				ticketBytes,
				stored.profile,
				ticketAdditionalData(
					stored.sessionId,
					stored.attemptId,
					stored.expiresAt,
					stored.origin,
				),
			);
			return {
				expiresAt: stored.expiresAt,
				attemptId: stored.attemptId,
				sessionId: stored.sessionId,
				origin: stored.origin,
				profile,
			};
		} catch {
			return null;
		} finally {
			ticketBytes.fill(0);
		}
	}

	private async handleClientMessage(
		socket: WebSocket,
		message: ClientWebSocketMessage,
	): Promise<void> {
		const authorization = this.authorizations.get(socket);
		const live = this.sessions.get(socket);
		if (!authorization && !live)
			throw new ProtocolError(
				"SSH_TICKET_INVALID",
				"SSH session authorization is missing",
			);
		const context = live?.authorization ?? authorization;
		if (!context || message.attemptId !== context.attemptId) {
			throw new ProtocolError(
				"VALIDATION_FAILED",
				"WebSocket attempt ID does not match the ticket",
			);
		}

		if (message.type === "hello") {
			if (live)
				throw new ProtocolError(
					"VALIDATION_FAILED",
					"SSH session has already started",
				);
			this.sendStatus(
				socket,
				context,
				"authorizing",
				"SSH ticket accepted",
				message.requestId,
			);
			return;
		}

		if (message.type === "connect") {
			if (live || !authorization || this.startingSockets.has(socket)) {
				throw new ProtocolError(
					"VALIDATION_FAILED",
					"SSH session has already started",
				);
			}
			this.clearDeadline(socket);
			this.startingSockets.add(socket);
			let leaseAcquired = false;
			let audit: SSHSessionAudit | null = null;
			try {
				const config = getRuntimeConfig(this.env);
				const lease = await this.updateSessionLease(
					authorization.profile.ownerId,
					authorization.sessionId,
					"acquire",
					config.maxSessionsPerUser,
				);
				leaseAcquired = lease.acquired;
				if (!leaseAcquired) {
					await this.recordSecurityEvent(
						authorization.profile.ownerId,
						"ssh_session_limit_rejected",
						`SSH session limit rejected for profile ${authorization.profile.profileName}`,
					);
					this.sendError(
						socket,
						authorization,
						"RATE_LIMITED",
						"The active SSH session limit has been reached",
						true,
					);
					await this.closeSocket(
						socket,
						WEBSOCKET_CLOSE_CODES.SESSION_TERMINATED,
						"SSH session limit reached",
					);
					return;
				}
				if (
					socket.readyState !== WebSocket.OPEN ||
					this.authorizations.get(socket) !== authorization
				) {
					await this.releaseSessionLease(
						authorization.profile.ownerId,
						authorization.sessionId,
					);
					return;
				}

				audit = await SSHSessionAudit.start(
					this.env,
					authorization.sessionId,
					authorization.profile,
				);
				if (
					socket.readyState !== WebSocket.OPEN ||
					this.authorizations.get(socket) !== authorization
				) {
					await Promise.allSettled([
						this.releaseSessionLease(
							authorization.profile.ownerId,
							authorization.sessionId,
						),
						audit.finish(
							"closed",
							"user_disconnect",
							"Browser WebSocket closed during SSH startup",
						),
					]);
					return;
				}

				const engine = this.dependencies.createEngine({
					transportFactory: createSSHTransportFactory(
						config,
						authorization.sessionId,
					),
					hostKeys: this.dependencies.createHostKeyRepository(this.env),
					connectTimeoutMs: config.connectTimeoutMs,
					hostConfirmationTimeoutMs: HOST_CONFIRMATION_TIMEOUT_MS,
					onEvent: (event) => this.handleEngineEvent(socket, event),
				});
				const session: LiveSession = {
					authorization,
					engine,
					audit,
					commandCapture: new TerminalCommandCapture(),
					outputSequence: 0,
					binarySequence: 0,
					requestId: message.requestId,
					metricsTimer: null,
					metricsInFlight: false,
					metricsActivity: {
						active: true,
						visible: true,
						monitoring: true,
						reduceWhenHidden: true,
						refreshIntervalMs: METRICS_INTERVAL_MS,
					},
					leaseTimer: null,
					leaseRenewalInFlight: false,
					leaseExpiresAt: lease.expiresAt,
					uploads: new Map(),
				};
				socket.serializeAttachment({
					phase: "connecting",
					sessionId: authorization.sessionId,
					ownerId: authorization.profile.ownerId,
				} satisfies Attachment);
				this.sessions.set(socket, session);
				this.authorizations.delete(socket);
				this.scheduleLeaseRenewal(socket, session, SSH_SESSION_LEASE_RENEW_MS);
				void engine
					.connect(authorization.profile, {
						cols: message.terminal.columns,
						rows: message.terminal.rows,
						term: message.terminal.type,
					})
					.then(() => {
						if (this.sessions.get(socket) !== session) return;
						socket.serializeAttachment({
							phase: "connected",
							sessionId: authorization.sessionId,
							ownerId: authorization.profile.ownerId,
						} satisfies Attachment);
						this.scheduleMetrics(socket, session, 0);
					})
					.catch(() => undefined);
			} catch (error) {
				if (audit) {
					await audit.finish(
						"error",
						"internal_error",
						"SSH session initialization failed",
					);
				}
				if (leaseAcquired) {
					await this.releaseSessionLease(
						authorization.profile.ownerId,
						authorization.sessionId,
					);
				}
				throw error;
			} finally {
				this.startingSockets.delete(socket);
			}
			return;
		}

		if (!live)
			throw new ProtocolError(
				"VALIDATION_FAILED",
				"The first session command must be connect",
			);
		switch (message.type) {
			case "host-key-decision":
				await live.engine.decideHostKey({
					fingerprint: message.fingerprint,
					accept: message.decision !== "reject",
					remember: message.decision === "trust_and_save",
				});
				if (message.decision === "reject") {
					live.audit.state(
						"error",
						"host_key_rejected",
						"SSH host key was rejected by the user",
					);
					live.audit.security(
						"ssh_host_key_rejected",
						`SSH host key rejected for profile ${context.profile.profileName}`,
					);
				} else {
					live.audit.state(
						"ssh_handshake",
						"host_key_accepted",
						"SSH host key was accepted by the user",
					);
				}
				break;
			case "input": {
				const bytes = new TextEncoder().encode(message.data);
				live.commandCapture.feed(bytes);
				await live.engine.input(bytes);
				break;
			}
			case "resize":
				await live.engine.resize(message.columns, message.rows);
				break;
			case "disconnect":
				await this.closeSocket(socket, 1000, "User disconnected", {
					finalState: "closed",
					closeReason: "user_disconnect",
					message: "SSH session disconnected by the user",
				});
				break;
			case "activity":
				live.metricsActivity = {
					active: message.active,
					visible: message.visible,
					monitoring: message.monitoring,
					reduceWhenHidden: message.reduceWhenHidden,
					refreshIntervalMs: message.refreshIntervalSeconds * 1000,
				};
				this.scheduleMetrics(socket, live, 0);
				break;
			case "shell-history": {
				const entries = await live.engine.readShellHistory(message.limit);
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "shell-history-result",
					requestId: message.requestId,
					sessionId: context.sessionId,
					shell: "bash",
					source: "~/.bash_history",
					entries,
				});
				break;
			}
			case "sftp-list": {
				const entries = await live.engine.listDirectory(message.path);
				if (
					message.cursor !== undefined &&
					!/^\d{1,10}$/.test(message.cursor)
				) {
					throw new ProtocolError(
						"VALIDATION_FAILED",
						"Invalid directory cursor",
						false,
					);
				}
				const pageStart =
					message.cursor === undefined ? 0 : Number(message.cursor);
				if (
					!Number.isSafeInteger(pageStart) ||
					pageStart < 0 ||
					pageStart > entries.length
				) {
					throw new ProtocolError(
						"VALIDATION_FAILED",
						"Invalid directory cursor",
						false,
					);
				}
				const pageEntries = createDirectoryPage(entries, pageStart);
				const nextOffset = pageStart + pageEntries.length;
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "file-result",
					requestId: message.requestId,
					sessionId: context.sessionId,
					operation: "list",
					path: message.path,
					entries: pageEntries.map(({ type, ...entry }) => ({
						...entry,
						kind: type,
					})),
					nextCursor: nextOffset < entries.length ? String(nextOffset) : null,
				});
				break;
			}
			case "sftp-read": {
				const file = await live.engine.stat(message.path);
				if (file.size > message.maxBytes) {
					throw new ProtocolError(
						"SFTP_FILE_TOO_LARGE",
						`Remote file exceeds the ${message.maxBytes} byte text limit`,
						false,
					);
				}
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "file-result",
					requestId: message.requestId,
					sessionId: context.sessionId,
					operation: "read",
					path: message.path,
					...file,
				});
				await this.startDownload(socket, live, message.requestId, message.path);
				break;
			}
			case "sftp-write":
				await this.assertWriteVersion(
					live,
					message.path,
					message.expectedSize,
					message.expectedModifiedAt,
				);
				await this.startUpload(
					socket,
					live,
					message.requestId,
					message.path,
					message.size,
					"write",
				);
				break;
			case "sftp-upload-start":
				await this.startUpload(
					socket,
					live,
					message.requestId,
					message.path,
					message.size,
					"upload",
				);
				break;
			case "sftp-download-start":
				await this.startDownload(socket, live, message.requestId, message.path);
				break;
			case "sftp-mkdir":
				await live.engine.createDirectory(message.path, message.mode);
				this.sendFileMutation(
					socket,
					live,
					message.requestId,
					"mkdir",
					message.path,
				);
				break;
			case "sftp-rename":
				await live.engine.rename(message.sourcePath, message.destinationPath);
				this.sendFileMutation(
					socket,
					live,
					message.requestId,
					"rename",
					message.sourcePath,
					message.destinationPath,
				);
				break;
			case "sftp-delete":
				await live.engine.deletePath(message.path, message.kind);
				this.sendFileMutation(
					socket,
					live,
					message.requestId,
					"delete",
					message.path,
				);
				break;
			case "sftp-chmod":
				await live.engine.chmod(message.path, message.mode);
				this.sendFileMutation(
					socket,
					live,
					message.requestId,
					"chmod",
					message.path,
				);
				break;
			default:
				throw new ProtocolError(
					"SFTP_NOT_AVAILABLE",
					`${message.type} is not implemented by the basic SFTP engine`,
					false,
				);
		}
	}

	private async handleBinaryFrame(
		socket: WebSocket,
		bytes: Uint8Array,
	): Promise<void> {
		const live = this.sessions.get(socket);
		if (!live)
			throw new ProtocolError("VALIDATION_FAILED", "SSH session is not ready");
		const { header, payload } = decodeBinaryFrame(bytes);
		if (
			header.sessionId !== live.authorization.sessionId ||
			header.attemptId !== live.authorization.attemptId
		) {
			throw new ProtocolError(
				"VALIDATION_FAILED",
				"Binary frame identity mismatch",
			);
		}
		if (header.kind === "terminal-input") {
			live.commandCapture.feed(payload);
			await live.engine.input(payload);
			return;
		}
		if (
			header.kind !== "sftp-upload-chunk" ||
			!header.transferId ||
			header.offset === undefined
		) {
			throw new ProtocolError(
				"VALIDATION_FAILED",
				"Unsupported client binary frame",
			);
		}
		const transfer = live.uploads.get(header.transferId);
		if (!transfer || transfer.offset !== header.offset)
			throw new ProtocolError(
				"VALIDATION_FAILED",
				"Unexpected upload offset",
				false,
			);
		if (transfer.offset + payload.byteLength > transfer.size)
			throw new ProtocolError(
				"VALIDATION_FAILED",
				"Upload exceeds declared size",
				false,
			);
		const done = transfer.offset + payload.byteLength === transfer.size;
		transfer.offset = await live.engine.upload(
			header.transferId,
			transfer.path,
			transfer.offset,
			payload,
			done,
		);
		if (done) {
			live.uploads.delete(header.transferId);
			if (transfer.kind === "write") {
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "file-result",
					requestId: transfer.requestId,
					sessionId: live.authorization.sessionId,
					operation: "write",
					path: transfer.path,
				});
			}
		}
		this.sendTransferProgress(
			socket,
			live,
			header.transferId,
			"upload",
			done ? "completed" : "transferring",
			transfer,
		);
	}

	private async startUpload(
		socket: WebSocket,
		live: LiveSession,
		requestId: string,
		path: string,
		size: number,
		kind: "upload" | "write",
	): Promise<void> {
		const transferId = crypto.randomUUID();
		const transfer: UploadTransfer = {
			requestId,
			path,
			size,
			offset: 0,
			startedAt: Date.now(),
			kind,
		};
		live.uploads.set(transferId, transfer);
		this.sendServer(socket, {
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "transfer-ready",
			requestId,
			sessionId: live.authorization.sessionId,
			transferId,
			direction: "upload",
			path,
			totalBytes: size,
			chunkSize: MAX_TERMINAL_CHUNK_BYTES,
			resumeOffset: 0,
		});
		if (size === 0) {
			await live.engine.upload(transferId, path, 0, new Uint8Array(), true);
			live.uploads.delete(transferId);
			if (kind === "write") {
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "file-result",
					requestId,
					sessionId: live.authorization.sessionId,
					operation: "write",
					path,
				});
			}
			this.sendTransferProgress(
				socket,
				live,
				transferId,
				"upload",
				"completed",
				transfer,
			);
			return;
		}
		this.sendTransferProgress(
			socket,
			live,
			transferId,
			"upload",
			"transferring",
			transfer,
		);
	}

	private async startDownload(
		socket: WebSocket,
		live: LiveSession,
		requestId: string,
		path: string,
	): Promise<void> {
		const transferId = crypto.randomUUID();
		const startedAt = Date.now();
		let sequence = 0;
		let totalBytes = 0;
		const finalOffset = await live.engine.download(path, {
			onStart: (total, offset) => {
				totalBytes = total;
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "transfer-ready",
					requestId,
					sessionId: live.authorization.sessionId,
					transferId,
					direction: "download",
					path,
					totalBytes: total,
					chunkSize: MAX_TERMINAL_CHUNK_BYTES,
					resumeOffset: offset,
				});
			},
			onChunk: async (chunk, offset) => {
				for (
					let cursor = 0;
					cursor < chunk.byteLength;
					cursor += MAX_TERMINAL_CHUNK_BYTES
				) {
					const part = chunk.subarray(
						cursor,
						Math.min(chunk.byteLength, cursor + MAX_TERMINAL_CHUNK_BYTES),
					);
					await this.waitForBackpressure(socket);
					socket.send(
						encodeBinaryFrame(
							{
								protocolVersion: WS_PROTOCOL_VERSION,
								kind: "sftp-download-chunk",
								sessionId: live.authorization.sessionId,
								attemptId: live.authorization.attemptId,
								transferId,
								sequence: sequence++,
								offset: offset + cursor,
								payloadBytes: part.byteLength,
							},
							part,
						),
					);
				}
			},
		});
		const transfer: UploadTransfer = {
			requestId,
			path,
			size: totalBytes,
			offset: finalOffset,
			startedAt,
			kind: "upload",
		};
		this.sendTransferProgress(
			socket,
			live,
			transferId,
			"download",
			"completed",
			transfer,
		);
	}

	private handleEngineEvent(socket: WebSocket, event: SSHEngineEvent): void {
		const live = this.sessions.get(socket);
		if (!live || socket.readyState !== WebSocket.OPEN) return;
		const context = live.authorization;
		if (event.type === "output") {
			for (const command of live.commandCapture.observeOutput(event.data))
				live.audit.command(command);
			for (
				let offset = 0;
				offset < event.data.length;
				offset += MAX_JSON_OUTPUT_CHARS
			) {
				const data = event.data.slice(offset, offset + MAX_JSON_OUTPUT_CHARS);
				if (!data) continue;
				this.sendServer(socket, {
					protocolVersion: WS_PROTOCOL_VERSION,
					type: "output",
					sessionId: context.sessionId,
					attemptId: context.attemptId,
					sequence: live.outputSequence++,
					stream: "stdout",
					data,
				});
			}
			return;
		}
		if (event.type === "banner") {
			if (event.message)
				this.handleEngineEvent(socket, {
					type: "output",
					data: `${event.message}\r\n`,
				});
			return;
		}
		if (event.type === "status") {
			this.sendStatus(
				socket,
				context,
				mapEngineState(event.phase),
				event.message,
				live.requestId,
			);
			if (event.phase === "tcp_connecting") {
				live.audit.state(
					"tcp_connecting",
					"tcp_connecting",
					"Opening the SSH TCP connection",
				);
			} else if (event.phase === "ssh_handshake") {
				live.audit.state(
					"ssh_handshake",
					"ssh_handshake_started",
					"SSH transport handshake started",
				);
			} else if (event.phase.includes("auth")) {
				live.audit.state(
					"authenticating",
					"authentication_started",
					"SSH authentication started",
				);
			} else if (event.phase === "ready") {
				live.audit.connected();
			}
			return;
		}
		if (event.type === "handshake") {
			live.audit.algorithms(
				{
					keyExchange: event.keyExchange,
					hostKeyAlgorithm: event.hostKeyAlgorithm,
					cipherIn: event.cipherIn,
					cipherOut: event.cipherOut,
				},
				event.rekey,
			);
			return;
		}
		if (event.type === "host_key") {
			live.audit.hostKey(event.fingerprint, event.keyType);
			if (event.trusted) {
				live.audit.state(
					"ssh_handshake",
					"host_key_accepted",
					"Stored SSH host key matched",
				);
				return;
			}
			if (event.previousFingerprint) {
				live.audit.security(
					"ssh_host_key_changed",
					`SSH host key changed for profile ${context.profile.profileName}`,
				);
				return;
			}
			live.audit.state(
				"host_confirmation",
				"host_key_confirmation_required",
				"SSH host key confirmation is required",
			);
			this.sendStatus(
				socket,
				context,
				"host_confirmation",
				"SSH host key confirmation is required",
				live.requestId,
			);
			this.sendServer(socket, {
				protocolVersion: WS_PROTOCOL_VERSION,
				type: "host-key",
				sessionId: context.sessionId,
				attemptId: context.attemptId,
				host: context.profile.host,
				port: context.profile.port,
				algorithm: event.keyType,
				fingerprint: event.fingerprint,
				changed: Boolean(event.previousFingerprint),
				previousFingerprint: event.previousFingerprint,
				confirmationExpiresAt: new Date(
					Date.now() + HOST_CONFIRMATION_TIMEOUT_MS,
				).toISOString(),
			});
			return;
		}
		if (event.type === "error") {
			const closure = classifyEngineFailure(event.code, event.message);
			const eventCode =
				closure.closeReason === "authentication_failed"
					? "authentication_failed"
					: closure.closeReason === "host_key_rejected"
						? "host_key_rejected"
						: closure.closeReason === "keepalive_failed"
							? "keepalive_failed"
							: "error";
			live.audit.state("error", eventCode, closure.message);
			if (closure.closeReason === "host_key_rejected") {
				live.audit.security(
					"ssh_host_key_rejected",
					`SSH host key validation failed for profile ${context.profile.profileName}`,
				);
			}
			const code = event.code.includes("HOST_KEY")
				? event.code.includes("MISMATCH")
					? "SSH_HOST_KEY_CHANGED"
					: "SSH_HOST_KEY_REJECTED"
				: "SSH_CONNECTION_FAILED";
			this.sendError(socket, context, code, event.message, true);
			void this.closeSocket(
				socket,
				WEBSOCKET_CLOSE_CODES.SESSION_TERMINATED,
				event.message,
				closure,
			);
			return;
		}
		if (event.type === "closed") {
			this.sendStatus(
				socket,
				context,
				"closed",
				event.reason,
				live.requestId,
				"remote_closed",
			);
			void this.closeSocket(socket, 1000, "SSH session closed", {
				finalState: "closed",
				closeReason: "remote_closed",
				message: event.reason || "SSH server closed the connection",
			});
		}
	}

	private async renewSessionLease(
		socket: WebSocket,
		live: LiveSession,
	): Promise<void> {
		if (this.sessions.get(socket) !== live || live.leaseRenewalInFlight) return;
		live.leaseRenewalInFlight = true;
		try {
			const renewed = await this.updateSessionLease(
				live.authorization.profile.ownerId,
				live.authorization.sessionId,
				"renew",
			);
			if (!renewed.acquired && this.sessions.get(socket) === live) {
				this.sendError(
					socket,
					live.authorization,
					"SERVICE_UNAVAILABLE",
					"SSH session lease expired",
					true,
				);
				await this.closeSocket(
					socket,
					WEBSOCKET_CLOSE_CODES.SESSION_TERMINATED,
					"SSH session lease expired",
					{
						finalState: "error",
						closeReason: "internal_error",
						message: "SSH session lease expired",
					},
				);
				return;
			}
			live.leaseExpiresAt = renewed.expiresAt;
			this.scheduleLeaseRenewal(socket, live, SSH_SESSION_LEASE_RENEW_MS);
		} catch {
			if (this.sessions.get(socket) === live) {
				const remainingMs = live.leaseExpiresAt - Date.now();
				if (remainingMs > 5_000) {
					this.scheduleLeaseRenewal(
						socket,
						live,
						Math.min(5_000, remainingMs - 5_000),
					);
				} else {
					this.sendError(
						socket,
						live.authorization,
						"SERVICE_UNAVAILABLE",
						"Unable to renew the SSH session lease",
						true,
					);
					await this.closeSocket(
						socket,
						WEBSOCKET_CLOSE_CODES.SESSION_TERMINATED,
						"SSH session lease renewal failed",
						{
							finalState: "error",
							closeReason: "internal_error",
							message: "SSH session lease renewal failed",
						},
					);
				}
			}
		} finally {
			live.leaseRenewalInFlight = false;
		}
	}

	private scheduleLeaseRenewal(
		socket: WebSocket,
		live: LiveSession,
		delayMs: number,
	): void {
		if (this.sessions.get(socket) !== live) return;
		if (live.leaseTimer) clearTimeout(live.leaseTimer);
		live.leaseTimer = setTimeout(
			() => void this.renewSessionLease(socket, live),
			Math.max(250, delayMs),
		);
	}

	private metricsInterval(live: LiveSession): number | null {
		if (!live.metricsActivity.monitoring) return null;
		if (
			live.metricsActivity.active &&
			(live.metricsActivity.visible || !live.metricsActivity.reduceWhenHidden)
		) {
			return live.metricsActivity.refreshIntervalMs;
		}
		return Math.max(
			BACKGROUND_METRICS_INTERVAL_MS,
			live.metricsActivity.refreshIntervalMs * 4,
		);
	}

	private scheduleMetrics(
		socket: WebSocket,
		live: LiveSession,
		delayOverride?: number,
	): void {
		if (live.metricsTimer) clearTimeout(live.metricsTimer);
		live.metricsTimer = null;
		const interval = this.metricsInterval(live);
		if (
			interval === null ||
			this.sessions.get(socket) !== live ||
			live.engine.state !== "ready"
		)
			return;
		if (live.metricsInFlight) return;
		live.metricsTimer = setTimeout(() => {
			live.metricsTimer = null;
			void this.collectMetrics(socket, live);
		}, delayOverride ?? interval);
	}

	private async collectMetrics(
		socket: WebSocket,
		live: LiveSession,
	): Promise<void> {
		if (
			this.sessions.get(socket) !== live ||
			live.engine.state !== "ready" ||
			live.metricsInFlight
		)
			return;
		live.metricsInFlight = true;
		try {
			const snapshot = await live.engine.execMetrics();
			if (this.sessions.get(socket) === live)
				this.sendMetrics(socket, live.authorization, snapshot);
		} catch {
			// Monitoring is optional and must not terminate a healthy terminal.
		} finally {
			live.metricsInFlight = false;
			if (this.sessions.get(socket) === live)
				this.scheduleMetrics(socket, live);
		}
	}

	private async assertWriteVersion(
		live: LiveSession,
		path: string,
		expectedSize: number,
		expectedModifiedAt: string,
	): Promise<void> {
		const metadata = await live.engine.stat(path);
		if (
			metadata.size !== expectedSize ||
			metadata.modifiedAt !== expectedModifiedAt
		) {
			throw new ProtocolError(
				"SFTP_CONFLICT",
				"Remote file changed after it was opened",
				false,
			);
		}
	}

	private sendMetrics(
		socket: WebSocket,
		context: TicketAuthorization,
		snapshot: MetricsSnapshot,
	): void {
		const supported = <T>(value: T) => ({
			support: "supported" as const,
			value,
		});
		const unsupported = { support: "unsupported" as const, value: null };
		this.sendServer(socket, {
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "metrics",
			sessionId: context.sessionId,
			sampledAt: snapshot.metrics.updatedAt,
			cpu: supported(snapshot.metrics.cpuPercent),
			memory: supported(snapshot.metrics.memory),
			swap: supported(snapshot.metrics.swap),
			rootDisk: supported(snapshot.metrics.disk),
			processes: supported(snapshot.processes),
			firewall: snapshot.firewall ? supported(snapshot.firewall) : unsupported,
		});
	}

	private sendFileMutation(
		socket: WebSocket,
		live: LiveSession,
		requestId: string,
		operation: "mkdir" | "rename" | "delete" | "chmod",
		path: string,
		destinationPath?: string,
	): void {
		this.sendServer(socket, {
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "file-result",
			requestId,
			sessionId: live.authorization.sessionId,
			operation,
			path,
			destinationPath,
		});
	}

	private sendStatus(
		socket: WebSocket,
		context: TicketAuthorization,
		sessionState:
			| "authorizing"
			| "tcp_connecting"
			| "ssh_handshake"
			| "host_confirmation"
			| "authenticating"
			| "connected"
			| "closed"
			| "error",
		message: string,
		requestId?: string,
		closeReason?: "remote_closed" | "internal_error",
	): void {
		this.sendServer(socket, {
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "status",
			requestId,
			sessionId: context.sessionId,
			attemptId: context.attemptId,
			state: sessionState,
			message: message.slice(0, 512) || "SSH session state changed",
			occurredAt: new Date().toISOString(),
			closeReason,
		});
	}

	private sendTransferProgress(
		socket: WebSocket,
		live: LiveSession,
		transferId: string,
		direction: "upload" | "download",
		status: "transferring" | "completed",
		transfer: UploadTransfer,
	): void {
		const elapsedSeconds = Math.max(
			0.001,
			(Date.now() - transfer.startedAt) / 1_000,
		);
		this.sendServer(socket, {
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "transfer-progress",
			requestId: transfer.requestId,
			sessionId: live.authorization.sessionId,
			transferId,
			direction,
			status,
			path: transfer.path,
			transferredBytes: transfer.offset,
			totalBytes: transfer.size,
			bytesPerSecond: transfer.offset / elapsedSeconds,
			estimatedSecondsRemaining:
				transfer.offset > 0
					? Math.max(
							0,
							(transfer.size - transfer.offset) /
								(transfer.offset / elapsedSeconds),
						)
					: null,
			acknowledgedOffset: transfer.offset,
			updatedAt: new Date().toISOString(),
		});
	}

	private sendError(
		socket: WebSocket,
		context: TicketAuthorization | undefined,
		code: ApiErrorCode,
		message: string,
		fatal: boolean,
		requestId?: string,
	): void {
		if (!context || socket.readyState !== WebSocket.OPEN) return;
		this.sendServer(socket, {
			protocolVersion: WS_PROTOCOL_VERSION,
			type: "error",
			sessionId: context.sessionId,
			...(requestId ? { requestId } : {}),
			code,
			message: message.slice(0, 512) || "SSH operation failed",
			retryable:
				code === "SSH_CONNECTION_FAILED" || code === "SERVICE_UNAVAILABLE",
			fatal,
		});
	}

	private sendServer(
		socket: WebSocket,
		message: ServerWebSocketMessage | Record<string, unknown>,
	): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		const context =
			this.sessions.get(socket)?.authorization ??
			this.authorizations.get(socket);
		const identified = context
			? {
					...message,
					sessionId: context.sessionId,
					attemptId: context.attemptId,
				}
			: message;
		const parsed = ServerWebSocketMessageSchema.safeParse(identified);
		if (!parsed.success)
			throw new Error("Attempted to send an invalid server WebSocket message");
		socket.send(JSON.stringify(parsed.data));
	}

	private async waitForBackpressure(socket: WebSocket): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
			if (socket.readyState !== WebSocket.OPEN || Date.now() >= deadline)
				throw new Error("WebSocket backpressure limit exceeded");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	private async closeSocket(
		socket: WebSocket,
		code: number,
		reason: string,
		closure: SessionClosure = {
			finalState: "error",
			closeReason: "internal_error",
			message: reason,
		},
	): Promise<void> {
		await this.cleanup(socket, closure);
		try {
			socket.close(code, reason.slice(0, 123));
		} catch {
			/* already closed */
		}
	}

	private async cleanup(
		socket: WebSocket,
		closure: SessionClosure,
	): Promise<void> {
		this.clearDeadline(socket);
		this.startingSockets.delete(socket);
		this.authorizations.delete(socket);
		const live = this.sessions.get(socket);
		this.sessions.delete(socket);
		if (!live) return;
		if (live.metricsTimer) clearTimeout(live.metricsTimer);
		if (live.leaseTimer) clearTimeout(live.leaseTimer);
		live.metricsTimer = null;
		live.metricsInFlight = false;
		live.leaseTimer = null;
		live.uploads.clear();
		live.commandCapture.reset();
		await Promise.allSettled([
			live.engine.close(closure.message),
			this.releaseSessionLease(
				live.authorization.profile.ownerId,
				live.authorization.sessionId,
			),
			live.audit.finish(
				closure.finalState,
				closure.closeReason,
				closure.message,
			),
		]);
	}

	private async updateSessionLease(
		ownerId: string,
		sessionId: string,
		operation: "acquire" | "renew",
		maximum?: number,
	): Promise<{ acquired: boolean; expiresAt: number }> {
		const secret = this.env.SESSION_HMAC_KEY?.trim();
		if (!secret)
			throw new Error(
				"SESSION_HMAC_KEY is required for SSH session coordination",
			);
		const id = this.env.SSH_SESSION_REGISTRY.idFromName(ownerId);
		const response = await this.env.SSH_SESSION_REGISTRY.get(id).fetch(
			`https://ssh-registry.internal/${operation}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-internal-auth": secret,
				},
				body: JSON.stringify({
					sessionId,
					...(maximum === undefined ? {} : { maximum }),
				}),
			},
		);
		if (response.status === 409) return { acquired: false, expiresAt: 0 };
		if (!response.ok)
			throw new Error(
				`SSH session registry ${operation} failed with status ${response.status}`,
			);
		const result = await response.json<{
			acquired?: unknown;
			expiresAt?: unknown;
		}>();
		if (
			result.acquired !== true ||
			typeof result.expiresAt !== "number" ||
			!Number.isFinite(result.expiresAt)
		) {
			throw new Error(
				`SSH session registry ${operation} returned an invalid lease`,
			);
		}
		return { acquired: true, expiresAt: result.expiresAt };
	}

	private async releaseSessionLease(
		ownerId: string,
		sessionId: string,
	): Promise<void> {
		const secret = this.env.SESSION_HMAC_KEY?.trim();
		if (!secret) return;
		const id = this.env.SSH_SESSION_REGISTRY.idFromName(ownerId);
		const response = await this.env.SSH_SESSION_REGISTRY.get(id).fetch(
			"https://ssh-registry.internal/release",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-internal-auth": secret,
				},
				body: JSON.stringify({ sessionId }),
			},
		);
		if (!response.ok)
			throw new Error(
				`SSH session registry release failed with status ${response.status}`,
			);
	}

	private async recordSecurityEvent(
		ownerId: string,
		code: string,
		message: string,
	): Promise<void> {
		try {
			await createRepositories(this.env).securityEvents.append({
				ownerId,
				code,
				sourceIpHash: null,
				message,
			});
		} catch (error) {
			console.error("SSH security event write failed", asError(error).message);
		}
	}

	private async recoverRestartedSocket(socket: WebSocket): Promise<void> {
		try {
			const attachment = socket.deserializeAttachment() as Attachment | null;
			if (attachment?.phase !== "waiting" && attachment?.sessionId) {
				const row = await this.env.DB.prepare(
					"SELECT owner_id FROM connection_sessions WHERE id = ? AND status NOT IN ('closed', 'error') LIMIT 1",
				)
					.bind(attachment.sessionId)
					.first<RecoveredSessionRow>();
				if (row) {
					const repositories = createRepositories(this.env);
					const finalize = (async () => {
						try {
							await repositories.sessionEvents.append(
								row.owner_id,
								attachment.sessionId,
								"error",
								"Worker restarted while the SSH session was active",
							);
						} finally {
							await repositories.connectionSessions.finish(
								row.owner_id,
								attachment.sessionId,
								{
									finalState: "error",
									closeReason: "worker_restart",
								},
							);
						}
					})();
					await Promise.allSettled([finalize]);
				}
				const ownerId = row?.owner_id ?? attachment.ownerId;
				if (ownerId) {
					await this.releaseSessionLease(ownerId, attachment.sessionId).catch(
						() => undefined,
					);
				}
			}
		} catch (error) {
			console.error("SSH restart recovery failed", asError(error).message);
		} finally {
			try {
				socket.close(1012, "Worker restarted; reconnect required");
			} catch {
				/* already closed */
			}
		}
	}

	private clearDeadline(socket: WebSocket): void {
		const timeout = this.deadlines.get(socket);
		if (timeout) clearTimeout(timeout);
		this.deadlines.delete(socket);
	}
}

export class D1SSHProfileRepository implements SSHProfileRepository {
	constructor(private readonly env: Env) {}

	async resolve(
		ownerId: string,
		profileId: string,
		ephemeral?: EphemeralSSHCredential,
	): Promise<SSHConnectionProfile> {
		const [row, settings] = await Promise.all([
			this.env.DB.prepare(`
      SELECT id, owner_id, name, host, port, username, auth_kind, credential_persistence, collect_history,
             tailscale_ssh,
             password_ciphertext, password_iv, password_version,
             private_key_ciphertext, private_key_iv, private_key_version,
             passphrase_ciphertext, passphrase_iv, passphrase_version
      FROM profiles WHERE id = ? AND owner_id = ? LIMIT 1
      `)
				.bind(profileId, ownerId)
				.first<ProfileRow>(),
			this.env.DB.prepare(
				"SELECT collect_commands FROM settings WHERE owner_id = ? LIMIT 1",
			)
				.bind(ownerId)
				.first<SettingsRow>(),
		]);
		if (!row) throw new Error("SSH profile was not found");

		const tailscaleSsh = row.tailscale_ssh === 1;
		if (
			!tailscaleSsh &&
			row.credential_persistence === "prompt" &&
			!ephemeral
		) {
			throw new Error("This SSH profile requires an ephemeral credential");
		}

		let authentication: SSHConnectionProfile["authentication"];
		if (tailscaleSsh) {
			const config = getRuntimeConfig(this.env);
			if (config.sshTransport !== "tailnet_connector") {
				throw new Error(
					"Tailscale SSH profiles require tailnet_connector transport",
				);
			}
			if (row.port !== 22)
				throw new Error("Tailscale SSH profiles must use port 22");
			if (ephemeral)
				throw new Error("Tailscale SSH profiles do not accept SSH credentials");
			authentication = { kind: "tailscale-ssh" };
		} else if (ephemeral?.method === "password") {
			authentication = { kind: "password", password: ephemeral.password };
		} else if (ephemeral?.method === "private_key") {
			authentication = {
				kind: "private-key",
				privateKey: ephemeral.privateKey,
				passphrase: ephemeral.passphrase,
			};
		} else if (row.auth_kind === "password") {
			authentication = {
				kind: "password",
				password: await decryptProfileField(
					this.env,
					row,
					"password",
					ownerId,
					profileId,
				),
			};
		} else if (row.auth_kind === "private_key") {
			const privateKey = await decryptProfileField(
				this.env,
				row,
				"privateKey",
				ownerId,
				profileId,
			);
			const passphrase = hasEnvelope(row, "passphrase")
				? await decryptProfileField(
						this.env,
						row,
						"passphrase",
						ownerId,
						profileId,
					)
				: undefined;
			authentication = { kind: "private-key", privateKey, passphrase };
		} else {
			throw new Error("This SSH profile requires an ephemeral credential");
		}

		return {
			ownerId,
			profileId,
			profileName: row.name,
			host: row.host,
			port: row.port,
			username: row.username,
			authentication,
			collectHistory: row.collect_history === 1,
			collectCommands: settings?.collect_commands !== 0,
		};
	}
}

class D1HostKeyRepository implements HostKeyRepository {
	constructor(private readonly database: D1Database) {}

	async get(reference: HostKeyReference): Promise<HostKeyRecord | null> {
		const row = await this.database
			.prepare(`
      SELECT kh.fingerprint, kh.key_type, kh.key_blob, kh.first_seen_at
      FROM known_hosts kh
      JOIN profiles p ON p.id = kh.profile_id
      WHERE kh.profile_id = ? AND p.owner_id = ? AND kh.host = ? AND kh.port = ? AND kh.replaced_at IS NULL
      LIMIT 1
    `)
			.bind(
				reference.profileId,
				reference.ownerId,
				reference.host,
				reference.port,
			)
			.first<KnownHostRow>();
		return row
			? {
					...reference,
					fingerprint: row.fingerprint,
					keyType: row.key_type,
					keyBlob: row.key_blob,
					pinnedAt: row.first_seen_at,
				}
			: null;
	}

	async pinIfAbsent(record: HostKeyRecord): Promise<HostKeyRecord> {
		const now = new Date().toISOString();
		await this.database
			.prepare(`
      INSERT INTO known_hosts (id, profile_id, host, port, key_type, fingerprint, key_blob, first_seen_at, last_seen_at)
      SELECT ?, p.id, ?, ?, ?, ?, ?, ?, ? FROM profiles p WHERE p.id = ? AND p.owner_id = ?
      ON CONFLICT(profile_id, host, port) DO UPDATE SET last_seen_at = excluded.last_seen_at
      WHERE known_hosts.fingerprint = excluded.fingerprint AND known_hosts.replaced_at IS NULL
    `)
			.bind(
				crypto.randomUUID(),
				record.host,
				record.port,
				record.keyType,
				record.fingerprint,
				record.keyBlob,
				now,
				now,
				record.profileId,
				record.ownerId,
			)
			.run();
		const pinned = await this.get(record);
		if (!pinned) throw new Error("Unable to persist the SSH host key");
		if (pinned.fingerprint === record.fingerprint) {
			await this.database
				.prepare(`
        UPDATE profiles SET last_host_fingerprint = ?, updated_at = ? WHERE id = ? AND owner_id = ?
      `)
				.bind(record.fingerprint, now, record.profileId, record.ownerId)
				.run();
		}
		return pinned;
	}
}

interface ProfileRow {
	id: string;
	owner_id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	auth_kind: string;
	tailscale_ssh: number;
	credential_persistence: "saved" | "prompt";
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
}

interface SettingsRow {
	collect_commands: number;
}

interface KnownHostRow {
	fingerprint: string;
	key_type: string;
	key_blob: string;
	first_seen_at: string;
}

interface RecoveredSessionRow {
	owner_id: string;
}

class ProtocolError extends Error {
	constructor(
		readonly code: ApiErrorCode,
		message: string,
		readonly fatal = true,
		readonly closeCode: number = WEBSOCKET_CLOSE_CODES.MESSAGE_INVALID,
	) {
		super(message);
	}
}

function hasEnvelope(
	row: ProfileRow,
	field: "password" | "privateKey" | "passphrase",
): boolean {
	const prefix = field === "privateKey" ? "private_key" : field;
	return (
		row[`${prefix}_ciphertext` as keyof ProfileRow] !== null &&
		row[`${prefix}_iv` as keyof ProfileRow] !== null &&
		row[`${prefix}_version` as keyof ProfileRow] !== null
	);
}

async function decryptProfileField(
	env: Env,
	row: ProfileRow,
	field: "password" | "privateKey" | "passphrase",
	ownerId: string,
	profileId: string,
): Promise<string> {
	const prefix = field === "privateKey" ? "private_key" : field;
	const ciphertext = row[`${prefix}_ciphertext` as keyof ProfileRow];
	const iv = row[`${prefix}_iv` as keyof ProfileRow];
	const version = row[`${prefix}_version` as keyof ProfileRow];
	if (
		typeof ciphertext !== "string" ||
		typeof iv !== "string" ||
		version !== 1
	) {
		throw new Error(`SSH profile ${field} credential is missing`);
	}
	return decryptSecret(
		env.CREDENTIAL_MASTER_KEY,
		{ version, iv, ciphertext } as EncryptedEnvelope,
		{
			ownerId,
			recordId: profileId,
			field,
		},
	);
}

function toEphemeralCredential(
	value: EphemeralCredential | undefined,
): EphemeralSSHCredential | undefined {
	if (!value) return undefined;
	return value.method === "password"
		? { method: "password", password: value.password }
		: {
				method: "private_key",
				privateKey: value.privateKey,
				passphrase: value.passphrase,
			};
}

async function sealProfile(
	keyBytes: Uint8Array,
	profile: SSHConnectionProfile,
	additionalData: Uint8Array,
): Promise<TicketEnvelope> {
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(keyBytes),
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify(profile));
	try {
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{
					name: "AES-GCM",
					iv: toArrayBuffer(iv),
					additionalData: toArrayBuffer(additionalData),
					tagLength: 128,
				},
				key,
				toArrayBuffer(plaintext),
			),
		);
		return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) };
	} finally {
		plaintext.fill(0);
	}
}

async function openProfile(
	keyBytes: Uint8Array,
	envelope: TicketEnvelope,
	additionalData: Uint8Array,
): Promise<SSHConnectionProfile> {
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(keyBytes),
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const iv = decodeBase64Url(envelope.iv);
	const ciphertext = decodeBase64Url(envelope.ciphertext);
	const plaintext = new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: toArrayBuffer(iv),
				additionalData: toArrayBuffer(additionalData),
				tagLength: 128,
			},
			key,
			toArrayBuffer(ciphertext),
		),
	);
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
		) as SSHConnectionProfile;
	} finally {
		plaintext.fill(0);
	}
}

function ticketAdditionalData(
	sessionId: string,
	attemptId: string,
	expiresAt: number,
	origin: string,
): Uint8Array {
	return new TextEncoder().encode(
		`edgesh-ticket-v1:${sessionId}:${attemptId}:${expiresAt}:${origin}`,
	);
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
	return encodeBase64Url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(value))),
	);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
	return Uint8Array.from(value).buffer;
}

function parseVerifiedOrigin(value: string | null): string | null {
	if (!value || value.length > 512) return null;
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) && url.origin === value
			? value
			: null;
	} catch {
		return null;
	}
}

function constantTimeTextEqual(left: string, right: string): boolean {
	if (!left || !right) return false;
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	const length = Math.max(leftBytes.length, rightBytes.length);
	let difference = leftBytes.length ^ rightBytes.length;
	for (let index = 0; index < length; index += 1)
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	return difference === 0;
}

function decodeBinaryFrame(bytes: Uint8Array): {
	header: BinaryFrameHeader;
	payload: Uint8Array;
} {
	if (bytes.byteLength < 5)
		throw new ProtocolError("VALIDATION_FAILED", "Binary frame is truncated");
	const headerBytes = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(0);
	if (
		headerBytes < 2 ||
		headerBytes > 16 * 1024 ||
		4 + headerBytes >= bytes.byteLength
	) {
		throw new ProtocolError(
			"VALIDATION_FAILED",
			"Binary frame header is invalid",
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(4, 4 + headerBytes),
			),
		);
	} catch {
		throw new ProtocolError(
			"VALIDATION_FAILED",
			"Binary frame header is invalid",
		);
	}
	const result = BinaryFrameHeaderSchema.safeParse(decoded);
	if (!result.success)
		throw new ProtocolError(
			"VALIDATION_FAILED",
			"Binary frame header is invalid",
		);
	const payload = bytes.subarray(4 + headerBytes);
	if (payload.byteLength !== result.data.payloadBytes)
		throw new ProtocolError(
			"VALIDATION_FAILED",
			"Binary frame payload size mismatch",
		);
	return { header: result.data, payload };
}

function encodeBinaryFrame(
	header: BinaryFrameHeader,
	payload: Uint8Array,
): Uint8Array {
	const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
	const frame = new Uint8Array(
		4 + encodedHeader.byteLength + payload.byteLength,
	);
	new DataView(frame.buffer).setUint32(0, encodedHeader.byteLength);
	frame.set(encodedHeader, 4);
	frame.set(payload, 4 + encodedHeader.byteLength);
	return frame;
}

function mapEngineState(
	phase: string,
): "tcp_connecting" | "ssh_handshake" | "authenticating" | "connected" {
	if (phase === "tcp_connecting") return "tcp_connecting";
	if (phase === "ready") return "connected";
	if (phase.includes("auth")) return "authenticating";
	return "ssh_handshake";
}

function createDirectoryPage<T>(entries: T[], offset: number): T[] {
	const page: T[] = [];
	let encodedBytes = 0;
	for (
		let index = offset;
		index < entries.length && page.length < 500;
		index += 1
	) {
		const entry = entries[index];
		if (entry === undefined) break;
		const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
		if (page.length > 0 && encodedBytes + size > 48 * 1024) break;
		page.push(entry);
		encodedBytes += size;
	}
	return page;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function classifyEngineFailure(code: string, message: string): SessionClosure {
	const value = `${code} ${message}`.toLowerCase();
	if (value.includes("host_key") || value.includes("host key")) {
		return {
			finalState: "error",
			closeReason: "host_key_rejected",
			message: "SSH host key validation failed",
		};
	}
	if (value.includes("auth") || value.includes("permission denied")) {
		return {
			finalState: "error",
			closeReason: "authentication_failed",
			message: "SSH authentication failed",
		};
	}
	if (value.includes("keepalive")) {
		return {
			finalState: "error",
			closeReason: "keepalive_failed",
			message: "SSH keepalive failed",
		};
	}
	if (value.includes("timeout") || value.includes("timed out")) {
		return {
			finalState: "error",
			closeReason: "connection_timeout",
			message: "SSH connection timed out",
		};
	}
	return {
		finalState: "error",
		closeReason: "network_error",
		message: "SSH connection failed",
	};
}
