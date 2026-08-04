import { describe, expect, it } from "vitest";

import { parseBashHistory, shellHistoryCommand } from "./shell-history";

describe("Bash history", () => {
  it("parses timestamps, returns newest first, and filters sensitive commands", () => {
    const entries = parseBashHistory([
      "#1785800000",
      "ls -la",
      "#1785800010",
      "docker login --password secret registry.example",
      "#1785800020",
      "systemctl status ssh"
    ].join("\n"), 10);

    expect(entries).toEqual([
      { command: "systemctl status ssh", executedAt: new Date(1_785_800_020_000).toISOString() },
      { command: "ls -la", executedAt: new Date(1_785_800_000_000).toISOString() }
    ]);
  });

  it("bounds both the command and returned entry count", () => {
    expect(shellHistoryCommand(500)).toContain("tail -n 120");
    const raw = Array.from({ length: 80 }, (_, index) => `echo ${index}`).join("\n");
    expect(parseBashHistory(raw, 50)).toHaveLength(50);
    expect(parseBashHistory(raw, 50)[0]?.command).toBe("echo 79");
  });
});
