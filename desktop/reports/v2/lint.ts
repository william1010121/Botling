import { readFileSync } from 'node:fs';
import type { Kind } from './core/i18n';
import type { AnyBlockDef } from './core/registry';
import { retiredCharts } from './blocks';
import { markdownBullets, textUnits } from './core/text';
import { lintReadability } from './readability';
import type { Issue, ReportSpec } from './spec';
import type { SlidePlan } from './planner';

/** Concise executive budgets (status, plan, decision). Warnings never block rendering; they go back to the bot for one rewrite. */
export const budgets = {
  takeawayUnits: 30, tldrSentences: 3, bullets: 6, bulletDepth: 2, proseUnits: 300,
  calloutPerSection: 1, visualsPerSection: 2, visualsPerReport: 8, tableRows: 8, timelineItems: 12, flowNodes: 12, slidesPerSection: 2, svgTextTags: 10,
};

/** Relaxed budgets for technical/scientific reports that define terms, explain charts, and show full subject/cohort tables. */
export const researchKinds = new Set<Kind>(['investigation', 'explainer', 'results', 'comparison', 'experiment']);
export const researchBudgets = {
  ...budgets,
  takeawayUnits: 48,
  proseUnits: 600,
  tableRows: 16,
};

export function budgetsFor(kind?: Kind) {
  return kind && researchKinds.has(kind) ? researchBudgets : budgets;
}

function svgTextCount(src: string): number {
  let svg = '';
  if (src.startsWith('data:image/svg+xml;base64,')) {
    try { svg = Buffer.from(src.slice(26), 'base64').toString('utf8'); } catch { return 0; }
  } else if (src.startsWith('data:image/svg+xml,')) {
    try { svg = decodeURIComponent(src.slice(19)); } catch { return 0; }
  } else if (/\.svg$/i.test(src) && !/^[a-z]+:/i.test(src)) {
    try { svg = readFileSync(src, 'utf8'); } catch { return 0; }
  } else return 0;
  return (svg.match(/<text[\s>]/gi) ?? []).length;
}

const sentences = (s: string) => s.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/).filter(x => x.trim()).length;

