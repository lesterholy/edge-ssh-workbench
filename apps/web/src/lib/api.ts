import type {
	ApiErrorResponse,
	AuthState,
	CommandHistoryResponse,
	GoogleAuthorizationStartResponse,
	LoginRequest,
	ProfileCreateRequest,
	ProfileListResponse,
	ProfileResponse,
	ProfileUpdateRequest,
	Settings,
	SettingsPatchRequest,
	SshTicketRequest,
	SshTicketResponse,
	TotpDisableRequest,
	TotpDisableResponse,
	TotpEnrollmentConfirmRequest,
	TotpEnrollmentConfirmResponse,
	TotpEnrollmentStartResponse,
	TailscaleConfigurationResponse,
	TailscaleConfigurationUpdateRequest,
	TailscaleDeviceListResponse,
	TailscaleImportRequest,
	TailscaleImportResponse,
} from "@edgesh/contracts";

export class ApiError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status: number,
		readonly retryable = false,
	) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(init?.headers);
	if (init?.body && !headers.has("Content-Type"))
		headers.set("Content-Type", "application/json");
	const response = await fetch(path, {
		...init,
		headers,
		credentials: "same-origin",
	});
	if (!response.ok) {
		let payload: ApiErrorResponse | null = null;
		try {
			payload = (await response.json()) as ApiErrorResponse;
		} catch {
			// The status text is used only when a response is not JSON.
		}
		throw new ApiError(
			payload?.error.message ?? response.statusText ?? "Request failed",
			payload?.error.code ?? "INTERNAL_ERROR",
			response.status,
			payload?.error.retryable ?? false,
		);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

export const api = {
	authState: () => request<AuthState>("/api/auth/state"),
	startGoogleLogin: () =>
		request<GoogleAuthorizationStartResponse>("/api/auth/google/start", {
			method: "POST",
		}),
	login: (input: LoginRequest) =>
		request<AuthState>("/api/auth/login", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	logout: () => request<void>("/api/auth/logout", { method: "POST" }),
	startTotpEnrollment: () =>
		request<TotpEnrollmentStartResponse>("/api/auth/totp/setup", {
			method: "POST",
		}),
	confirmTotpEnrollment: (input: TotpEnrollmentConfirmRequest) =>
		request<TotpEnrollmentConfirmResponse>("/api/auth/totp/confirm", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	disableTotp: (input: TotpDisableRequest) =>
		request<TotpDisableResponse>("/api/auth/totp", {
			method: "DELETE",
			body: JSON.stringify(input),
		}),
	profiles: () => request<ProfileListResponse>("/api/profiles?limit=100"),
	createProfile: (input: ProfileCreateRequest) =>
		request<ProfileResponse>("/api/profiles", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	updateProfile: (id: string, input: ProfileUpdateRequest) =>
		request<ProfileResponse>(`/api/profiles/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	deleteProfile: (id: string) =>
		request<void>(`/api/profiles/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	settings: () => request<Settings>("/api/settings"),
	updateSettings: (input: SettingsPatchRequest) =>
		request<Settings>("/api/settings", {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	createTicket: (input: SshTicketRequest) =>
		request<SshTicketResponse>("/api/ssh/tickets", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	commandHistory: (query = "") =>
		request<CommandHistoryResponse>(
			`/api/history/commands?limit=50${query ? `&query=${encodeURIComponent(query)}` : ""}`,
		),
	clearCommandHistory: () =>
		request<void>("/api/history/commands", {
			method: "DELETE",
			body: JSON.stringify({}),
		}),
	tailscaleConfiguration: () =>
		request<TailscaleConfigurationResponse>("/api/tailscale/configuration"),
	updateTailscaleConfiguration: (input: TailscaleConfigurationUpdateRequest) =>
		request<TailscaleConfigurationResponse>("/api/tailscale/configuration", {
			method: "PUT",
			body: JSON.stringify(input),
		}),
	tailscaleDevices: () =>
		request<TailscaleDeviceListResponse>("/api/tailscale/devices"),
	tailscaleImport: (input: TailscaleImportRequest) =>
		request<TailscaleImportResponse>("/api/tailscale/import", {
			method: "POST",
			body: JSON.stringify(input),
		}),
};
