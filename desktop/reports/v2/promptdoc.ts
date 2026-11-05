import { z } from 'zod';
import { guideBlocks as blocks } from './blocks';
import { budgets, researchBudgets } from './lint';
import { minimalExample, reportSpecSchema } from './spec';
import type { Kind } from './core/i18n';

/** JSON Schema of the whole ReportSpec v2, generated from the registry. */
export function jsonSchema(): object {
  return z.toJSONSchema(reportSpecSchema, { io: 'input', unrepresentable: 'any' });
}

/** Report skeletons from the writing handbook: per kind, which sections and blocks, in order. */
export const skeletons: Record<Kind, { purpose: string; sections: string[] }> = {
  status: { purpose: 'Software progress / feature status: where things stand against the plan, what changed since last time, and what needs a decision. Outcomes, not activity.', sections: [
    'tldr = one-sentence status + why + the decision needed; `status.level` defined in advance: on_track = within tolerance, at_risk = at risk with a recovery plan, off_track = a commitment is broken or a decision above the team is needed; any blocking red makes the whole report red',
    'impact = the effect on the goal (release date, users, cost), planned vs now; risk = the biggest risk + road to green (who, what, by when) and whether the team can recover alone',
    'table (dimension | status | one-line reason with a number): schedule, scope, quality, resources — or kpi (target vs actual, delta, spark); stack:true for status counts',
    'table or timeline — planned vs actual per milestone: done / not done + expected date (never "80% done"); carry-overs and scope changes stated',
    'checklist — 2–5 outcomes since the last report, each "讓［誰］能［做什麼］→［可量測結果］", not activities; a figure of the rate over 3–5 cycles when a rate matters (never one cycle alone; velocity plans, it does not grade the team)',
    'next (even tentative) + confidence in the milestone; asks (owner, deadline) — or [] for "No action needed"',
    'last section for engineers (`"collapsed": true`): technical details, alternatives considered, PR / issue references in sources ≤ 4',
  ] },
  decision: { purpose: '"Decision needed: X by date" with a recommendation.', sections: ['tldr = the recommendation + the deadline; impact = what changes for the goal if we pick it', 'prose: context in SCQA, 2–3 sentences, terms defined', 'options (2–4 incl. "do nothing", same criteria: cost, risk, time, reversibility) with recommended + verdict', 'proscons, or a figure of effort × impact — why the others lose', 'callout tone=warn: the main risk / assumption (or `risk`)', 'asks: who decides, by when'] },
  investigation: { purpose: 'Investigation: what broke or what we found, why, and whether it is fixed.', sections: ['tldr = the finding or cause in plain language + impact + fixed now?; impact = who or what is affected and how much', 'glossary or prose: the setup and one plain sentence per domain term, before any metric', 'flowchart plus a table — show the multistep cause and the evidence for each link; mark pending inferences', 'timeline (events) — only when timing explains the cause', 'figure (before/after, signed deltas or the metric over time, with the baseline drawn in) or a table — the metric before/after the fix, against its baseline', 'checklist — actions with owners (blameless: name the activity, not the person)', 'sources ≤ 4'] },
  comparison: { purpose: 'Which one, and "pick X if…, Y if…".', sections: ['tldr = plain question + the winner + when to pick the other', 'prose or glossary: plain-language criteria and baseline definitions (1–3 sentences)', 'options or table with the winning cells toned good', 'figure (one question per chart; signed deltas and a reference line drawn in) — optional', 'callout: caveats'] },
  plan: { purpose: 'Goal, definition of done, path there.', sections: ['tldr = goal + definition of done + date; risk = the top risk and its response', 'timeline (gantt with lanes, today) or roadmap', 'flowchart — dependencies / critical path', 'steps — the first step; next; asks — decision needed'] },
  results: { purpose: 'What the numbers say after a change (product or system metrics). For an ML / deep-learning experiment use kind `experiment`.', sections: ['tldr = plain question + headline answer against its baseline + what it means; impact = the consequence in the reader\'s units', 'glossary or prose: plain-language setup, what the baseline is, one sentence per domain term', 'kpi vs baseline (delta, target)', 'figure of the metric over time with marks at the change and the target line', 'figure or table (before/after, signed values and a reference line; add a 1-sentence reading guide) — segment breakdown', 'prose: verified facts and pending inferences, with the reason and what remains unchecked', 'sources ≤ 4'] },
  explainer: { purpose: 'Explainer: what it is and how it works, for a reader outside the field.', sections: ['tldr = one plain sentence what + why it matters (no acronym stacking)', 'glossary — everyday analogy + one plain sentence per technical term', 'flowchart plus a table — show the multistep mechanism and explain each link', 'steps — only for an ordered procedure', 'figure / table / image — a worked example with a 1-sentence reading guide', 'callout — limits'] },
  experiment: { purpose: 'ML / deep-learning experiment: the answer, the pipeline as flowcharts, every individual result as charts, then whether the change worked and is the gap real; supporting detail collapsed.', sections: [
    'the verdict card comes first (automatically): tldr = the answer in one plain sentence + the key number against its baseline + whether the gap is real (n runs; "不顯著" when inside the noise); impact = what it means for the research question; risk = the main doubt (underfitting, leakage, small n) and how it will be checked; next; asks',
    'first section = one or more flowcharts (`figure` with `role: "flowchart"`, drawn by `flowchart.py` from a diagram JSON): the whole pipeline (data → the compared variants → model → evaluation → comparison); add a second one when the evaluation split or another stage needs its own picture (e.g. cross-subject vs cross-session). Caption = the one thing to notice (e.g. "the two paths differ only in the blue step")',
    '`overview` (question, compare, setup, complete = what counts as complete training, why) — shown collapsed right after the flowcharts for the reader who wants the setup in words',
    'the complete results: a `figure` with `perUnit: true` — one panel per compared condition, the units (subjects, samples, tasks…) on the x axis, one colour per model as dots or grouped bars (never lines), each model\'s mean in the panel title, fully trained runs only, 未跑 panels listed in `missing`; caption = how to read it',
    'the gaps: a `figure` of each comparison\'s difference with its 95% interval (one row per condition × model, 0 drawn in) — this replaces the big table of means; under-trained or exploratory runs (e.g. a shorter training) as a labelled contrast in the same chart or the next one, never in the complete-results chart',
    'an `experiment` card per main hypothesis, each with its own `figure` (e.g. `paired.py`: each unit\'s baseline → method for that one comparison) and the 95% interval of the difference; never the same script and args as another chart',
    'collapsed sections (`"collapsed": true`), in this order as needed: glossary (every acronym, model, dataset and metric in plain words); sanity checks (chance level, the paper\'s score for the same protocol, convergence / training accuracy, a fair cross-dataset metric); exact values (the table of means, intervals, wins / losses); error analysis, ablations, what was ruled out and what is missing; limitations; reproducibility (data files, the figure and extraction scripts, how numbers are computed) → sources ≤ 4',
  ] },
};

