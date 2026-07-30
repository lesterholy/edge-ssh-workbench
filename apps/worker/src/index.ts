import { AuthRateLimiterDO } from "./durable/auth-rate-limiter";
import { SSHSessionDO } from "./durable/ssh-session";
import { SSHSessionRegistryDO } from "./durable/ssh-session-registry";
import type { Env } from "./env";
import { routeRequest } from "./http/router";

export { AuthRateLimiterDO, SSHSessionDO, SSHSessionRegistryDO };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
