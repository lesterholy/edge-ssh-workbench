import { SettingsPatchRequestSchema } from "@edgesh/contracts";

import type { Env } from "../env";
import { SettingsRepository } from "../storage/settings";
import { requireAuthentication } from "./auth";
import { methodNotAllowed } from "./errors";
import { parseJson } from "./request";
import { apiJson } from "./response";

export async function routeSettings(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PATCH") {
    return methodNotAllowed(["GET", "PATCH"]);
  }
  const auth = await requireAuthentication(request, env);
  const settings = new SettingsRepository(env.DB);
  if (request.method === "GET") return apiJson(await settings.get(auth.ownerId));
  const patch = await parseJson(request, SettingsPatchRequestSchema, 32 * 1024);
  return apiJson(await settings.update(auth.ownerId, patch));
}
