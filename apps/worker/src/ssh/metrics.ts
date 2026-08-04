import type { FirewallStatus, MetricsSnapshot, ProcessInfo, ResourceUsage } from "./types";

const SECTION = "__EDGESSH_SECTION__";

export const METRICS_COMMAND = [
  "head -n 1 /proc/stat",
  "sleep 1; head -n 1 /proc/stat",
  "cat /proc/meminfo",
  "df -B1 -P / | tail -n 1",
  "ps -eo pid=,user=,%cpu=,%mem=,comm= --sort=-%cpu | head -n 8",
  "if command -v ufw >/dev/null 2>&1; then LC_ALL=C ufw status verbose 2>/dev/null || true; fi"
].join(`; printf '\\n${SECTION}\\n'; `);

function finiteNonNegative(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseCpu(first: string, second: string): number {
  const parse = (line: string) => {
    const values = line.replace(/^cpu\s+/, "").trim().split(/\s+/).map(finiteNonNegative);
    const idle = (values[3] ?? 0) + (values[4] ?? 0);
    return { idle, total: values.reduce((sum, value) => sum + value, 0) };
  };
  const start = parse(first);
  const end = parse(second);
  const totalDelta = end.total - start.total;
  const idleDelta = end.idle - start.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10));
}

function parseMeminfo(raw: string, totalKey: string, availableKey: string): ResourceUsage {
  const read = (key: string): number => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
    return finiteNonNegative(match?.[1]) * 1024;
  };
  const totalBytes = read(totalKey);
  const availableBytes = Math.min(totalBytes, read(availableKey));
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    usedBytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
  };
}

function parseDisk(line: string): ResourceUsage {
  const fields = line.trim().split(/\s+/);
  const totalBytes = finiteNonNegative(fields[1]);
  const usedBytes = Math.min(totalBytes, finiteNonNegative(fields[2]));
  return {
    usedBytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
  };
}

function parseProcesses(raw: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const pid = Number(fields[0]);
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    result.push({
      pid,
      user: fields[1] ?? "",
      cpuPercent: finiteNonNegative(fields[2]),
      memoryPercent: finiteNonNegative(fields[3]),
      command: fields.slice(4).join(" ")
    });
  }
  return result;
}

function bounded(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

export function parseUfwStatus(raw: string): FirewallStatus | null {
  const statusMatch = raw.match(/^Status:\s+(active|inactive)\s*$/m);
  if (!statusMatch) return null;

  const status = statusMatch[1] as FirewallStatus["status"];
  const logging = raw.match(/^Logging:\s+(.+)$/m)?.[1];
  const defaults = raw.match(/^Default:\s+(.+?)\s+\(incoming\),\s+(.+?)\s+\(outgoing\)/m);
  const rules: FirewallStatus["rules"] = [];

  if (status === "active") {
    for (const line of raw.split("\n")) {
      const fields = line.trim().split(/\s{2,}/);
      if (fields.length < 3) continue;
      const action = bounded(fields[1] ?? "", 32);
      if (!/^(?:ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT|FWD))?$/.test(action)) continue;
      const destination = bounded(fields[0] ?? "", 256);
      const source = bounded(fields.slice(2).join("  "), 256);
      if (destination && source && rules.length < 50) rules.push({ destination, action, source });
    }
  }

  return {
    backend: "ufw",
    status,
    ...(logging ? { logging: bounded(logging, 64) } : {}),
    ...(defaults?.[1] ? { defaultIncoming: bounded(defaults[1], 32) } : {}),
    ...(defaults?.[2] ? { defaultOutgoing: bounded(defaults[2], 32) } : {}),
    rules
  };
}

export function parseMetrics(raw: string): MetricsSnapshot {
  const sections = raw.split(SECTION).map((section) => section.trim());
  if (sections.length !== 6) throw new Error("Unexpected metrics response from SSH server");
  return {
    metrics: {
      cpuPercent: parseCpu(sections[0] ?? "", sections[1] ?? ""),
      memory: parseMeminfo(sections[2] ?? "", "MemTotal", "MemAvailable"),
      swap: parseMeminfo(sections[2] ?? "", "SwapTotal", "SwapFree"),
      disk: parseDisk(sections[3] ?? ""),
      updatedAt: new Date().toISOString()
    },
    processes: parseProcesses(sections[4] ?? ""),
    firewall: parseUfwStatus(sections[5] ?? "")
  };
}
