import {
  EntityIdSchema,
  PageRequestSchema,
  ProfileCreateRequestSchema,
  ProfileUpdateRequestSchema,
  type ProfileUpdateRequest,
} from "@edgesh/contracts";

import type { Env } from "../env";
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

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,6}$/.test(cursor)) throw new HttpError(400, "VALIDATION_FAILED", "Invalid profile cursor");
  return Number(cursor);
}

function needsMasterKeyForUpdate(credential: ProfileUpdateRequest["credential"]): boolean {
  if (!credential) return false;
  const mutations = credential.method === "password"
    ? [credential.password]
    : [credential.privateKey, credential.passphrase];
  return mutations.some((mutation) => mutation.action === "replace");
}

async function listProfiles(request: Request, env: Env, ownerId: string): Promise<Response> {
  const query = parseQuery(new URL(request.url), PageRequestSchema);
  const offset = cursorOffset(query.cursor);
  const requested = Math.min(500, offset + query.limit + 1);
  const profiles = await new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY).list(ownerId, requested);
  const items = profiles.slice(offset, offset + query.limit);
  const hasMore = profiles.length > offset + query.limit;
  return apiJson({
    items,
    page: { nextCursor: hasMore ? String(offset + query.limit) : null, hasMore },
  });
}

async function createProfile(request: Request, env: Env, ownerId: string): Promise<Response> {
  const input = await parseJson(request, ProfileCreateRequestSchema);
  const credential = input.credential;
  const storesSecret = credential.method === "password"
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
  if (input.credential?.persistence === "saved") {
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
