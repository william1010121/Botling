import { z } from 'zod';
import { blocks, registry } from './blocks';
import { kinds, levelEnum } from './core/i18n';

const line = (max: number) => z.string().trim().min(1).max(max);

/** Discriminated union of every registered block, generated from the registry. */
export const blockSchema = z.discriminatedUnion('type', blocks.map(b => b.schema) as unknown as [z.ZodObject, ...z.ZodObject[]]);

function specShape<B extends z.ZodType>(block: B) {
  return z.strictObject({
    version: z.literal(2),
    lang: z.enum(['zh-Hant', 'en']).default('zh-Hant'),
    kind: z.enum(kinds).optional().describe('One report type per report; picks the skeleton (see the prompt doc).'),
    title: line(40).describe('What this report is about, ≤ 22 CJK chars.'),
    subtitle: line(80).optional(),
    asOf: line(40).describe('When the evidence was taken, human readable.'),
    status: z.strictObject({
      level: levelEnum,
      reason: line(60).optional().describe('Required for at_risk / off_track: cause and fix in one line.'),
    }).optional(),
    tldr: line(240).describe('The answer first: ≤ 3 sentences. Shown in the verdict card and on the cover slide.'),
    next: z.array(line(24)).min(1).max(3).optional().describe('≤ 3 one-line next steps, shown as numbered chips under the verdict.'),
    sections: z.array(z.strictObject({
      id: z.string().regex(/^[a-z0-9-]+$/).max(32).optional(),
      title: line(24).describe('Short topic label, shown small above the takeaway.'),
      takeaway: line(60).optional().describe('The section\'s conclusion as one sentence; becomes the slide headline.'),
      layout: z.enum(['auto', 'stack', 'split', 'grid']).default('auto'),
      blocks: z.array(block).min(1).max(8),
    })).min(1).max(8),
    asks: z.array(z.strictObject({ what: line(60), who: line(20).optional(), by: line(20).optional() })).max(3).optional()
      .describe('What the reader must do (owner, deadline). [] renders "No action needed".'),
  });
}
/** The full strict schema (for JSON Schema and complete validation). */
export const reportSpecSchema = specShape(blockSchema);
/** Shell used for lenient rendering: blocks are validated one by one so one bad block cannot sink the report. */
const shellSchema = specShape(z.looseObject({ type: z.string() }));

export type BlockData = z.output<typeof blockSchema> & { type: string };
export type BrokenBlock = { type: '__error'; original: string; message: string; path: string };
export type Section = Omit<z.output<typeof shellSchema>['sections'][number], 'blocks'> & { blocks: Array<BlockData | BrokenBlock> };
export type ReportSpec = Omit<z.output<typeof shellSchema>, 'sections'> & { sections: Section[] };
export type Issue = { path: string; message: string; example?: unknown };

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '');
}

export const minimalExample = {
  version: 2, lang: 'zh-Hant', kind: 'status', title: '今天的交付狀態', asOf: '2026-10-28 18:00',
  tldr: '任務面板 .11 已安裝；手機版 bot 清單受阻，今天修。',
  sections: [{ title: '進度', takeaway: '四條線裡一條受阻', blocks: [{ type: 'kpi', items: [{ label: '完成', value: 1, status: 'done' }, { label: '受阻', value: 1, status: 'blocked' }] }] }],
};

/** Validate a spec. Top-level problems → no spec. Block problems → the block becomes an ErrorBlock. */
export function validateSpec(input: unknown): { spec?: ReportSpec; errors: Issue[] } {
  const shell = shellSchema.safeParse(input);
  if (!shell.success) {
    return { errors: shell.error.issues.map(i => ({ path: formatPath(i.path), message: i.message, example: minimalExample })) };
  }
  const errors: Issue[] = [];
  const sections: Section[] = shell.data.sections.map((sec, si) => ({
    ...sec,
    blocks: sec.blocks.map((raw, bi) => {
      const base = `sections[${si}].blocks[${bi}]`;
      const def = registry.get(raw.type);
      if (!def) {
        const message = `unknown block type "${raw.type}"; valid types: ${[...registry.keys()].join(', ')}`;
        errors.push({ path: `${base}.type`, message });
        return { type: '__error', original: raw.type, message, path: `${base}.type` } satisfies BrokenBlock;
      }
      const parsed = def.schema.safeParse(raw);
      if (parsed.success) return parsed.data as BlockData;
      const issues = parsed.error.issues.map(i => ({ path: [base, formatPath(i.path)].filter(Boolean).join('.').replace(/\.\[/g, '['), message: i.message, example: def.examples[0] }));
      errors.push(...issues);
      return { type: '__error', original: raw.type, message: issues[0].message, path: issues[0].path } satisfies BrokenBlock;
    }),
  }));
  return { spec: { ...shell.data, sections }, errors };
}
