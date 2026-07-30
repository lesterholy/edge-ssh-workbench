import type { Settings, SettingsPatchRequest } from "@edgesh/contracts";

import { asBoolean, nowIso, toInteger } from "./internal";

interface SettingsRow {
  owner_id: string;
  language: "zh-CN" | "en";
  theme: "system" | "light" | "dark";
  terminal_font_family: string;
  terminal_font_size: number;
  terminal_scrollback: number;
  terminal_cursor_blink: number;
  default_encoding: "utf-8" | "gb18030" | "big5";
  default_terminal_type: "xterm-256color" | "xterm" | "screen-256color";
  monitoring_refresh_seconds: number;
  monitoring_reduce_when_hidden: number;
  command_retention_days: number;
  event_retention_days: number;
  collect_commands: number;
  updated_at: string;
}

function defaults(): Omit<SettingsRow, "owner_id"> {
  return {
    language: "zh-CN", theme: "system",
    terminal_font_family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    terminal_font_size: 14, terminal_scrollback: 10_000, terminal_cursor_blink: 1,
    default_encoding: "utf-8", default_terminal_type: "xterm-256color",
    monitoring_refresh_seconds: 8, monitoring_reduce_when_hidden: 1,
    command_retention_days: 90, event_retention_days: 90, collect_commands: 1,
    updated_at: nowIso(),
  };
}

function toSettings(row: SettingsRow): Settings {
  return {
    language: row.language,
    theme: row.theme,
    terminal: {
      encoding: row.default_encoding,
      type: row.default_terminal_type,
      fontSize: row.terminal_font_size,
      fontFamily: row.terminal_font_family,
      cursorBlink: asBoolean(row.terminal_cursor_blink),
      scrollbackLines: row.terminal_scrollback,
    },
    monitoring: {
      refreshIntervalSeconds: row.monitoring_refresh_seconds,
      reduceWhenHidden: asBoolean(row.monitoring_reduce_when_hidden),
    },
    history: {
      commandRetentionDays: row.command_retention_days,
      sessionRetentionDays: row.event_retention_days,
      collectCommands: asBoolean(row.collect_commands),
    },
    updatedAt: row.updated_at,
  };
}

export class SettingsRepository {
  constructor(private readonly db: D1Database) {}

  async get(ownerId: string): Promise<Settings> {
    let row = await this.db.prepare("SELECT * FROM settings WHERE owner_id = ?").bind(ownerId).first<SettingsRow>();
    if (!row) {
      const value = defaults();
      await this.db.prepare(
        `INSERT INTO settings (owner_id, language, theme, terminal_font_family, terminal_font_size,
          terminal_scrollback, terminal_cursor_blink, default_encoding, default_terminal_type,
          monitoring_refresh_seconds, monitoring_reduce_when_hidden, command_retention_days,
          event_retention_days, collect_commands, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(ownerId, value.language, value.theme, value.terminal_font_family, value.terminal_font_size,
        value.terminal_scrollback, value.terminal_cursor_blink, value.default_encoding, value.default_terminal_type,
        value.monitoring_refresh_seconds, value.monitoring_reduce_when_hidden, value.command_retention_days,
        value.event_retention_days, value.collect_commands, value.updated_at).run();
      row = { owner_id: ownerId, ...value };
    }
    return toSettings(row);
  }

  async update(ownerId: string, patch: SettingsPatchRequest): Promise<Settings> {
    const current = await this.get(ownerId);
    const updatedAt = nowIso();
    const next: Settings = {
      language: patch.language ?? current.language,
      theme: patch.theme ?? current.theme,
      terminal: { ...current.terminal, ...patch.terminal },
      monitoring: { ...current.monitoring, ...patch.monitoring },
      history: { ...current.history, ...patch.history },
      updatedAt,
    };
    await this.db.prepare(
      `UPDATE settings SET language = ?, theme = ?, terminal_font_family = ?, terminal_font_size = ?,
        terminal_scrollback = ?, terminal_cursor_blink = ?, default_encoding = ?, default_terminal_type = ?,
        monitoring_refresh_seconds = ?, monitoring_reduce_when_hidden = ?, command_retention_days = ?,
        event_retention_days = ?, collect_commands = ?, updated_at = ? WHERE owner_id = ?`,
    ).bind(next.language, next.theme, next.terminal.fontFamily, next.terminal.fontSize,
      next.terminal.scrollbackLines, toInteger(next.terminal.cursorBlink), next.terminal.encoding, next.terminal.type,
      next.monitoring.refreshIntervalSeconds, toInteger(next.monitoring.reduceWhenHidden), next.history.commandRetentionDays,
      next.history.sessionRetentionDays, toInteger(next.history.collectCommands), updatedAt, ownerId).run();
    return next;
  }
}