/** The writing rules (from the report-writing research: BLUF / pyramid, layering, plain language, honest numbers). */
export const rules = [
  '**Answer first (BLUF).** The first `tldr` sentence is the conclusion and answers the user\'s question ("You asked X; the answer is Y"); never background, never "this report…". If it cannot, do not publish the page: answer in chat. `tldr` ≤ 3 sentences.',
  '**The first page holds five things.** The verdict card shows (1) `tldr`: one-sentence status or result; (2) `impact`: what it means for the goal, in the reader\'s terms (users, time, money, the research question); (3) `asks` (what, who, by): the decision or help needed, shown right under the card — or `"asks": []` for "No action needed"; (4) `risk` (text, plan): the biggest risk and what is done about it; (5) `next`: ≤ 3 next steps, even tentative ones. Reading only the card, the reader can say the status, the impact and what they must decide. In every report the card comes first; in an `experiment` report the flowcharts and the complete-results chart follow it (see that kind).',
  '**Headline = takeaway.** Every section has `takeaway`: its conclusion as one sentence (≈ 22 CJK chars / 15 words in `status`/`plan`/`decision`; up to 48 units in `investigation`/`explainer`/`results`/`comparison`/`experiment`). Write "登入延後 1 週，原因是 API 限流", never a topic such as "進度說明" or "結果". `title` is the short topic label. Reading only the takeaways in order gives the whole argument.',
  '**Charts first, detail collapsed (以圖為主，細節收起來).** The page reads as units of "a chart + a short explanation under it": the chart\'s action title says the point, its `caption` (or one or two sentences of `prose`) says how to read it and what it means. Layer 1, for everyone: the verdict card. Layer 2: the main sections — the flowcharts, then the key charts. Layer 3, for whoever needs it: supporting detail in sections with `"collapsed": true` (rendered below the main part as closed `<details>`): baseline / sanity checks, limitations, per-model breakdowns, tables of exact values, glossary, reproducibility, sources. In the main part: no table of numbers (make it a figure; the exact values go in a collapsed table), ≤ 3 bullets per list, ≤ 1 callout. One idea per section; ≤ 2 charts per section, ≤ 8 in the report.',
  '**Plain language before jargon: define every term once (先講人話，術語首次定義).** Say the plain question, setup and everyday answer before the numbers. Each acronym, model or dataset name, and metric symbol (`κ`, `Δκ`, SESS, LOSO, whitening / 白化) gets one plain sentence or everyday analogy the first time it appears: a `glossary` block in the first section, or the plain words first with the term in brackets ("留一受試者驗證（LOSO）"). Use the same word for the same thing everywhere; prefer an everyday word to an acronym. Never stack unexplained acronyms in `title`, `tldr` or `takeaway`. Plain language is writing for your reader, not lowering the level.',
  '**Every number has a reference point and a meaning.** Give the comparison (plan, previous version, last week, chance level, the paper\'s score) and the unit, then say what the gap means in the reader\'s units: not "準確率 92%" but "92%（現行規則 85%）：每 100 張多抓對 7 張". Prefer "done / not done + expected date" to "80% done". Show what changed since the last report rather than repeating its history.',
  '**One question per chart + one-sentence reading guide (一張圖只回答一個問題＋一句看圖指南).** Every chart has an action title stating its conclusion and direct labels; never repeat a KPI as a chart. Never cram two scales, baselines or questions into one figure: split them. Give each non-trivial chart a one-sentence reading guide (`note` or a short `prose`) saying what taller / shorter or left / right of `0` means, and what n and the error bars are. Axes start at 0 for amounts; no decoration that carries no data.',
  '**Every chart is drawn by Python: a matplotlib `figure`, never hand-written SVG (所有圖表都用 Python 畫；SVG 已停用).** The renderer draws no chart of its own. Every chart of data — comparisons, signed deltas against chance or a target, trends over time, before/after, shares, heatmaps, per-subject scores, small multiples, scatter, distributions, error bars, curves — is a `figure` block: your own matplotlib `.py` script that reads the data from the result files (never numbers typed into the script); the renderer runs it and embeds the chart (see "Figures (matplotlib)"). A process diagram — the pipeline, how data is split, what is compared — is a `figure` too, with `role: "flowchart"`, drawn by the `flowchart.py` template in the clean-flowchart style (rounded boxes, right-angle arrows, colour only where it means a category). Each chart appears once: the same script with the same args twice is warned. Exact values the reader looks up go in a `table` in a collapsed section; headline numbers in `kpi`. The old native chart blocks (`bar`, `trend`, `donut`, `beforeafter`, `quadrant`) are no longer drawn — older specs show their values as a plain table, with a warning; a `matrix` of numbers shows plain values; `kpi` sparklines are not drawn; SVG images (`image` with an `.svg` or `data:image/svg+xml` source) are disabled and shown as their alt text. `image` is for PNG / JPEG screenshots only.',
  '**Use ASD-STE100-informed plain language.** Active voice, direct verbs, "who does what", consistent terms. Prefer short sentences, but keep a cause and its effect in one sentence: "X 因為 Y，所以 Z" stays whole; never cut a causal chain into fragments or drop the "because" to save length, and never cut background the reader needs to follow the argument. Keep useful technical names. These are writing guidelines, not renderer checks or formal ASD-STE100 compliance for Chinese.',
  '**Explain uncertainty.** Separate verified facts from pending inferences. Give the reason for each inference and state what remains unchecked. Do not assign mechanical confidence percentages. Use numerical probabilities only when supported by a stated method and evidence.',
  '**Explain causes visually.** For multistep causes, prefer a flowchart plus a table of evidence. Show how each step leads to the next. Distinguish observed links from pending inferences; do not invent links to complete the diagram.',
  '**Be honest early.** Bad news and the biggest risk go on the first page, never the last line. Report outcomes, not activity ("讓客服一鍵查訂單，處理時間 6 → 4 分鐘", not "開了 5 場會、改了 30 個 PR"). A yellow or red `status` needs a road to green (who does what, by when), whether the team can recover alone, and an ask. Describe problems by activity and fix, never by naming a person (blameless). Do not paint red as amber.',
  '**Write for the reader.** Omit routine defensive boilerplate and internal coordination jargon. Keep research-only handback details, test commands, and preview-tool details in the internal handback. Evidence is short: a short source and a number per claim, ≤ 4 `sources`, no long paths, hashes or logs in prose. State material uncertainty and failed checks that affect the decision, with their practical effect. Never conceal defects or claim unperformed validation.',
  '**Experiments (ML / deep learning): see kind `experiment`.** The order is fixed: the verdict card (the answer, impact, risk, next) → one or more flowcharts of the pipeline → the setup (`overview`, shown collapsed) → the complete-results chart (one panel per compared condition, units on the x axis, one colour per model as dots or grouped bars, never lines, each model\'s mean in the panel title, 未跑 for panels not run, fully trained runs only) → the gaps with their intervals as a chart → the experiment cards, each with its own chart → collapsed detail (checks, exact values, under-trained runs as a contrast, limitations, reproducibility). State the question, a falsifiable hypothesis and the success criterion before the results. Compare with an equally tuned baseline on the same data split, preprocessing, seeds and training length; change one thing at a time. Run ≥ 3 seeds and give mean ± std, saying what ± is (std or SE, across seeds or subjects, n). A gap inside the variance, or an interval that crosses 0, is "not significant", never "an improvement". Report error analysis, ablations and negative results ("what we ruled out, what it saved, what next"); do not generalise beyond the data you tested.',
  '**Forbidden:** topic-only headings, narrating your process chronologically, the conclusion at the end, activity lists instead of outcomes, evidence dumps, decorative charts, numbers with no baseline, unexplained acronyms, best-seed-only results, one-sided options, vague hedging, mixing report kinds.',
];

