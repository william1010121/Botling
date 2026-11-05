import { isAbsolute, resolve } from 'node:path';
import type { Kind } from './core/i18n';
import type { AnyBlockDef } from './core/registry';
import { retiredCharts } from './blocks';
import { isSvg } from './blocks/image';
import { markdownBullets, textUnits } from './core/text';
import { lintReadability } from './readability';
import type { Issue, ReportSpec } from './spec';
import type { SlidePlan } from './planner';

/** Concise executive budgets (status, plan, decision). Warnings never block rendering; they go back to the bot for one rewrite. */
export const budgets = {
  takeawayUnits: 30, tldrSentences: 3, bullets: 6, bulletDepth: 2, proseUnits: 300,
  calloutPerSection: 1, visualsPerSection: 2, visualsPerReport: 8, tableRows: 8, timelineItems: 12, flowNodes: 12, slidesPerSection: 2, mainBullets: 3, mainCallouts: 1,
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

/** A valid figure block, the example warnings point to. */
export const figureExample = { type: 'figure', title: '加 SESS 後 9 人中 9 人變好', script: 'figures/paired.py', args: ['results/per_subject.csv', '2a', '跨受試者', 'MAtt', '25'], alt: '每位受試者不加與加 SESS 的準確率', caption: '一欄一人：空心 = 不加、實心 = 加；綠色線段 = 變好；虛線 = 亂猜。' };
export const flowchartExample = { type: 'figure', role: 'flowchart', title: '同一份資料，只差有沒有先做 SESS', script: 'figures/flowchart.py', args: ['figures/pipeline.json'], alt: '流程：原始腦波 → 不加 / 加 SESS → 同一模型 → 兩種考法 → 配對比較', caption: '兩條路只差藍色那一步，其餘完全相同。' };
export const collapsedExample = { title: '精確數值', takeaway: '每格的平均與 95% 區間', collapsed: true, blocks: [{ type: 'table', columns: ['設定', '不加 → 加', '差距（95% 區間）'], rows: [['2a · 跨受試者 · MAtt', '41.9 → 50.8', '+8.9（2.2～15.6）']] }] };

/** A cell that is a measured value: a number, or text that starts with one ("41.9 → 50.8", "+8.9（2.2～15.6）", "66 / 69"). */
const NUMERIC_CELL = /^[\s+\-−–~≈±]*\d/;
const isNumericCell = (c: unknown) => typeof c === 'number' || (typeof c === 'string' && NUMERIC_CELL.test(c)) || (!!c && typeof c === 'object' && NUMERIC_CELL.test(String((c as { text?: unknown }).text ?? '')));
export function numericTable(rows: unknown[][]): boolean {
  const cells = rows.flatMap(r => r.slice(1));
  const n = cells.filter(isNumericCell).length;
  return n >= 4 && n >= cells.length / 2;
}

/**
 * The page is charts with a short explanation under each; supporting detail is collapsed below. Warned in the main
 * (not collapsed) part: a numeric table, a long bullet list, many callouts; anywhere: the same figure drawn twice; an
 * experiment report without a flowchart figure; in experiment reports, a main section with no chart.
 */
export function lintLayout(spec: ReportSpec, baseDir = process.cwd()): Issue[] {
  const w: Issue[] = [];
  const warn = (path: string, message: string, example?: unknown) => w.push({ path, message, ...(example ? { example } : {}) });
  const seen = new Map<string, string>();
  const figureAt = (path: string, f: { script?: unknown; args?: unknown }) => {
    if (typeof f.script !== 'string') return;
    const key = JSON.stringify([isAbsolute(f.script) ? f.script : resolve(baseDir, f.script), f.args ?? []]);
    const first = seen.get(key);
    if (first) warn(`${path}.script`, `The same figure (script ${f.script} with the same args) is already drawn at ${first}. Show each chart once: delete this one, or draw a different view (another condition, model or question).`, figureExample);
    else seen.set(key, path);
  };
  let callouts = 0, flowcharts = 0, firstCallout = '';
  spec.sections.forEach((sec, si) => {
    const p = `sections[${si}]`;
    let charts = 0;
    sec.blocks.forEach((b, bi) => {
      const bp = `${p}.blocks[${bi}]`;
      const any = b as Record<string, any>;
      if (b.type === 'kpi') charts++;
      if (b.type === 'figure') { figureAt(bp, any); charts++; if (any.role === 'flowchart') flowcharts++; }
      if (b.type === 'experiment' && any.figure) { figureAt(`${bp}.figure`, any.figure); charts++; }
      if (sec.collapsed) return;
      if (b.type === 'table' && numericTable(any.rows)) warn(`${bp}`, 'A table of numbers in the main part: make it a figure (a .py reading the result files) with a one-sentence reading guide; the exact values go in a table in a collapsed section ("collapsed": true) below.', figureExample);
      if (b.type === 'prose') {
        const { count } = markdownBullets(any.text);
        if (count > budgets.mainBullets) warn(`${bp}.text`, `${count} bullets in the main part; keep ≤ ${budgets.mainBullets}. Say the point under its chart in one or two sentences, and move the list to a collapsed section ("collapsed": true).`, collapsedExample);
      }
      if (b.type === 'callout' && ++callouts === 1) firstCallout = bp;
    });
    if (!sec.collapsed && charts === 0 && spec.kind === 'experiment' && !sec.blocks.every(b => b.type === 'sources'))
      warn(`${p}`, `Main section "${sec.title}" has no chart. The main part is charts with a short explanation under each: add a figure, or mark the section "collapsed": true (supporting detail: checks, limitations, glossary, exact values).`, collapsedExample);
  });
  if (callouts > budgets.mainCallouts) warn(firstCallout, `${callouts} callouts in the main part; keep ≤ ${budgets.mainCallouts}. Put caveats under the chart they qualify, or in a collapsed section.`, collapsedExample);
  if (spec.kind === 'experiment' && flowcharts === 0) warn('sections[0]', 'Experiment report without a flowchart: open with one or more flowchart figures (role "flowchart", drawn by flowchart.py in the clean-flowchart style) showing the whole pipeline — the data, what is compared, how it is evaluated — before the result charts.', flowchartExample);
  return w;
}

const sentences = (s: string) => s.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/).filter(x => x.trim()).length;

