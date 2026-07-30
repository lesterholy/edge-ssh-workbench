import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:sockets": fileURLToPath(new URL("./apps/worker/shims/cloudflare-sockets-test.ts", import.meta.url))
    }
  }
});
