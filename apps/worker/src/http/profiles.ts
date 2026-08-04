import {
  EntityIdSchema,
  PageRequestSchema,
  ProfileCreateRequestSchema,
  ProfileUpdateRequestSchema,
  type ProfileUpdateRequest,
} from "@edgesh/contracts";

import type { Env } from "../env";
import { getRuntimeConfig } from "../env";
import { assertAllowedSshPort } from "../security/network";
import { ProfileRepository } from "../storage/profiles";
import { requireAuthentication } from "./auth";
import { HttpError, methodNotAllowed } from "./errors";
import { parseJson, parseQuery } from "./request";
import { apiJson } from "./response";

function parseProfileId(value: string): string {
  const decoded = decodeURIComponent(value);
  const result = EntityIdSchema.safeParse(decoded);
  if (!result.success) throw new HttpError(400, "VALIDATION_FAILED", "Invalid profile identifier");
  return result.data;
}

function needsMasterKeyForUpdate(credential: ProfileUpdateRequest["credential"]): boolean {
  if (!credential || credential.method === "tailscale_ssh") return false;
  const mutations = credential.method === "password"
    ? [credential.password]
    : [credential.privateKey, credential.passphrase];
  return mutations.some((mutation) => mutation.action === "replace");
}

function assertTailscaleSshProfile(env: Env, method: string, port: number): void {
  if (method !== "tailscale_ssh") return;
  if (env.SSH_TRANSPORT?.trim() !== "tailnet_connector") {
    throw new HttpError(400, "VALIDATION_FAILED", "Tailscale SSH profiles require tailnet_connector transport");
  }
  if (port !== 22) {
    throw new HttpError(400, "VALIDATION_FAILED", "Tailscale SSH profiles must use port 22");
  }
}

async function listProfiles(request: Request, env: Env, ownerId: string): Promise<Response> {
  const query = parseQuery(new URL(request.url), PageRequestSchema);
  try {
    const page = await new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY)
      .listPage(ownerId, query.limit, query.cursor);
    return apiJson({
      items: page.items,
      page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid pagination cursor") {
      throw new HttpError(400, "VALIDATION_FAILED", "Invalid profile cursor");
    }
    throw error;
  }
}

async function createProfile(request: Request, env: Env, ownerId: string): Promise<Response> {
  const input = await parseJson(request, ProfileCreateRequestSchema);
  const credential = input.credential;
  assertTailscaleSshProfile(env, credential.method, input.port);
  assertAllowedSshPort(input.port, getRuntimeConfig(env).allowedSshPorts);
  const storesSecret = credential.method === "tailscale_ssh" ? false
    : credential.method === "password"
      ? credential.persistence === "saved"
      : credential.persistence === "saved" || credential.savePassphrase;
  if (storesSecret && !env.CREDENTIAL_MASTER_KEY) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Credential encryption is not configured");
  }
  const repository = new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY);
  const profile = await repository.createFromRequest(ownerId, input);
  return apiJson(profile, 201);
}

async function getProfile(env: Env, ownerId: string, profileId: string): Promise<Response> {
  const profile = await new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY).get(ownerId, profileId);
  if (!profile) throw new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found");
  return apiJson(profile);
}

async function updateProfile(request: Request, env: Env, ownerId: string, profileId: string): Promise<Response> {
  const input = await parseJson(request, ProfileUpdateRequestSchema);
  if (needsMasterKeyForUpdate(input.credential) && !env.CREDENTIAL_MASTER_KEY) {
    throw new HttpError(503, "AUTH_CONFIGURATION_MISSING", "Credential encryption is not configured");
  }
  const repository = new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY);
  const existing = await repository.get(ownerId, profileId);
  if (!existing) throw new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found");
  const nextMethod = input.credential?.method ?? existing.authenticationMethod;
  const nextPort = input.port ?? existing.port;
  assertTailscaleSshProfile(env, nextMethod, nextPort);
  assertAllowedSshPort(nextPort, getRuntimeConfig(env).allowedSshPorts);
  if (input.credential?.method !== "tailscale_ssh" && input.credential?.persistence === "saved") {
    const secret = input.credential.method === "password"
      ? input.credential.password
      : input.credential.privateKey;
    const alreadyStored = input.credential.method === "password"
      ? existing.hasPassword
      : existing.hasPrivateKey;
    if (secret.action === "clear" || (secret.action === "keep" && !alreadyStored)) {
      throw new HttpError(400, "PROFILE_CREDENTIAL_REQUIRED", "A saved credential is required for this authentication method");
    }
  }
  const profile = await repository.updateFromRequest(ownerId, profileId, input);
  if (!profile) throw new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found");
  return apiJson(profile);
}

async function deleteProfile(env: Env, ownerId: string, profileId: string): Promise<Response> {
  const repository = new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY);
  if (!await repository.get(ownerId, profileId)) {
    throw new HttpError(404, "PROFILE_NOT_FOUND", "Profile not found");
  }
  await repository.delete(ownerId, profileId);
  return apiJson({ deleted: true, id: profileId });
}

export async function routeProfiles(request: Request, env: Env, path: string): Promise<Response> {
  const auth = await requireAuthentication(request, env);
  if (path === "/api/profiles") {
    if (request.method === "GET") return listProfiles(request, env, auth.ownerId);
    if (request.method === "POST") return createProfile(request, env, auth.ownerId);
    return methodNotAllowed(["GET", "POST"]);
  }

  const match = path.match(/^\/api\/profiles\/([^/]+)$/);
  if (!match) throw new HttpError(404, "NOT_FOUND", "Route not found");
  const profileId = parseProfileId(match[1] ?? "");
  if (request.method === "GET") return getProfile(env, auth.ownerId, profileId);
  if (request.method === "PATCH") return updateProfile(request, env, auth.ownerId, profileId);
  if (request.method === "DELETE") return deleteProfile(env, auth.ownerId, profileId);
  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
