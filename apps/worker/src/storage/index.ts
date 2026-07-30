import type { Env } from "../env";

import { AuthSessionRepository } from "./auth-sessions";
import { CommandHistoryRepository, ConnectionSessionRepository, SessionEventRepository } from "./history";
import { KnownHostRepository } from "./known-hosts";
import { OAuthRepository } from "./oauth";
import { ProfileRepository } from "./profiles";
import { SecurityEventRepository } from "./security-events";
import { SettingsRepository } from "./settings";
import { UserRepository } from "./users";

export * from "./auth-sessions";
export * from "./history";
export * from "./known-hosts";
export * from "./oauth";
export * from "./pagination";
export * from "./profiles";
export * from "./security-events";
export * from "./settings";
export * from "./users";

export interface Repositories {
  users: UserRepository;
  authSessions: AuthSessionRepository;
  profiles: ProfileRepository;
  knownHosts: KnownHostRepository;
  oauth: OAuthRepository;
  settings: SettingsRepository;
  commands: CommandHistoryRepository;
  connectionSessions: ConnectionSessionRepository;
  sessionEvents: SessionEventRepository;
  securityEvents: SecurityEventRepository;
}

export function createRepositories(env: Pick<Env, "DB" | "CREDENTIAL_MASTER_KEY">): Repositories {
  return {
    users: new UserRepository(env.DB),
    authSessions: new AuthSessionRepository(env.DB),
    profiles: new ProfileRepository(env.DB, env.CREDENTIAL_MASTER_KEY),
    knownHosts: new KnownHostRepository(env.DB),
    oauth: new OAuthRepository(env.DB, env.CREDENTIAL_MASTER_KEY),
    settings: new SettingsRepository(env.DB),
    commands: new CommandHistoryRepository(env.DB),
    connectionSessions: new ConnectionSessionRepository(env.DB),
    sessionEvents: new SessionEventRepository(env.DB),
    securityEvents: new SecurityEventRepository(env.DB),
  };
}
