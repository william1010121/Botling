import { z } from 'zod';
import type { ReactNode } from 'react';
import type { Labels, Lang } from './i18n';

/** Where a block prefers to sit when the planner builds rows (never coordinates). */
export type Fit = 'full' | 'visual' | 'half' | 'text' | 'kpi';
export type Mode = 'doc' | 'slide';

export interface Ctx {
  lang: Lang;
  t: Labels;
  mode: Mode;
  /** Unique, deterministic id prefix for aria/id references inside one block. */
  id: string;
  /** Data computed before rendering (elkjs layouts); see BlockDef.prepare. */
  prepared?: unknown;
}

/** Fields every block may carry: an action title, a faint note, and a layout hint. */
export const commonFields = {
  title: z.string().trim().min(1).max(80).optional().describe('Action title: the point of this block, not its topic ("啟動時間少了 42%", not "啟動時間").'),
  note: z.string().trim().min(1).max(60).optional().describe('Faint caption on the right of the title: unit, scope or source.'),
  span: z.enum(['auto', 'full']).optional().describe('Layout hint only. full = take the whole row.'),
};

export interface BlockDef<S extends z.ZodType = z.ZodType> {
  type: string;
  /** One line: what this block shows. */
  description: string;
  /** When to use it (and when not), for the bot prompt doc. */
  when: string;
  schema: S;
  examples: z.input<S>[];
  fit: Fit | ((block: z.output<S>) => Fit);
  /** Charts and diagrams count against the visual budget and need a title. */
  visual: boolean;
  /** Async work done once before the synchronous React render (graph layout). */
  prepare?: (block: z.output<S>, mode: Mode) => Promise<unknown>;
  Doc: (props: { block: z.output<S>; ctx: Ctx }) => ReactNode;
  Slide?: (props: { block: z.output<S>; ctx: Ctx }) => ReactNode;
  slide: {
    /** Share of a slide's evidence area the block needs (0–1, may exceed 1 = must split). */
    weight: (block: z.output<S>) => number;
    /** Split a block that is too big into pieces that each fit one slide. */
    split?: (block: z.output<S>) => z.output<S>[];
    /** Text-like blocks can sit in the right column of a split slide. */
    side?: boolean;
  };
}

export type AnyBlockDef = BlockDef<z.ZodType>;

/** Build a block definition: wraps the fields in a strict object with `type` + the common fields. */
export function defineBlock<T extends string, F extends z.ZodRawShape>(def: {
  type: T;
  description: string;
  when: string;
  fields: F;
  refine?: (value: z.output<z.ZodObject<F>>, ctx: z.RefinementCtx) => void;
  examples: Array<Record<string, unknown>>;
  fit: Fit | ((block: any) => Fit);
  visual: boolean;
  prepare?: (block: any, mode: Mode) => Promise<unknown>;
  Doc: (props: { block: any; ctx: Ctx }) => ReactNode;
  Slide?: (props: { block: any; ctx: Ctx }) => ReactNode;
  slide?: { weight?: (block: any) => number; split?: (block: any) => any[]; side?: boolean };
}): AnyBlockDef {
  let schema: z.ZodType = z.strictObject({ type: z.literal(def.type), ...commonFields, ...def.fields }).describe(def.description);
  if (def.refine) schema = (schema as z.ZodObject).superRefine(def.refine as never);
  return {
    type: def.type,
    description: def.description,
    when: def.when,
    schema,
    examples: def.examples.map(e => ({ type: def.type, ...e })),
    fit: def.fit,
    visual: def.visual,
    prepare: def.prepare,
    Doc: def.Doc,
    Slide: def.Slide,
    slide: { weight: def.slide?.weight ?? (() => 0.6), split: def.slide?.split, side: def.slide?.side },
  };
}

export function fitOf(def: AnyBlockDef, block: unknown): Fit {
  return typeof def.fit === 'function' ? def.fit(block) : def.fit;
}
