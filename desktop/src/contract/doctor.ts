import { z } from "zod";

export const DoctorCheck = z.strictObject({
  tool: z.enum(["claude", "codex", "antigravity"]), name: z.string(), isRequired: z.boolean(), minimum: z.string(),
  status: z.enum(["ok", "warning", "failing"]), version: z.string().nullable(), path: z.string().nullable(),
  auth: z.string().nullable(), latest: z.string().nullable(), summary: z.string(), fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;
export const DoctorView = z.strictObject({
  checks: z.array(DoctorCheck), isRunning: z.boolean(), checkedAt: z.number().nullable(),
  includedLatest: z.boolean(), needsAttention: z.boolean(),
});
export type DoctorView = z.infer<typeof DoctorView>;
