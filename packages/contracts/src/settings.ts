import { z } from "zod";

import { NonEmptyPatch, TimestampSchema } from "./common";

export const LanguageSchema = z.enum(["zh-CN", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const TerminalEncodingSchema = z.enum(["utf-8", "gb18030", "big5"]);
export type TerminalEncoding = z.infer<typeof TerminalEncodingSchema>;

export const TerminalTypeSchema = z.enum(["xterm-256color", "xterm", "screen-256color"]);
export type TerminalType = z.infer<typeof TerminalTypeSchema>;

export const TerminalSettingsSchema = z
  .object({
    encoding: TerminalEncodingSchema,
    type: TerminalTypeSchema,
    fontSize: z.number().int().min(10).max(24),
    fontFamily: z.string().min(1).max(256),
    cursorBlink: z.boolean(),
    scrollbackLines: z.number().int().min(100).max(100_000),
  })
  .strict();
export type TerminalSettings = z.infer<typeof TerminalSettingsSchema>;

export const MonitoringSettingsSchema = z
  .object({
    refreshIntervalSeconds: z.number().int().min(5).max(60),
    reduceWhenHidden: z.boolean(),
  })
  .strict();
export type MonitoringSettings = z.infer<typeof MonitoringSettingsSchema>;

export const HistorySettingsSchema = z
  .object({
    commandRetentionDays: z.number().int().min(1).max(3650),
    sessionRetentionDays: z.number().int().min(1).max(3650),
    collectCommands: z.boolean(),
  })
  .strict();
export type HistorySettings = z.infer<typeof HistorySettingsSchema>;

export const SettingsSchema = z
  .object({
    language: LanguageSchema,
    theme: ThemeSchema,
    terminal: TerminalSettingsSchema,
    monitoring: MonitoringSettingsSchema,
    history: HistorySettingsSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;

const TerminalSettingsPatchSchema = TerminalSettingsSchema.partial().strict();
const MonitoringSettingsPatchSchema = MonitoringSettingsSchema.partial().strict();
const HistorySettingsPatchSchema = HistorySettingsSchema.partial().strict();

export const SettingsPatchRequestSchema = NonEmptyPatch(
  z
    .object({
      language: LanguageSchema.optional(),
      theme: ThemeSchema.optional(),
      terminal: TerminalSettingsPatchSchema.optional(),
      monitoring: MonitoringSettingsPatchSchema.optional(),
      history: HistorySettingsPatchSchema.optional(),
    })
    .strict(),
).superRefine((value, context) => {
  for (const key of ["terminal", "monitoring", "history"] as const) {
    if (value[key] && Object.keys(value[key]).length === 0) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} patch must contain at least one field`,
      });
    }
  }
});
export type SettingsPatchRequest = z.infer<typeof SettingsPatchRequestSchema>;

export const SettingsResponseSchema = SettingsSchema;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
