import { describe, expect, it } from "vitest";
import { parseMetrics } from "./metrics";

describe("parseMetrics", () => {
  it("parses bounded CPU, byte-based usage, and process rows", () => {
    const raw = [
      "cpu  100 0 50 850 0 0 0 0",
      "cpu  140 0 60 900 0 0 0 0",
      "MemTotal:       1048576 kB\nMemAvailable: 524288 kB\nSwapTotal: 262144 kB\nSwapFree: 131072 kB",
      "/dev/root 10737418240 5368709120 5368709120 50% /",
      "42 root 12.5 3.4 sshd\n84 app 1.0 2.0 node"
    ].join("\n__EDGESSH_SECTION__\n");

    const snapshot = parseMetrics(raw);
    expect(snapshot.metrics.cpuPercent).toBe(50);
    expect(snapshot.metrics.memory).toEqual({
      usedBytes: 512 * 1024 * 1024,
      totalBytes: 1024 * 1024 * 1024,
      percent: 50
    });
    expect(snapshot.metrics.disk.usedBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(snapshot.processes).toHaveLength(2);
    expect(snapshot.processes[0]).toMatchObject({ pid: 42, user: "root", command: "sshd" });
  });

  it("rejects incomplete command output", () => {
    expect(() => parseMetrics("cpu 1 2 3 4")).toThrow("Unexpected metrics response");
  });
});
