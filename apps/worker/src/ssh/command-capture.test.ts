import { describe, expect, it } from "vitest";
import { isSafeCommandForHistory, TerminalCommandCapture } from "./command-capture";

const encode = (value: string) => new TextEncoder().encode(value);

describe("terminal command capture", () => {
  it("captures one complete edited command", () => {
    const capture = new TerminalCommandCapture();
    capture.feed(encode("ecoh\b\bho hello\r"), 1_000);
    expect(capture.observeOutput("echo hello\r\n", 1_001)).toEqual(["echo hello"]);
  });

  it("does not capture multi-line paste, escape completion, or sensitive commands", () => {
    const capture = new TerminalCommandCapture();
    capture.feed(encode("whoami\rhostname\r"), 1_000);
    capture.feed(encode("cat /et\u001b[Ax\r"), 1_001);
    capture.feed(encode("export API_TOKEN=plain-secret\r"), 1_002);
    capture.feed(encode("uptime\r"), 1_003);
    expect(capture.observeOutput("whoami\r\nhostname\r\ncat /etc\r\nexport API_TOKEN=plain-secret\r\nuptime\r\n", 1_004))
      .toEqual(["uptime"]);
  });

  it("does not capture hidden prompt responses or retain oversized input", () => {
    const capture = new TerminalCommandCapture();
    capture.feed(encode("sudo -v\r"), 1_000);
    expect(capture.observeOutput("$ sudo -v\r\n[sudo] password for deploy: ", 1_001)).toEqual(["sudo -v"]);
    capture.feed(encode("hunter2\r"), 1_002);
    expect(capture.observeOutput("\r\n$ ", 1_003)).toEqual([]);

    capture.feed(encode(`${"x".repeat(10_000)}\r`), 1_004);
    expect(capture.observeOutput(`${"x".repeat(10_000)}\r\n`, 1_005)).toEqual([]);
  });

  it("does not confirm a candidate from an older output line", () => {
    const capture = new TerminalCommandCapture();
    expect(capture.observeOutput("uptime\r\n$ ", 1_000)).toEqual([]);
    capture.feed(encode("uptime\r"), 1_001);
    expect(capture.observeOutput("\r\n", 1_002)).toEqual([]);
    expect(capture.observeOutput("uptime\r\n", 1_003)).toEqual(["uptime"]);
  });

  it("conservatively rejects credential-bearing command forms", () => {
    expect(isSafeCommandForHistory("docker login --password hunter2 registry.example")).toBe(false);
    expect(isSafeCommandForHistory("curl https://user:password@example.test")).toBe(false);
    expect(isSafeCommandForHistory("kubectl get pods")).toBe(true);
  });
});