export function lintSpec(spec: ReportSpec, registry: Map<string, AnyBlockDef>, slides?: SlidePlan[]): Issue[] {
  const bBudget = budgetsFor(spec.kind);
  const w: Issue[] = [];
  const warn = (path: string, message: string) => w.push({ path, message });
  if (sentences(spec.tldr) > bBudget.tldrSentences) warn('tldr', `TL;DR has ${sentences(spec.tldr)} sentences; keep ≤ ${bBudget.tldrSentences}, answer first.`);
  if (spec.status && (spec.status.level === 'at_risk' || spec.status.level === 'off_track') && !spec.status.reason) warn('status.reason', 'at_risk / off_track needs a reason: the cause and the fix in one line.');
  if (spec.asks === undefined && (spec.kind === 'decision' || spec.kind === 'status' || spec.kind === 'plan')) warn('asks', 'End with asks (owner, deadline) or "asks": [] for "No action needed".');
  let total = 0;
  const kindsUsed = new Set<string>();
  spec.sections.forEach((sec, si) => {
    const p = `sections[${si}]`;
    if (!sec.takeaway && !sec.blocks.every(b => b.type === 'sources')) warn(`${p}.takeaway`, `Section "${sec.title}" has no takeaway; write its conclusion as one sentence (it becomes the slide headline).`);
    else if (sec.takeaway && textUnits(sec.takeaway) > bBudget.takeawayUnits) warn(`${p}.takeaway`, `Takeaway is long (${Math.round(textUnits(sec.takeaway))} units); keep ≤ ${bBudget.takeawayUnits} (≈ 22 CJK chars or 15 words in status/plan/decision; ≤ ${researchBudgets.takeawayUnits} in research kinds).`);
    let visuals = 0, callouts = 0;
    sec.blocks.forEach((b, bi) => {
      const bp = `${p}.blocks[${bi}]`;
      kindsUsed.add(b.type);
      const def = registry.get(b.type);
      if (!def) return;
      const any = b as Record<string, any>;
      if (retiredCharts.has(b.type)) warn(bp, `${b.type} is no longer a block to choose: draw every data chart as a figure block (a matplotlib .py that reads the data from your result files; see "Figures (matplotlib)" in the guide), or use a table for exact values.`);
      if (b.type === 'matrix' && (any.cells as unknown[][]).some(r => r.some(c => typeof c === 'number'))) warn(`${bp}.cells`, 'A matrix of numbers is a heatmap, a data chart: draw it as a figure block (matplotlib reading the data from your result files) and keep matrix for placing item names.');
      if (def.visual) { visuals++; total++; if (!any.title) warn(`${bp}.title`, `${b.type} has no title; charts need an action title that states what it shows.`); }
      if (b.type === 'callout') callouts++;
      if (b.type === 'prose') {
        const { count, depth } = markdownBullets(any.text);
        if (count > bBudget.bullets) warn(`${bp}.text`, `${count} bullets; keep ≤ ${bBudget.bullets} (split the section or use checklist).`);
        if (depth > bBudget.bulletDepth) warn(`${bp}.text`, `Bullets nested ${depth} levels; keep ≤ ${bBudget.bulletDepth}.`);
        if (textUnits(any.text) > bBudget.proseUnits) warn(`${bp}.text`, `Prose is ${Math.round(textUnits(any.text))} units; evidence too long — keep ≤ ${bBudget.proseUnits}, move detail to an appendix file.`);
      }
      if (b.type === 'table' && any.rows.length > bBudget.tableRows) warn(`${bp}.rows`, `${any.rows.length} rows; keep ≤ ${bBudget.tableRows} in the body.`);
      if (b.type === 'timeline' && any.items.length > bBudget.timelineItems) warn(`${bp}.items`, `${any.items.length} events; keep ≤ ${bBudget.timelineItems}.`);
      if ((b.type === 'flowchart' || b.type === 'flow') && any.nodes.length > bBudget.flowNodes) warn(`${bp}.nodes`, `${any.nodes.length} nodes; keep ≤ ${bBudget.flowNodes} or split the flowchart.`);
      if (b.type === 'options' && any.options.length < 2) warn(`${bp}.options`, 'Show at least two options (include "do nothing").');
      if (b.type === 'image' && typeof any.src === 'string') {
        const nText = svgTextCount(any.src);
        if (nText > bBudget.svgTextTags) warn(`${bp}.src`, `SVG image has ${nText} <text> elements (> ${bBudget.svgTextTags}); hand-coded data-chart SVGs cause CJK text overlap — draw data charts as a figure block (matplotlib), or use table, flow/flowchart or kpi blocks.`);
      }
    });
    if (visuals > bBudget.visualsPerSection) warn(`${p}.blocks`, `${visuals} charts in one section; keep ≤ ${bBudget.visualsPerSection} (one idea per section).`);
    if (callouts > bBudget.calloutPerSection) warn(`${p}.blocks`, `${callouts} callouts; keep ≤ ${bBudget.calloutPerSection} per section.`);
    if (slides) {
      const n = slides.filter(s => s.section === si).length;
      if (n > bBudget.slidesPerSection) warn(`${p}`, `Section needs ${n} slides; it is over the slide budget — cut or split it.`);
    }
  });
  if (total > bBudget.visualsPerReport) warn('sections', `${total} charts in the report; keep ≤ ${bBudget.visualsPerReport}. Too many visuals hide the point.`);
  if (spec.kind === 'decision' && !kindsUsed.has('options') && !kindsUsed.has('proscons')) warn('sections', 'Decision report without an options or proscons block; compare the options on the same criteria.');
  if ((spec.kind === 'investigation') && !kindsUsed.has('timeline') && !kindsUsed.has('flowchart') && !kindsUsed.has('flow') && !kindsUsed.has('sequence')) warn('sections', 'Investigation without a timeline, flowchart or sequence; show what happened and why.');
  if (spec.kind === 'results' && !['figure', 'kpi', 'table', 'beforeafter', 'bar', 'trend'].some(t => kindsUsed.has(t))) warn('sections', 'Results report without a figure, kpi or table block; consider showing measured evidence when available; state missing measurements or baselines explicitly.');
  return [...w, ...lintReadability(spec)];
}
