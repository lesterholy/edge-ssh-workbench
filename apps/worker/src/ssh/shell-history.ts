import { isSafeCommandForHistory } from "./command-capture";
import type { ShellHistoryEntry } from "./types";

const MAX_HISTORY_COMMAND_CHARS = 768;

export function shellHistoryCommand(limit: number): string {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const lineLimit = safeLimit * 2 + 20;
  return `if [ -r "$HOME/.bash_history" ]; then tail -n ${lineLimit} -- "$HOME/.bash_history"; fi`;
}

export function parseBashHistory(raw: string, limit: number): ShellHistoryEntry[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const entries: ShellHistoryEntry[] = [];
  let executedAt: string | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const timestamp = rawLine.match(/^#(\d{9,11})$/);
    if (timestamp) {
      const milliseconds = Number(timestamp[1]) * 1_000;
      const date = new Date(milliseconds);
      executedAt = Number.isFinite(milliseconds) && !Number.isNaN(date.getTime())
        ? date.toISOString()
        : undefined;
      continue;
    }

    const command = rawLine.trim();
    if (command.length <= MAX_HISTORY_COMMAND_CHARS && isSafeCommandForHistory(command)) {
      entries.push({ command, ...(executedAt ? { executedAt } : {}) });
    }
    executedAt = undefined;
  }

  return entries.slice(-safeLimit).reverse();
}
