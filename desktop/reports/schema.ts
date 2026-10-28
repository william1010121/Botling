import { z } from 'zod';

const text = z.string().trim().min(1).max(30_000);
const status = z.enum(['complete', 'partial', 'pending', 'blocked', 'unverified']);
export const blockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('paragraph'), text }),
  z.strictObject({ type: z.literal('list'), items: z.array(text).min(1).max(100), ordered: z.boolean().optional() }),
  z.strictObject({ type: z.literal('table'), caption: text, columns: z.array(text).min(1).max(12), rows: z.array(z.array(text)).max(500) })
    .refine(v => v.rows.every(row => row.length === v.columns.length), 'Every table row must match the columns'),
  z.strictObject({ type: z.literal('finding'), title: text, status, evidence: text, next: text.optional() }),
]);
/** Versioned plain-text content only: no HTML, CSS, scripts or arbitrary component props. */
export const reportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lang: z.enum(['en', 'zh-Hant']).default('en'),
  title: text,
  subtitle: text.optional(),
  asOf: text,
  summary: text,
  sections: z.array(z.strictObject({ title: text, blocks: z.array(blockSchema).min(1).max(100) })).max(50).default([]),
  evidence: z.array(z.strictObject({ source: text, detail: text })).max(100).optional(),
  nextSteps: z.array(text).max(100).optional(),
  limitations: z.array(text).max(100).optional(),
});
export type Report = z.infer<typeof reportSchema>;
export type Block = z.infer<typeof blockSchema>;