/** What lintReadability (readability.ts) and lintSpec warn about, for the bots. */
export const checks = [
  'the first `tldr` sentence opens with background ("本報告…", "為了…", "We ran…") instead of the answer;',
  'a missing first-page item: `impact` (status, decision, investigation, results, experiment), `risk` (status, plan, experiment), `next` (status, plan, experiment); a yellow / red `status` without `status.reason` or with `"asks": []`;',
  'a `takeaway` that is a topic ("結果", "進度說明", or the same as `title`), missing, or over the length budget;',
  'a number in `tldr`, `impact` or a `takeaway` with nothing to compare it to (no baseline, change, target, chance level or sign);',
  'an acronym, coined name (two or more capitals: LOSO, SESS, OpenBMI) or Greek symbol (κ, Δκ) used without a definition — in a `glossary` block, or written "plain words（TERM）" / "TERM（plain words）" where it first appears;',
  'kind `experiment` without `overview` (its `complete` field is required), without a flowchart (`figure` with `role: "flowchart"`; one or more are fine), or whose first data chart (flowcharts aside) is not a `figure` with `perUnit: true`;',
  'in the main (not collapsed) part: a table of numbers (make it a figure; exact values go in a collapsed section), a bullet list longer than 3 items, more than 1 callout; in `experiment` reports, a main section with no chart;',
  'the same figure (script and args) drawn twice, in figure blocks or experiment cards;',
  'kind `experiment` without an `experiment` block; an experiment card with < 3 runs, no `baselineTuned: true`, no `result.ci`, or verdict "supported" while the interval crosses 0; a `tldr` that claims an improvement while a card is inconclusive; experiment KPIs without delta or target;',
  'a native chart block (`bar`, `trend`, `donut`, `beforeafter`, `quadrant`), a `matrix` of numbers, a `kpi` sparkline or an SVG image: draw it as a `figure` instead;',
  'the budgets below (bullets, prose length, table rows, charts per section, chart titles, slides per section).',
  'Each layout warning carries an `example`: a valid block or section to copy.',
];

