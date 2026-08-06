import type {
	AuthenticationMethod,
	CommandCaptureQuality,
	CommandHistoryItem,
	SessionCloseReason,
	SessionEvent,
	SessionEventCode,
	SessionHistoryItem,
	SessionState,
} from "@edgesh/contracts";

import { createId, escapeLike, nowIso } from "./internal";
import { decodeTimeCursor, encodeTimeCursor } from "./pagination";

const MAX_COMMAND_HISTORY = 100_000;

interface CommandRow {
	id: string;
	session_id: string;
	profile_id: string | null;
	profile_name_snapshot: string;
	host_snapshot: string;
	username_snapshot: string;
	command_redacted: string;
	capture_kind: CommandCaptureQuality;
	created_at: string;
}

function toCommand(row: CommandRow): CommandHistoryItem {
	return {
		id: row.id,
		sessionId: row.session_id,
		profileId: row.profile_id,
		profileName: row.profile_name_snapshot,
		host: row.host_snapshot,
		username: row.username_snapshot,
		command: row.command_redacted,
		captureQuality: row.capture_kind,
		executedAt: row.created_at,
	};
}

const SECRET_ASSIGNMENT =
	/\b(password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|authorization)\s*(=|:)\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG =
	/(--(?:password|passphrase|token|secret|api-key|access-key)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;

export function redactCommand(command: string): string {
	const trimmed = command.trim().slice(0, 8192);
	if (!trimmed) throw new Error("Command is empty");
	if (
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(trimmed) ||
		/\b(?:sshpass|set-password)\b/i.test(trimmed) ||
		/\bmysql\b[^\n]*\s-p\S+/i.test(trimmed)
	) {
		return "[REDACTED]";
	}
	return trimmed
		.replace(
			SECRET_ASSIGNMENT,
			(_match, name: string, separator: string) =>
				`${name}${separator}[REDACTED]`,
		)
		.replace(SECRET_FLAG, "$1[REDACTED]")
		.replace(/(\bcurl\b[^\n]*?(?:-u|--user)(?:=|\s+))\S+/gi, "$1[REDACTED]")
		.replace(
			/(\bAuthorization\s*:\s*)(?:Bearer|Basic)\s+\S+/gi,
			"$1[REDACTED]",
		);
}

export interface AppendCommandInput {
	sessionId: string;
	profileId: string | null;
	profileName: string;
	host: string;
	username: string;
	command: string;
	captureQuality: CommandCaptureQuality;
	executedAt?: string;
}

export interface CommandHistoryQuery {
	cursor?: string;
	limit?: number;
	query?: string;
	profileId?: string;
	sessionId?: string;
	from?: string;
	to?: string;
}

export interface PageResult<T> {
	items: T[];
	nextCursor: string | null;
	hasMore: boolean;
}

export class CommandHistoryRepository {
	constructor(private readonly db: D1Database) {}

	async append(
		ownerId: string,
		input: AppendCommandInput,
	): Promise<CommandHistoryItem> {
		const id = createId("cmd");
		const executedAt = input.executedAt ?? nowIso();
		const command = redactCommand(input.command);
		const result = await this.db
			.prepare(
				`INSERT INTO command_history (id, owner_id, session_id, profile_id, profile_name_snapshot,
        host_snapshot, username_snapshot, command_redacted, capture_kind, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM connection_sessions WHERE id = ? AND owner_id = ?)`,
			)
			.bind(
				id,
				ownerId,
				input.sessionId,
				input.profileId,
				input.profileName,
				input.host,
				input.username,
				command,
				input.captureQuality,
				executedAt,
				input.sessionId,
				ownerId,
			)
			.run();
		if (result.meta.changes !== 1)
			throw new Error("Connection session not found");
		return {
			id,
			sessionId: input.sessionId,
			profileId: input.profileId,
			profileName: input.profileName,
			host: input.host,
			username: input.username,
			command,
			captureQuality: input.captureQuality,
			executedAt,
		};
	}

	async list(
		ownerId: string,
		query: CommandHistoryQuery = {},
	): Promise<PageResult<CommandHistoryItem>> {
		const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 100);
		const cursor = decodeTimeCursor(query.cursor);
		const clauses = ["owner_id = ?"];
		const bindings: unknown[] = [ownerId];
		if (query.profileId) {
			clauses.push("profile_id = ?");
			bindings.push(query.profileId);
		}
		if (query.sessionId) {
			clauses.push("session_id = ?");
			bindings.push(query.sessionId);
		}
		if (query.query) {
			clauses.push("command_redacted LIKE ? ESCAPE '\\'");
			bindings.push(`%${escapeLike(query.query)}%`);
		}
		if (query.from) {
			clauses.push("created_at >= ?");
			bindings.push(query.from);
		}
		if (query.to) {
			clauses.push("created_at <= ?");
			bindings.push(query.to);
		}
		if (cursor) {
			clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
			bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
		}
		const result = await this.db
			.prepare(
				`SELECT * FROM command_history WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
			.bind(...bindings, limit + 1)
			.all<CommandRow>();
		const hasMore = result.results.length > limit;
		const rows = result.results.slice(0, limit);
		const last = rows[rows.length - 1];
		return {
			items: rows.map(toCommand),
			hasMore,
			nextCursor:
				hasMore && last
					? encodeTimeCursor({ createdAt: last.created_at, id: last.id })
					: null,
		};
	}

	async clear(
		ownerId: string,
		options: { before?: string; profileId?: string; sessionId?: string } = {},
	): Promise<number> {
		const clauses = ["owner_id = ?"];
		const bindings: unknown[] = [ownerId];
		if (options.before) {
			clauses.push("created_at < ?");
			bindings.push(options.before);
		}
		if (options.profileId) {
			clauses.push("profile_id = ?");
			bindings.push(options.profileId);
		}
		if (options.sessionId) {
			clauses.push("session_id = ?");
			bindings.push(options.sessionId);
		}
		const result = await this.db
			.prepare(`DELETE FROM command_history WHERE ${clauses.join(" AND ")}`)
			.bind(...bindings)
			.run();
		return result.meta.changes;
	}

	async prune(ownerId: string, batchSize = 500): Promise<number> {
		const bounded = Math.min(Math.max(Math.trunc(batchSize), 1), 1000);
		const result = await this.db
			.prepare(
				`DELETE FROM command_history WHERE id IN (
        SELECT id FROM command_history WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
       )`,
			)
			.bind(ownerId, bounded, MAX_COMMAND_HISTORY)
			.run();
		return result.meta.changes;
	}
}

interface SessionRow {
	id: string;
	profile_id: string | null;
	profile_name_snapshot: string;
	target_host: string;
	target_port: number;
	target_username: string;
	auth_kind: AuthenticationMethod;
	tailscale_ssh: number;
	started_at: string;
	connected_at: string | null;
	closed_at: string | null;
	status: SessionState;
	close_code: SessionCloseReason | null;
}

function toSession(row: SessionRow): SessionHistoryItem {
	return {
		id: row.id,
		profileId: row.profile_id,
		profileName: row.profile_name_snapshot,
		host: row.target_host,
		port: row.target_port,
		username: row.target_username,
		authenticationMethod:
			row.tailscale_ssh === 1 ? "tailscale_ssh" : row.auth_kind,
		startedAt: row.started_at,
		connectedAt: row.connected_at,
		endedAt: row.closed_at,
		finalState: row.status,
		closeReason: row.close_code,
	};
}

export interface StartConnectionSessionInput {
	id?: string;
	profileId: string | null;
	profileName: string;
	host: string;
	port: number;
	username: string;
	authenticationMethod: AuthenticationMethod;
	startedAt?: string;
}

export interface FinishConnectionSessionInput {
	finalState: SessionState;
	closeReason?: SessionCloseReason | null;
	connectedAt?: string | null;
	endedAt?: string;
	hostKeyType?: string | null;
	hostFingerprint?: string | null;
	kexAlgorithm?: string | null;
	cipherIn?: string | null;
	cipherOut?: string | null;
}

export class ConnectionSessionRepository {
	constructor(private readonly db: D1Database) {}

	async start(
		ownerId: string,
		input: StartConnectionSessionInput,
	): Promise<SessionHistoryItem> {
		const id = input.id ?? createId("ses");
		const startedAt = input.startedAt ?? nowIso();
		const tailscaleSsh = input.authenticationMethod === "tailscale_ssh";
		const storedAuthKind = tailscaleSsh
			? "password"
			: input.authenticationMethod;
		await this.db
			.prepare(
				`INSERT INTO connection_sessions (id, owner_id, profile_id, status, target_host, target_port,
        target_username, profile_name_snapshot, auth_kind, tailscale_ssh, started_at, created_at)
       VALUES (?, ?, ?, 'authorizing', ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				ownerId,
				input.profileId,
				input.host,
				input.port,
				input.username,
				input.profileName,
				storedAuthKind,
				tailscaleSsh ? 1 : 0,
				startedAt,
				startedAt,
			)
			.run();
		return {
			id,
			profileId: input.profileId,
			profileName: input.profileName,
			host: input.host,
			port: input.port,
			username: input.username,
			authenticationMethod: input.authenticationMethod,
			startedAt,
			connectedAt: null,
			endedAt: null,
			finalState: "authorizing",
			closeReason: null,
		};
	}

	async setState(
		ownerId: string,
		sessionId: string,
		state: SessionState,
		connectedAt?: string,
	): Promise<void> {
		await this.db
			.prepare(
				"UPDATE connection_sessions SET status = ?, connected_at = COALESCE(connected_at, ?) WHERE id = ? AND owner_id = ?",
			)
			.bind(state, connectedAt ?? null, sessionId, ownerId)
			.run();
	}

	async finish(
		ownerId: string,
		sessionId: string,
		input: FinishConnectionSessionInput,
	): Promise<void> {
		const endedAt = input.endedAt ?? nowIso();
		await this.db
			.prepare(
				`UPDATE connection_sessions SET status = ?, close_code = ?, connected_at = COALESCE(connected_at, ?),
        closed_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
        host_key_type = ?, host_fingerprint = ?, kex_algorithm = ?, cipher_in = ?, cipher_out = ?
       WHERE id = ? AND owner_id = ?`,
			)
			.bind(
				input.finalState,
				input.closeReason ?? null,
				input.connectedAt ?? null,
				endedAt,
				endedAt,
				input.hostKeyType ?? null,
				input.hostFingerprint ?? null,
				input.kexAlgorithm ?? null,
				input.cipherIn ?? null,
				input.cipherOut ?? null,
				sessionId,
				ownerId,
			)
			.run();
	}

	async list(
		ownerId: string,
		query: {
			cursor?: string;
			limit?: number;
			profileId?: string;
			state?: SessionState;
		} = {},
	): Promise<PageResult<SessionHistoryItem>> {
		const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 100);
		const cursor = decodeTimeCursor(query.cursor);
		const clauses = ["owner_id = ?"];
		const bindings: unknown[] = [ownerId];
		if (query.profileId) {
			clauses.push("profile_id = ?");
			bindings.push(query.profileId);
		}
		if (query.state) {
			clauses.push("status = ?");
			bindings.push(query.state);
		}
		if (cursor) {
			clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
			bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
		}
		const result = await this.db
			.prepare(
				`SELECT * FROM connection_sessions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
			.bind(...bindings, limit + 1)
			.all<SessionRow>();
		const hasMore = result.results.length > limit;
		const rows = result.results.slice(0, limit);
		const last = rows[rows.length - 1];
		return {
			items: rows.map(toSession),
			hasMore,
			nextCursor:
				hasMore && last
					? encodeTimeCursor({ createdAt: last.started_at, id: last.id })
					: null,
		};
	}
}

interface EventRow {
	id: string;
	session_id: string;
	event_code: SessionEventCode;
	message_safe: string;
	created_at: string;
}

function safeEventMessage(message: string): string {
	const value = message.trim().slice(0, 512);
	if (!value) throw new Error("Session event message is empty");
	return value.replace(
		SECRET_ASSIGNMENT,
		(_match, name: string, separator: string) =>
			`${name}${separator}[REDACTED]`,
	);
}

export class SessionEventRepository {
	constructor(private readonly db: D1Database) {}

	async append(
		ownerId: string,
		sessionId: string,
		code: SessionEventCode,
		message: string,
	): Promise<SessionEvent> {
		const event: SessionEvent = {
			id: createId("evt"),
			sessionId,
			code,
			message: safeEventMessage(message),
			createdAt: nowIso(),
		};
		const result = await this.db
			.prepare(
				`INSERT INTO session_events (id, owner_id, session_id, event_code, message_safe, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM connection_sessions WHERE id = ? AND owner_id = ?
       )`,
			)
			.bind(
				event.id,
				ownerId,
				sessionId,
				code,
				event.message,
				event.createdAt,
				sessionId,
				ownerId,
			)
			.run();
		if (result.meta.changes !== 1)
			throw new Error("Connection session not found");
		return event;
	}

	async list(
		ownerId: string,
		sessionId: string,
		limit = 500,
	): Promise<SessionEvent[]> {
		const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
		const result = await this.db
			.prepare(
				"SELECT id, session_id, event_code, message_safe, created_at FROM session_events WHERE owner_id = ? AND session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?",
			)
			.bind(ownerId, sessionId, bounded)
			.all<EventRow>();
		return result.results.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			code: row.event_code,
			message: row.message_safe,
			createdAt: row.created_at,
		}));
	}
}
