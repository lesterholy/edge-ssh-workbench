import type { RuntimeConfig } from "../env";
import { CloudflareSSHTransportFactory } from "./cloudflare-transport";
import { TailnetConnectorTransportFactory } from "./tailnet-connector-transport";
import type { SSHTransportFactory } from "./types";

export function createSSHTransportFactory(config: RuntimeConfig, sessionId: string): SSHTransportFactory {
  if (config.sshTransport === "direct") {
    return new CloudflareSSHTransportFactory(config.allowedSshPorts);
  }
  if (!config.tailnetConnector) throw new Error("Tailnet Connector transport is not configured");
  return new TailnetConnectorTransportFactory({
    ...config.tailnetConnector,
    sessionId,
    allowedPorts: config.allowedSshPorts
  });
}