/** What the renderer cannot judge; the bot must. */
export const unchecked = [
  'whether the first sentence is really the answer to the user\'s question, and whether the `impact` is in the reader\'s terms;',
  'cause and effect kept together, one idea per section, the takeaways read in order as a summary;',
  'whether a definition is plain enough for a non-specialist to repeat it;',
  'whether the baseline is fair (same tuning budget, split, preprocessing), the test set was used once, and normalisation or feature selection was fitted on training folds only (no leakage);',
  'error analysis, per-group (per-subject) breakdown, ablations and negative results — the skeleton for `experiment` asks for them;',
  'whether every number can be traced to a run or a data source.',
];

/** How a `figure` block runs its script. */
export const figureDoc = [
  'A `figure` block names a `.py` script (absolute, or relative to the spec file) and optional `args`. When the page is rendered the script runs as `python3 -I` (or `$BOTLING_PYTHON`) with the spec\'s folder as working directory; your user site-packages (`pip3 install --user matplotlib`) is available, the script\'s own folder is not on `sys.path`, so keep it self-contained.',
  'Draw with matplotlib (`import matplotlib.pyplot as plt`, no `plt.show()`); the current figure is saved for you, or save it yourself to `os.environ["BOTLING_FIGURE_OUT"]`. The theme is already applied: CJK fonts, transparent background, text and grid colours; use `C0`…`C5` (blue, orange, green, purple, red, grey) for colours that follow light and dark mode — other colours stay fixed.',
  'Read the data from files (CSV, JSON, logs) passed in `args`; never type result numbers into the script. Draw every condition that should exist; one without results is an empty panel labelled 未跑, and list it in `missing`.',
  '`format`: `svg` (default; inline, sharp, recoloured for dark mode) or `png` (very many points; drawn once per theme). `timeout`: seconds (default 60). A missing script, a Python error, no figure or a timeout comes back in `errors` with the last lines of stderr; fix the script and render again.',
  'Every chart reads its numbers from the result files (CSV, JSON, logs) through `args`; the script holds the drawing, never the data. A flowchart reads its boxes and arrows from a small JSON file next to the spec.',
  'Template for flowcharts: `flowchart.py` in the same folder as this guide (copy it as is). Usage `flowchart.py diagram.json`; the JSON lists `nodes` (`id`, `x`, `y`, `w`, `h`, `text`, optional `color`: `neutral` or `C0`…`C5`), `edges` (`from` / `to` = [node id, side (left/right/top/bottom), optional 0–1 position], `route`: straight / hv / vh / vhv / hvh / auto, or `via` corner points; optional `label`, `dashed`, `color`), `texts` (stage labels) and `legend` (one entry per colour used). Pixels, y down; one row = one y, one column = one x, 40–60 px apart; only horizontal and vertical segments (a diagonal is an error). Colour only what means a category (e.g. the one step that differs). Keep labels short, ≤ 2 lines. Render, look at the page, fix overlaps. Example: `{"nodes": [{"id": "raw", "x": 0, "y": 40, "w": 150, "h": 60, "text": "原始腦波\\n資料集 A / B"}, {"id": "sess", "x": 200, "y": 40, "w": 150, "h": 60, "text": "加 SESS", "color": "C0"}], "edges": [{"from": ["raw", "right"], "to": ["sess", "left"]}], "legend": [{"color": "C0", "label": "只差這一步"}]}`.',
  'Template for an experiment card\'s chart: `paired.py long.csv ROW COL MODEL [CHANCE]` (same long CSV as `per_subject.py`): each unit\'s baseline (hollow) → method (filled), green = better, red = worse, the mean change and wins in the title.',
  'Template for the complete-results chart: `per_subject.py` in the same folder as this guide. Write a long CSV (columns row, col, unit, model, variant, value) from the raw result files and pass it; extra `ROW/COL` arguments force panels with no data (drawn 未跑). It draws one panel per row × col, units on the x axis, one colour per model, hollow = first variant (baseline) and filled = second (method), each model\'s means in the panel title. Usually it works as is; copy and adapt it only when it does not fit.',
];

