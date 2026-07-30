import type { MetricsSnapshot, ProcessInfo, ResourceUsage } from "./types";

const SECTION = "__EDGESSH_SECTION__";

export const METRICS_COMMAND = [
  "head -n 1 /proc/stat",
  "sleep 1; head -n 1 /proc/stat",
  "cat /proc/meminfo",
  "df -B1 -P / | tail -n 1",
  "ps -eo pid=,user=,%cpu=,%mem=,comm= --sort=-%cpu | head -n 8"
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

export function parseMetrics(raw: string): MetricsSnapshot {
  const sections = raw.split(SECTION).map((section) => section.trim());
  if (sections.length !== 5) throw new Error("Unexpected metrics response from SSH server");
  return {
    metrics: {
      cpuPercent: parseCpu(sections[0] ?? "", sections[1] ?? ""),
      memory: parseMeminfo(sections[2] ?? "", "MemTotal", "MemAvailable"),
      swap: parseMeminfo(sections[2] ?? "", "SwapTotal", "SwapFree"),
      disk: parseDisk(sections[3] ?? ""),
      updatedAt: new Date().toISOString()
    },
    processes: parseProcesses(sections[4] ?? "")
  };
}
