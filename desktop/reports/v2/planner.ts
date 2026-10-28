import { fitOf, type AnyBlockDef, type Fit } from './core/registry';
import { textUnits } from './core/text';
import type { BlockData, BrokenBlock, ReportSpec, Section } from './spec';

export type AnyBlock = BlockData | BrokenBlock;
export type Cell = { index: number; span: number };
export type Row = { kind: 'full' | 'kpi' | 'split' | 'pair'; cells: Cell[] };
export type LayoutInput = { fit: Fit; full?: boolean; short?: boolean };

/** Short enough to sit next to a chart (≈ 4 lines at the 5/12 column). */
export function isShort(block: AnyBlock): boolean {
  if (block.type === 'prose') return textUnits((block as unknown as { text: string }).text) <= 160;
  return block.type === 'callout' || block.type === 'quote';
}

export function layoutInputs(blocks: AnyBlock[], registry: Map<string, AnyBlockDef>): LayoutInput[] {
  return blocks.map(b => {
    const def = registry.get(b.type);
    return def ? { fit: fitOf(def, b), full: (b as { span?: string }).span === 'full', short: isShort(b) } : { fit: 'full' as Fit, full: true };
  });
}

/**
 * Pure row planner on a 12-column grid. Rules: stats → KPI row; chart + short prose → 7:5 split
 * (order kept); two half-size blocks → 6:6; tables, timelines, flows, sources → full width.
 * Containers collapse rows to one column on narrow widths (CSS container queries), not here.
 */
export function planLayout(items: LayoutInput[], layout: 'auto' | 'stack' | 'split' | 'grid' = 'auto'): Row[] {
  const rows: Row[] = [];
  const full = (i: number): Row => ({ kind: items[i].fit === 'kpi' ? 'kpi' : 'full', cells: [{ index: i, span: 12 }] });
  const pairable = (i: number) => i < items.length && !items[i].full && items[i].fit !== 'full' && items[i].fit !== 'kpi';
  for (let i = 0; i < items.length; i++) {
    const a = items[i], b = items[i + 1];
    if (layout === 'stack' || !pairable(i) || !b || !pairable(i + 1)) { rows.push(full(i)); continue; }
    if (layout === 'split') { rows.push({ kind: 'split', cells: [{ index: i, span: 7 }, { index: i + 1, span: 5 }] }); i++; continue; }
    if (layout === 'grid') { rows.push({ kind: 'pair', cells: [{ index: i, span: 6 }, { index: i + 1, span: 6 }] }); i++; continue; }
    if (a.fit === 'visual' && b.fit === 'text' && b.short) { rows.push({ kind: 'split', cells: [{ index: i, span: 7 }, { index: i + 1, span: 5 }] }); i++; continue; }
    if (a.fit === 'text' && a.short && b.fit === 'visual') { rows.push({ kind: 'split', cells: [{ index: i, span: 5 }, { index: i + 1, span: 7 }] }); i++; continue; }
    if ((a.fit === 'half' || a.fit === 'visual') && (b.fit === 'half' || b.fit === 'visual')) { rows.push({ kind: 'pair', cells: [{ index: i, span: 6 }, { index: i + 1, span: 6 }] }); i++; continue; }
    if ((a.fit === 'half' && b.fit === 'text') || (a.fit === 'text' && b.fit === 'half')) { rows.push({ kind: 'pair', cells: [{ index: i, span: 6 }, { index: i + 1, span: 6 }] }); i++; continue; }
    rows.push(full(i));
  }
  return rows;
}

export type Master = 'cover' | 'kpi-grid' | 'assertion-evidence' | 'split' | 'table' | 'quote' | 'statement' | 'closing';
const TEXT = new Set(['prose', 'callout', 'quote']);
export type SlidePlan = { master: Master; headline: string; kicker?: string; section?: number; main: AnyBlock[]; side: AnyBlock[]; continued?: boolean };

const SIDE_FACTOR = 1.5;
/**
 * Pure slide planner. One section → one or more slides; headline = takeaway (title if missing).
 * Blocks never shrink: when the evidence area is full the rest goes to a continuation slide.
 */
export function planSlides(spec: ReportSpec, registry: Map<string, AnyBlockDef>, continued = ' (cont.)'): SlidePlan[] {
  const slides: SlidePlan[] = [{ master: 'cover', headline: spec.title, main: [], side: [] }];
  const weight = (b: AnyBlock) => registry.get(b.type)?.slide.weight(b) ?? 0.3;
  let sourcesBlock: AnyBlock | undefined;
  spec.sections.forEach((sec: Section, si) => {
    const pieces: AnyBlock[] = [];
    for (const b of sec.blocks) {
      if (b.type === 'sources') { sourcesBlock = b; continue; }
      const def = registry.get(b.type);
      if (def?.slide.split && def.slide.weight(b) > 0.9) pieces.push(...(def.slide.split(b) as AnyBlock[])); else pieces.push(b);
    }
    if (!pieces.length) return;
    const headline = sec.takeaway ?? sec.title;
    let cur: SlidePlan | undefined;
    let mainW = 0, sideW = 0;
    const open = () => {
      cur = { master: 'assertion-evidence', headline, kicker: sec.title, section: si, main: [], side: [], continued: slides.some(s => s.section === si) };
      if (cur.continued) cur.headline = headline + continued;
      slides.push(cur); mainW = 0; sideW = 0;
    };
    for (const b of pieces) {
      const w = weight(b);
      const def = registry.get(b.type);
      if (b.type === 'quote' && pieces.length === 1) { open(); cur!.master = 'quote'; cur!.main.push(b); continue; }
      if (!cur) open();
      const mainVisual = cur!.main.some(m => registry.get(m.type)?.visual && m.type !== 'kpi');
      if (def?.slide.side && mainVisual && cur!.main.length === 1 && sideW + w * SIDE_FACTOR <= 1.05) { cur!.side.push(b); sideW += w * SIDE_FACTOR; continue; }
      if (cur!.main.length < 3 && mainW + w <= 1.05 && !(def?.slide.side && cur!.side.length)) { cur!.main.push(b); mainW += w; continue; }
      open(); cur!.main.push(b); mainW = w;
    }
  });
  for (const s of slides) {
    if (s.master !== 'assertion-evidence') continue;
    if (s.side.length) s.master = 'split';
    // Text-only slides would leave most of the canvas empty: a statement slide sets the
    // takeaway and the text large and centred instead.
    else if (s.main.every(b => TEXT.has(b.type))) s.master = 'statement';
    else if (s.main.every(b => b.type === 'kpi')) s.master = 'kpi-grid';
    else if (s.main.some(b => b.type === 'table' || b.type === 'options')) s.master = 'table';
  }
  if (spec.asks || spec.next || sourcesBlock) {
    slides.push({ master: 'closing', headline: '', main: sourcesBlock ? [sourcesBlock] : [], side: [] });
  }
  return slides;
}