/** The shape of a page in the charts-first layout. */
export const pageTemplate = [
  'Every report: the verdict card (the one-sentence answer, impact, risk, next) and the asks → main sections, each a chart with its explanation under it → collapsed sections for supporting detail. Sections marked `"collapsed": true` are always shown after the main ones, closed; the reader opens them.',
  'Experiment report, the sections in order (the setup in `overview` appears collapsed after the first one):',
  '',
  '```json',
  ...[
    { title: '流程', takeaway: '兩條路只差有沒有先做 SESS，其餘相同', blocks: [{ type: 'figure', role: 'flowchart', title: '…', script: 'flowchart.py', args: ['pipeline.json'], alt: '…', caption: '…' }, { type: 'figure', role: 'flowchart', title: '…', script: 'flowchart.py', args: ['split.json'], alt: '…', caption: '…' }] },
    { title: '完整結果', takeaway: '…', blocks: [{ type: 'figure', perUnit: true, title: '…', script: 'per_subject.py', args: ['complete_results.csv'], alt: '…', caption: '…', missing: ['…'] }] },
    { title: '差距', takeaway: '…', blocks: [{ type: 'figure', title: '…', script: 'gaps.py', args: ['cells.csv'], alt: '…', caption: '…' }] },
    { title: '實驗卡', takeaway: '…', blocks: [{ type: 'experiment', '…': '…', figure: { script: 'paired.py', args: ['complete_results.csv', 'ROW', 'COL', 'MODEL'], alt: '…', caption: '…' } }] },
    { title: '名詞', takeaway: '…', collapsed: true, blocks: [{ type: 'glossary', items: ['…'] }] },
    { title: '基準檢查', takeaway: '…', collapsed: true, blocks: [{ type: 'table', columns: ['…'], rows: ['…'] }] },
    { title: '精確數值', takeaway: '…', collapsed: true, blocks: [{ type: 'table', columns: ['…'], rows: ['…'] }] },
    { title: '限制與重現', takeaway: '…', collapsed: true, blocks: [{ type: 'prose', text: '…' }, { type: 'sources', items: ['…'] }] },
  ].map(x => JSON.stringify(x)),
  '```',
  '',
  'Status, decision, plan, results: the same idea — the key charts (or the options) in the main part, the engineer-level detail (per-item tables, technical notes, alternatives, references) in collapsed sections.',
];

