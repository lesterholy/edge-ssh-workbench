const MAX_CAPTURED_COMMAND_CHARS = 2_048;
const MAX_PENDING_COMMANDS = 8;
const MAX_OUTPUT_CHARS = 32 * 1024;
const CANDIDATE_TTL_MS = 15_000;

const SENSITIVE_COMMAND = /(?:^|[;&|]\s*|\bsudo\s+)(?:passwd|chpasswd|sshpass|gpg|openssl\s+(?:enc|pkcs|rsa)|docker\s+login|npm\s+(?:login|adduser)|kubectl\s+(?:create|apply)\s+secret|read\s+-s)\b/i;
const SENSITIVE_FLAG = /--(?:password|passphrase|token|secret|api-key|access-key)(?:=|\s+)/i;
const ASSIGNMENT = /(?:^|[\s;&|])(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*=/gi;
const SENSITIVE_NAME_PART = /(?:^|[_-])(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_-]|$)/i;

function hasSensitiveAssignment(command: string): boolean {
  return [...command.matchAll(ASSIGNMENT)].some((match) => SENSITIVE_NAME_PART.test(match[1] ?? ""));
}

export function isSafeCommandForHistory(command: string): boolean {
  return command.length > 0
    && command.length <= MAX_CAPTURED_COMMAND_CHARS
    && !/[\0\n\r]/.test(command)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)
    && !SENSITIVE_COMMAND.test(command)
    && !hasSensitiveAssignment(command)
    && !SENSITIVE_FLAG.test(command)
    && !/\bmysql\b[^\n]*\s-p\S+/i.test(command)
    && !/\b(?:Authorization|Proxy-Authorization)\s*:/i.test(command)
    && !/:\/\/[^\s/@:]+:[^\s/@]+@/.test(command)
    && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(command)
    && !/<<[-]?\s*['"]?[A-Za-z0-9_]+/.test(command);
}

interface PendingCommand {
  command: string;
  queuedAt: number;
  searchFrom: number;
  minimumMatchEnd: number;
}

/** Best-effort capture that requires a complete input line and a matching PTY echo. */
export class TerminalCommandCapture {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private buffer = "";
  private unsafeLine = false;
  private output = "";
  private pending: PendingCommand[] = [];

  feed(bytes: Uint8Array, now = Date.now()): void {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!text) return;
    const terminators = [...text.matchAll(/\r\n|\r|\n/g)];
    const first = terminators[0];
    if (terminators.length > 1 || (first && (first.index ?? 0) + first[0].length < text.length)) {
      this.resetLine();
      return;
    }

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index] ?? "";
      if (character === "\r" || character === "\n") {
        if (character === "\n" && index > 0 && text[index - 1] === "\r") continue;
        const command = this.buffer.trim();
        if (!this.unsafeLine && isSafeCommandForHistory(command)) {
          this.prunePending(now);
          this.pending.push({
            command,
            queuedAt: now,
            searchFrom: Math.max(0, this.output.length - command.length - 512),
            minimumMatchEnd: this.output.length + 1
          });
          if (this.pending.length > MAX_PENDING_COMMANDS) this.pending.shift();
        }
        this.resetLine();
        continue;
      }
      if (character === "\b" || character === "\u007f") {
        this.buffer = [...this.buffer].slice(0, -1).join("");
        continue;
      }
      if (character === "\u0003" || character === "\u0015") {
        this.reset();
        continue;
      }
      const code = character.codePointAt(0) ?? 0;
      if (character === "\u001b" || code < 0x20 || character === "\ufffd") {
        this.unsafeLine = true;
        continue;
      }
      if (this.buffer.length < MAX_CAPTURED_COMMAND_CHARS) this.buffer += character;
      else this.unsafeLine = true;
    }
  }

  observeOutput(text: string, now = Date.now()): string[] {
    if (!text) return [];
    this.output += text;
    if (this.output.length > MAX_OUTPUT_CHARS) {
      const removed = this.output.length - MAX_OUTPUT_CHARS;
      this.output = this.output.slice(removed);
      for (const candidate of this.pending) {
        candidate.searchFrom = Math.max(0, candidate.searchFrom - removed);
        candidate.minimumMatchEnd = Math.max(0, candidate.minimumMatchEnd - removed);
      }
    }
    this.prunePending(now);

    const confirmed: string[] = [];
    const remaining: PendingCommand[] = [];
    let consumedThrough = 0;
    for (const candidate of this.pending) {
      const pattern = new RegExp(`${escapeRegExp(candidate.command)}(?:\\r\\n|\\r|\\n)`, "g");
      const searchFrom = Math.max(candidate.searchFrom, consumedThrough);
      const search = this.output.slice(searchFrom);
      let match: RegExpExecArray | null = null;
      let matchEnd = -1;
      while ((match = pattern.exec(search))) {
        matchEnd = searchFrom + match.index + match[0].length;
        if (matchEnd >= candidate.minimumMatchEnd) break;
      }
      if (!match || matchEnd < candidate.minimumMatchEnd) {
        remaining.push(candidate);
        continue;
      }
      confirmed.push(candidate.command);
      consumedThrough = matchEnd;
    }
    this.pending = remaining;
    if (consumedThrough > 0) {
      this.output = this.output.slice(consumedThrough);
      for (const candidate of this.pending) {
        candidate.searchFrom = Math.max(0, candidate.searchFrom - consumedThrough);
        candidate.minimumMatchEnd = Math.max(0, candidate.minimumMatchEnd - consumedThrough);
      }
    }
    return confirmed;
  }

  reset(): void {
    this.resetLine();
    this.output = "";
    this.pending = [];
  }

  private resetLine(): void {
    this.buffer = "";
    this.unsafeLine = false;
  }

  private prunePending(now: number): void {
    this.pending = this.pending.filter((candidate) => now - candidate.queuedAt <= CANDIDATE_TTL_MS);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
