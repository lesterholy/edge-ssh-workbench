import { loadConfig } from "./config";
import { createConnectorServer } from "./server";

const config = loadConfig(process.env);
const connector = createConnectorServer(config);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await connector.close();
    process.exitCode = 0;
  } catch (error) {
    console.error("Tailnet Connector shutdown failed", error);
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

void connector.listen().catch((error: unknown) => {
  console.error("Tailnet Connector startup failed", error);
  process.exitCode = 1;
});