export const checklist = [
  'Reading only the verdict card, a lead can say the status, the impact and what they must decide.',
  'A reader outside the field can repeat the main point in their own words; every term is defined once.',
  'Every number has a baseline and a unit; key metrics are translated into consequences ("每 100 件…").',
  'ML results name the number of seeds and what the error bar is; gaps inside the variance are not called improvements.',
  'An experiment report opens with the answer, then one or more flowcharts of the pipeline, then the complete results per condition (units on the x axis, dots or bars, no lines; panels not run say 未跑).',
  'Each chart makes one point, its title states it, a sentence under it says how to read it; nothing is decorative and no chart appears twice.',
  'The main part is charts and short explanations; checks, limitations, exact-value tables and the glossary sit in collapsed sections.',
  'Bad news and the biggest risk are on the first page; yellow / red items have a road to green and an ask.',
  'Negative results say what was ruled out and what comes next; every number traces to a run or source.',
];

const short = (v: unknown): string => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.startsWith('data:image/') ? 'data:image/svg+xml;base64,…' : x));

function fieldLines(schema: Record<string, any>, indent = ''): string[] {
  const props: Record<string, any> = schema.properties ?? {};
  const req = new Set<string>(schema.required ?? []);
  const summarise = (p: any): string => {
    if (!p) return 'any';
    if (p.const !== undefined) return JSON.stringify(p.const);
    if (p.enum) return p.enum.map((e: unknown) => JSON.stringify(e)).join(' | ');
    if (p.anyOf || p.oneOf) return (p.anyOf ?? p.oneOf).map(summarise).join(' | ');
    if (p.type === 'array') {
      const lim = [p.minItems !== undefined && `≥${p.minItems}`, p.maxItems !== undefined && `≤${p.maxItems}`].filter(Boolean).join(' ');
      if (p.prefixItems) return `[${p.prefixItems.map(summarise).join(', ')}]`;
      return `${summarise(p.items)}[]${lim ? ` (${lim})` : ''}`;
    }
    if (p.type === 'object') return `{ ${Object.keys(p.properties ?? {}).map(k => `${k}${(p.required ?? []).includes(k) ? '' : '?'}`).join(', ')} }`;
    if (p.type === 'string') return `string${p.maxLength ? ` ≤${p.maxLength}` : ''}`;
    if (p.type === 'number' || p.type === 'integer') return `${p.type}${p.minimum !== undefined ? ` ≥${p.minimum}` : ''}${p.maximum !== undefined ? ` ≤${p.maximum}` : ''}`;
    if (p.type === 'boolean') return 'boolean';
    return 'any';
  };
  return Object.entries(props).filter(([k]) => k !== 'type' && k !== 'span').flatMap(([k, p]) => {
    const line = `${indent}- \`${k}${req.has(k) ? '' : '?'}\`: ${summarise(p)}${p.description ? ` — ${p.description}` : ''}`;
    const inner = p.type === 'array' ? p.items : p;
    const nested = !indent && inner?.type === 'object' && inner.properties ? fieldLines(inner, indent + '  ') : [];
    return [line, ...nested];
  });
}

