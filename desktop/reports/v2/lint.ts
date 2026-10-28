import type { AnyBlockDef } from './core/registry';
import { markdownBullets, textUnits } from './core/text';
import type { Issue, ReportSpec } from './spec';
import type { SlidePlan } from './planner';

/** Handbook budgets. Warnings never block rendering; they go back to the bot for one rewrite. */
export const budgets = {
  takeawayUnits: 30, tldrSentences: 3, bullets: 6, bulletDepth: 2, proseUnits: 300,
  calloutPerSection: 1, visualsPerSection: 2, visualsPerReport: 8, tableRows: 8, timelineItems: 12, flowNodes: 12, slidesPerSection: 2,
};

const sentences = (s: string) => s.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/).filter(x => x.trim()).length;

export function lintSpec(spec: ReportSpec, registry: Map<string, AnyBlockDef>, slides?: SlidePlan[]): Issue[] {
  const w: Issue[] = [];
  const warn = (path: string, message: string) => w.push({ path, message });
  if (sentences(spec.tldr) > budgets.tldrSentences) warn('tldr', `TL;DR has ${sentences(spec.tldr)} sentences; keep ≤ ${budgets.tldrSentences}, answer first.`);
  if (spec.status && (spec.status.level === 'at_risk' || spec.status.level === 'off_track') && !spec.status.reason) warn('status.reason', 'at_risk / off_track needs a reason: the cause and the fix in one line.');
  if (spec.asks === undefined && (spec.kind === 'decision' || spec.kind === 'status' || spec.kind === 'plan')) warn('asks', 'End with asks (owner, deadline) or "asks": [] for "No action needed".');
  let total = 0;
  const kindsUsed = new Set<string>();
  spec.sections.forEach((sec, si) => {
    const p = `sections[${si}]`;
    if (!sec.takeaway && !sec.blocks.every(b => b.type === 'sources')) warn(`${p}.takeaway`, `Section "${sec.title}" has no takeaway; write its conclusion as one sentence (it becomes the slide headline).`);
    else if (sec.takeaway && textUnits(sec.takeaway) > budgets.takeawayUnits) warn(`${p}.takeaway`, `Takeaway is long (${Math.round(textUnits(sec.takeaway))} units); keep ≤ ${budgets.takeawayUnits} (≈ 22 CJK chars or 15 words).`);
    let visuals = 0, callouts = 0;
    sec.blocks.forEach((b, bi) => {
      const bp = `${p}.blocks[${bi}]`;
      kindsUsed.add(b.type);
      const def = registry.get(b.type);
      if (!def) return;
      const any = b as Record<string, any>;
      if (def.visual) { visuals++; total++; if (!any.title) warn(`${bp}.title`, `${b.type} has no title; charts need an action title that states what it shows.`); }
      if (b.type === 'callout') callouts++;
      if (b.type === 'prose') {
        const { count, depth } = markdownBullets(any.text);
        if (count > budgets.bullets) warn(`${bp}.text`, `${count} bullets; keep ≤ ${budgets.bullets} (split the section or use checklist).`);
        if (depth > budgets.bulletDepth) warn(`${bp}.text`, `Bullets nested ${depth} levels; keep ≤ ${budgets.bulletDepth}.`);
        if (textUnits(any.text) > budgets.proseUnits) warn(`${bp}.text`, `Prose is ${Math.round(textUnits(any.text))} units; evidence too long — keep ≤ ${budgets.proseUnits}, move detail to an appendix file.`);
      }
      if (b.type === 'table' && any.rows.length > budgets.tableRows) warn(`${bp}.rows`, `${any.rows.length} rows; keep ≤ ${budgets.tableRows} in the body.`);
      if (b.type === 'timeline' && any.items.length > budgets.timelineItems) warn(`${bp}.items`, `${any.items.length} events; keep ≤ ${budgets.timelineItems}.`);
      if (b.type === 'flow' && any.nodes.length > budgets.flowNodes) warn(`${bp}.nodes`, `${any.nodes.length} nodes; keep ≤ ${budgets.flowNodes} or split the flow.`);
      if (b.type === 'options' && any.options.length < 2) warn(`${bp}.options`, 'Show at least two options (include "do nothing").');
    });
    if (visuals > budgets.visualsPerSection) warn(`${p}.blocks`, `${visuals} charts in one section; keep ≤ ${budgets.visualsPerSection} (one idea per section).`);
    if (callouts > budgets.calloutPerSection) warn(`${p}.blocks`, `${callouts} callouts; keep ≤ ${budgets.calloutPerSection} per section.`);
    if (slides) {
      const n = slides.filter(s => s.section === si).length;
      if (n > budgets.slidesPerSection) warn(`${p}`, `Section needs ${n} slides; it is over the slide budget — cut or split it.`);
    }
  });
  if (total > budgets.visualsPerReport) warn('sections', `${total} charts in the report; keep ≤ ${budgets.visualsPerReport}. Too many visuals hide the point.`);
  if (spec.kind === 'decision' && !kindsUsed.has('options') && !kindsUsed.has('proscons')) warn('sections', 'Decision report without an options or proscons block; compare the options on the same criteria.');
  if ((spec.kind === 'investigation') && !kindsUsed.has('timeline') && !kindsUsed.has('flow') && !kindsUsed.has('sequence')) warn('sections', 'Investigation without a timeline, flow or sequence; show what happened and why.');
  return w;
}
