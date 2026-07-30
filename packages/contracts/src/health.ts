import { z } from "zod";

import { TimestampSchema } from "./common";

export const BindingHealthSchema = z
  .object({
    d1: z.boolean(),
    r2: z.boolean(),
    durableObjects: z.boolean(),
  })
  .strict();
export type BindingHealth = z.infer<typeof BindingHealthSchema>;

export const HealthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string().min(1).max(64),
    runtime: z.literal("cloudflare-workers"),
    timestamp: TimestampSchema,
    bindings: BindingHealthSchema,
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