export function promptDoc(): string {
  const out: string[] = [];
  out.push('# Botling report blocks (ReportSpec v2)', '');
  out.push('> Generated from `desktop/reports/v2/promptdoc.ts` and `desktop/reports/v2/blocks` by `node desktop/scripts/report.mjs --docs`. Do not edit by hand.', '');
  out.push('A report is JSON: header + `tldr` + `sections[] → blocks[]` + `asks`. You pick the blocks; layout, colours, fonts and the slide version are decided by the renderer. Write key points only.', '');
  out.push('## Rules', '');
  out.push('Readers skim: most read only the verdict card and the section headlines. Write so that reading only those gives the answer, its meaning and what to decide; put the evidence below for whoever needs it.', '');
  out.push(...rules.map((r, i) => `${i + 1}. ${r}`), '');
  out.push('## Checked by the renderer (warnings)', '', 'These come back in `warnings` with a path; fix them before delivering:', '', ...checks.map(c => `- ${c}`), '');
  out.push('## Not checked: rules only', '', ...unchecked.map(c => `- ${c}`), '');
  out.push('## Before you publish', '', ...checklist.map(c => `- [ ] ${c}`), '');
  out.push('## Page template: charts first', '', ...pageTemplate, '');
  out.push('## Figures (matplotlib)', '', ...figureDoc, '');
  out.push('## Generate', '', 'Use the report command your instructions name (the app\'s `--render-report`; in the Botling repo also `node desktop/scripts/report.mjs`). The output must be an `.html` path inside an `artifacts` folder (created if missing).', '', '```sh', '<report command> spec.json /abs/.bot/artifacts/report.html                   # document (no JavaScript)', '<report command> spec.json /abs/.bot/artifacts/report-slides.html --slides    # 16:9 slides', '<report command> spec.json /abs/.bot/artifacts/report.html --force           # replace an existing page', '<report command> --check spec.json                                             # validate only', '```', '');
  out.push('The CLI prints one JSON line: `{"ok", "errors": [{path, message, example}], "warnings": [{path, message}], "htmlPath", "link"}`. Fix every error (the `example` is a valid block of that type); fix warnings when you can, then render again (≤ 2 retries). A block with errors renders as a visible placeholder; the rest of the report still renders. Put `link` in your reply.', '');
  out.push('## Spec', '', '```json', JSON.stringify(minimalExample, null, 2), '```', '');
  out.push(...fieldLines((jsonSchema() as any)), '- section: `{ id?, title, takeaway?, layout?: "auto"|"stack"|"split"|"grid", blocks[] (≤8) }` — keep `layout` on auto unless you have a reason.', '');
  out.push('## Report kinds', '', 'Pick one `kind`; use its skeleton as the default section order (skip what you have no evidence for). In every kind, sections that only support the main point (checks, exact values, glossary, limitations, technical detail) get `"collapsed": true`.', '');
  for (const [kind, s] of Object.entries(skeletons)) {
    out.push(`### ${kind}`, '', s.purpose, '', ...s.sections.map((x, i) => `${i + 1}. ${x}`), '');
  }
  out.push('## Blocks', '', 'Every block takes optional `title` (action title), `note` (faint caption: unit, scope, source) and `span: "full"`. Statuses everywhere: `done | active | pending | blocked | risk | unverified | skipped`. Tones: `good | warn | bad | info | neutral`.', '');
  out.push(`| type | use for |`, `|---|---|`, ...blocks.map(b => `| \`${b.type}\` | ${b.description.replace(/\|/g, '/')} |`), '');
  for (const b of blocks) {
    const js = z.toJSONSchema(b.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, any>;
    out.push(`### \`${b.type}\``, '', b.description, '', `**When:** ${b.when}`, '', ...fieldLines(js), '', '```json', short(b.examples[0]), '```', '');
  }
  out.push('## Lint budgets', '', 'Default (`status`, `plan`, `decision`):', '', ...Object.entries(budgets).map(([k, v]) => `- \`${k}\`: ${v}`), '', 'Relaxed for technical/scientific kinds (`investigation`, `explainer`, `results`, `comparison`, `experiment`):', '', `- \`takeawayUnits\`: ${researchBudgets.takeawayUnits}`, `- \`proseUnits\`: ${researchBudgets.proseUnits}`, `- \`tableRows\`: ${researchBudgets.tableRows}`, '');
  return out.join('\n');
}
