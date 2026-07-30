// Keep the SSH package API stable while sharing the single audited SSRF policy.
export {
  assertAllowedSshPort,
  assertPublicTarget,
  isPrivateOrReservedAddress,
  normalizeHost,
  resolvePublicAddresses,
  TargetValidationError,
  toSocketHostname
} from "../security/network";
export type { ResolveTargetOptions } from "../security/network";