export function lintSpec(spec: ReportSpec, registry: Map<string, AnyBlockDef>, slides?: SlidePlan[], baseDir?: string): Issue[] {
  const bBudget = budgetsFor(spec.kind);
  const w: Issue[] = [];
  const warn = (path: string, message: string, example?: unknown) => w.push({ path, message, ...(example ? { example } : {}) });
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
      if (retiredCharts.has(b.type)) warn(bp, `${b.type} is no longer a block to choose: the renderer draws no charts of its own, so this one shows only a table of its values. Draw every data chart as a figure block (a matplotlib .py that reads the data from your result files; see "Figures (matplotlib)" in the guide), and put exact values in a table in a collapsed section.`, figureExample);
      if (b.type === 'matrix' && (any.cells as unknown[][]).some(r => r.some(c => typeof c === 'number'))) warn(`${bp}.cells`, 'A matrix of numbers is a heatmap, a data chart: draw it as a figure block (matplotlib reading the data from your result files) and keep matrix for placing item names. The numbers now show as plain values.', figureExample);
      if (b.type === 'kpi' && (any.items as { spark?: unknown }[]).some(i => i.spark)) warn(`${bp}.items`, 'kpi sparklines are no longer drawn: draw the trend as a figure block, or leave spark out.', figureExample);
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
      if (b.type === 'image' && isSvg(any.src)) warn(`${bp}.src`, 'SVG images are disabled and not shown (hand-coded SVG charts overlap their labels): draw charts and diagrams as a figure block (a .py; flowcharts with flowchart.py), and use image only for PNG / JPEG screenshots.', figureExample);
    });
    if (visuals > bBudget.visualsPerSection) warn(`${p}.blocks`, `${visuals} charts in one section; keep ≤ ${bBudget.visualsPerSection} (one idea per section).`);
    if (callouts > bBudget.calloutPerSection) warn(`${p}.blocks`, `${callouts} callouts; keep ≤ ${bBudget.calloutPerSection} per section.`);
    if (slides) {
      const n = sec.collapsed ? 0 : slides.filter(s => s.section === si).length; // collapsed detail is the appendix
      if (n > bBudget.slidesPerSection) warn(`${p}`, `Section needs ${n} slides; it is over the slide budget — cut or split it.`);
    }
  });
  if (total > bBudget.visualsPerReport) warn('sections', `${total} charts in the report; keep ≤ ${bBudget.visualsPerReport}. Too many visuals hide the point.`);
  if (spec.kind === 'decision' && !kindsUsed.has('options') && !kindsUsed.has('proscons')) warn('sections', 'Decision report without an options or proscons block; compare the options on the same criteria.');
  if ((spec.kind === 'investigation') && !kindsUsed.has('timeline') && !kindsUsed.has('flowchart') && !kindsUsed.has('flow') && !kindsUsed.has('sequence')) warn('sections', 'Investigation without a timeline, flowchart or sequence; show what happened and why.');
  if (spec.kind === 'results' && !['figure', 'kpi', 'table', 'beforeafter', 'bar', 'trend'].some(t => kindsUsed.has(t))) warn('sections', 'Results report without a figure, kpi or table block; consider showing measured evidence when available; state missing measurements or baselines explicitly.');
  return [...w, ...lintLayout(spec, baseDir), ...lintReadability(spec)];
}
