import { withinNoise } from './blocks/experiment';
import type { Kind } from './core/i18n';
import type { Issue, ReportSpec } from './spec';

// Readability lint: the checks from the report-writing research that a machine can make. Like the
// budgets, these are warnings for the bot's one rewrite, never errors. What cannot be checked here
// (cause and effect kept together, one idea per paragraph, error analysis, ablations…) stays a
// written rule in the prompt doc.

/** First-page items per kind: the bottom line (tldr) is always required; these are warned when missing. */
const needsImpact = new Set<Kind>(['status', 'decision', 'investigation', 'results', 'experiment']);
const needsRisk = new Set<Kind>(['status', 'plan', 'experiment']);
const needsNext = new Set<Kind>(['status', 'plan', 'experiment']);

const sentencesOf = (s: string) => s.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+/).map(x => x.trim()).filter(Boolean);

/** Opening with background or with the report itself instead of the answer. */
const BACKGROUND_FIRST = /^(本報告|這份報告|此報告|本頁|這頁|本文|以下|背景[：:]|為了|我們(做了|進行了?|跑了|測試了?)|this (report|page|document)|in this (report|page)|below\b|background:|we (ran|did|tested|conducted)\b)/i;

/** Headings that name a topic instead of stating a conclusion. */
const TOPIC_ONLY = /^(概述|總覽|概覽|摘要|背景|說明|進度|進度說明|狀態|結果|實驗結果|成果|細節|詳細|方法|設定|討論|結論|附錄|其他|補充|分析|overview|summary|background|results?|details|progress|status|method(s|ology)?|setup|discussion|conclusions?|appendix|notes?|analysis|misc)$/i;

/** A metric-like number: percent, percentage points, durations, multiples, or a decimal (not versions or dates). */
const METRIC = /(?<![\w.\/:-])\d+(?:\.\d+)?\s?(?:%|％|pp\b|個?百分點|ms\b|秒|分鐘|小時|倍)|(?<![\w.\/:-])\d+\.\d+(?![\w.\/:-])/;
/** Anything that gives the number a reference point: a comparison word, a change, a sign, an arrow, a target or chance level. */
const COMPARED = /[（(][^）)]*\d|現行|現有|舊版|新版|前一版|上一版|比|較|vs\.?|對比|相對|從|到|升|降|提高|提升|增加|減少|下降|縮|高於|低於|高出|多|少|超過|未達|達到|達標|目標|基準|上週|上次|原本|原先|之前|亂猜|猜|隨機|論文|計畫|預計|預期|→|↑|↓|±|差|勝|輸|baseline|chance|paper|plan|target|previous|last|than|versus|from|compared|before|after|up\b|down\b|gain|drop|rise|[+＋−–]\s?\d|(?<![\w.])-\d/i;

/** Names readers know, so they need no definition. Product names with two capitals live here too. */
const KNOWN = new Set(('AI API APIs UI UX URL URLs CPU GPU GPUs RAM SSD HDD PR PRs ID IDs OK PDF HTML CSS JSON CSV CLI USB HTTP HTTPS SQL '
  + 'MB GB KB TB PNG SVG JPG JS TS QA FAQ ETA TODO CEO PM AM IT TV PC OS US UK EU UTC GMT CJK iOS macOS iPhone iPad MacBook '
  + 'GitHub GitLab YouTube ChatGPT OpenAI JavaScript TypeScript PowerPoint LinkedIn WhatsApp PyTorch TensorFlow NumPy SciPy '
  + 'VS AND OR NOT TL DR Q1 Q2 Q3 Q4 GET POST PUT PATCH DELETE README LICENSE NOTICE CHANGELOG MIT GPL LGPL EPL BSD MPL').split(' '));

/** Acronyms and coined names (two or more capitals: LOSO, SESS, MAtt, OpenBMI) and Greek metric symbols (κ, Δκ). */
const TERM = /(?<![A-Za-z0-9_])(?:[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z]{2,})(?![A-Za-z0-9_])|[Α-Ωα-ω]+[A-Za-z0-9]*/g;
const LONE_SYMBOL = new Set(['Δ', 'Σ']);
/** Blocks that show data as a chart or a grid of numbers. */
const CHARTS = new Set(['figure', 'bar', 'trend', 'donut', 'beforeafter', 'matrix', 'quadrant', 'kpi', 'table', 'image', 'progress']);

type Piece = { path: string; text: string };

/** Every reader-facing string of the report, in reading order, without code spans and links. */
function readingOrder(spec: ReportSpec): Piece[] {
  const out: Piece[] = [];
  const add = (path: string, text: unknown) => { if (typeof text === 'string' && text.trim()) out.push({ path, text: text.replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ') }); };
  add('title', spec.title); add('subtitle', spec.subtitle);
  for (const k of ['question', 'compare', 'setup', 'complete', 'why'] as const) add(`overview.${k}`, spec.overview?.[k]);
  add('tldr', spec.tldr); add('impact', spec.impact);
  add('risk.text', spec.risk?.text); add('risk.plan', spec.risk?.plan);
  spec.next?.forEach((n, i) => add(`next[${i}]`, n));
  spec.asks?.forEach((a, i) => add(`asks[${i}].what`, a.what));
  const SKIP = new Set(['type', 'src', 'script', 'args', 'role', 'collapsed', 'format', 'ref', 'id', 'from', 'to', 'span', 'spark', 'stack', 'tone', 'status', 'deltaDir', 'dir', 'layout', 'verdict', 'scale', 'sort', 'horizontal', 'stacked', 'highlight', 'best', 'recommended']);
  const walk = (path: string, v: unknown) => {
    if (typeof v === 'string') add(path, v);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${path}[${i}]`, x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP.has(k)) walk(`${path}.${k}`, x);
  };
  spec.sections.forEach((sec, si) => {
    add(`sections[${si}].takeaway`, sec.takeaway); add(`sections[${si}].title`, sec.title);
    sec.blocks.forEach((b, bi) => { if (b.type !== 'sources' && b.type !== 'glossary' && b.type !== '__error') walk(`sections[${si}].blocks[${bi}]`, b); });
  });
  return out;
}

/** Terms the report defines: glossary entries, plus a term written with its meaning right next to it. */
function definedAt(text: string, index: number, term: string): boolean {
  const before = text.slice(Math.max(0, index - 1), index);
  const after = text.slice(index + term.length, index + term.length + 3);
  return /[（(]/.test(before) || /^\s?[（(：:＝=]|^\s?(是|指|即|代表|means|is\b|=)/.test(after);
}

export function lintReadability(spec: ReportSpec): Issue[] {
  const w: Issue[] = [];
  const warn = (path: string, message: string) => w.push({ path, message });
  const kind = spec.kind;

  // 1. The first sentence is the conclusion, not background.
  const first = sentencesOf(spec.tldr)[0] ?? '';
  if (BACKGROUND_FIRST.test(first)) warn('tldr', 'The first sentence is background, not the answer. Start with the conclusion ("你問 X；答案是 Y"), then why it matters; move the setup to a section.');

  // 2. The rest of the first page: impact, biggest risk, next step, and an ask for any yellow/red light.
  if (kind && needsImpact.has(kind) && !spec.impact) warn('impact', 'No "impact": say in one sentence what this means for the goal, in the reader\'s terms (users, time, money, the research question). It is shown under the bottom line.');
  if (kind && needsRisk.has(kind) && !spec.risk) warn('risk', 'No "risk": name the biggest risk or open doubt and what is done about it, so it is on the first page and not hidden at the end.');
  if (kind && needsNext.has(kind) && !spec.next) warn('next', 'No "next": give ≤ 3 next steps, even tentative ones.');
  const noAsk = spec.asks !== undefined && spec.asks.length === 0;
  if (spec.status?.level === 'off_track' && noAsk) warn('asks', 'A red status with "No action needed": say what gets it back on track and who must decide or help, by when.');
  if (spec.status?.level === 'at_risk' && noAsk && !spec.risk?.plan) warn('risk.plan', 'A yellow status with no ask: give the road to green in risk.plan (who does what, by when), or ask for the help needed.');

  // 3. Headings state conclusions.
  spec.sections.forEach((sec, si) => {
    const t = sec.takeaway?.replace(/[\s。．.!！?？:：]+$/u, '').trim();
    if (t && (t === sec.title.trim() || TOPIC_ONLY.test(t))) warn(`sections[${si}].takeaway`, `Takeaway "${sec.takeaway}" names a topic; write what the section shows ("登入延後 1 週，原因是 API 限流", not "進度說明").`);
  });

  // 4. Numbers in the headline text carry a reference point.
  const headline: Piece[] = [{ path: 'tldr', text: spec.tldr }, ...(spec.impact ? [{ path: 'impact', text: spec.impact }] : []),
    ...spec.sections.flatMap((s, si) => (s.takeaway ? [{ path: `sections[${si}].takeaway`, text: s.takeaway }] : []))];
  for (const h of headline) {
    const bare = sentencesOf(h.text).find(s => METRIC.test(s) && !COMPARED.test(s));
    if (bare) warn(h.path, `"${bare.trim().slice(0, 40)}" gives a number with nothing to compare it to. Add the baseline (plan, previous version, last week, chance level, the paper) and what the gap means, e.g. "92%（現行規則 85%）：每 100 張多抓對 7 張".`);
  }

  // 5. Every acronym, coined name or symbol is defined once, in plain words, before or where it is first used.
  const glossary = spec.sections.flatMap(s => s.blocks).filter(b => b.type === 'glossary')
    .flatMap(b => ((b as { items?: { term: string }[] }).items ?? []).map(i => i.term.toLowerCase()));
  const isGlossed = (term: string) => glossary.some(g => g === term.toLowerCase() || g.split(/[\s/、,，()（）\-]+/).includes(term.toLowerCase()));
  const seen = new Set<string>();
  const undefinedTerms: Piece[] = [];
  for (const piece of readingOrder(spec)) {
    for (const m of piece.text.matchAll(TERM)) {
      const term = m[0];
      if (seen.has(term) || KNOWN.has(term) || LONE_SYMBOL.has(term) || term.length > 14) continue;
      seen.add(term);
      if (!isGlossed(term) && !definedAt(piece.text, m.index!, term)) undefinedTerms.push({ path: piece.path, text: term });
    }
  }
  if (undefinedTerms.length) {
    const list = undefinedTerms.slice(0, 8).map(t => t.text).join(', ') + (undefinedTerms.length > 8 ? ` (+${undefinedTerms.length - 8})` : '');
    warn(undefinedTerms[0].path, `Terms used without a plain definition: ${list}. Define each once: add a glossary block in the first section, or write the plain words first with the term in brackets ("留一受試者驗證（LOSO）").`);
  }

  // 6a. Experiment reports open with "what we are doing" and then every subject's scores.
  if (kind === 'experiment') {
    if (!spec.overview) warn('overview', 'Experiment report without "overview": before any result, say what is being done for a reader not in the loop — the question, what is compared (method vs baseline), the data and settings, and what counts as complete training.');
    const charts = spec.sections.flatMap((s, si) => s.blocks.map((b, bi) => ({ b: b as Record<string, any>, path: `sections[${si}].blocks[${bi}]` }))).filter(x => CHARTS.has(x.b.type) && x.b.role !== 'flowchart');
    const first = charts[0];
    if (!first || first.b.type !== 'figure' || first.b.perUnit !== true) warn(first?.path ?? 'sections[0]', 'The first chart of an experiment report must lay out the complete results (a figure block with perUnit: true): one panel per compared condition you find in the experiment design (e.g. dataset × evaluation setting); small multiples, one panel per model, each unit (subject, sample, task…) a thin line from baseline to method, the mean thick and labelled (template per_subject.py); only fully trained runs; a condition not run is one sentence in the caption, never an empty panel. Averages and conclusions come after it. Flowcharts (role "flowchart") may come before it.');
  }

  // 6. Experiment reports: fair baseline, repeated runs, the interval, and no "improvement" inside the noise.
  const exps = spec.sections.flatMap((s, si) => s.blocks.map((b, bi) => ({ b: b as Record<string, any>, path: `sections[${si}].blocks[${bi}]` }))).filter(x => x.b.type === 'experiment');
  if (kind === 'experiment' && !exps.length) warn('sections', 'Experiment report without an experiment block: state the question, hypothesis, success criterion, baseline, runs and what ± means before any chart.');
  let noisy = false;
  for (const { b, path } of exps) {
    if (b.runs < 3) warn(`${path}.runs`, `Only ${b.runs} run(s) per setting; one run can be luck. Run ≥ 3 seeds (report mean ± std), or say how much the number may move.`);
    if (b.baselineTuned !== true) warn(`${path}.baselineTuned`, 'Say whether the baseline got the same tuning budget and training length (baselineTuned: true); an untuned baseline makes any gain look bigger.');
    if (b.result && !b.result.ci) warn(`${path}.result.ci`, 'Give the 95% interval of the difference (result.ci) so the reader can see whether the gap is real.');
    if (withinNoise(b.result) || b.verdict === 'inconclusive') noisy = true;
    if (b.verdict === 'supported' && withinNoise(b.result)) warn(`${path}.verdict`, 'The 95% interval of the difference contains 0: the gap is inside the noise. Use verdict "inconclusive" and write "not significant", not "improved".');
  }
  const claims = /(提升|改善|進步|變好|更好|更準|勝過|優於|有效|improv|better|outperform|beats?\b)/i, hedged = /(不顯著|不明顯|誤差(範圍)?內|還不能|無法判定|not significant|within (the )?noise|inconclusive)/i;
  if (noisy && claims.test(spec.tldr) && !hedged.test(spec.tldr)) warn('tldr', 'The bottom line claims an improvement, but an experiment card is inconclusive or its interval crosses 0. Say "不顯著 / not significant" for that comparison.');
  if (kind === 'experiment') spec.sections.forEach((s, si) => s.blocks.forEach((b, bi) => {
    if (b.type !== 'kpi') return;
    const items = (b as unknown as { items: { delta?: string; target?: string; status?: string }[] }).items;
    if (items.some(i => !i.delta && !i.target && !i.status)) warn(`sections[${si}].blocks[${bi}].items`, 'Experiment KPI without delta or target: show each number against its baseline (delta) or the success criterion (target).');
  }));
  return w;
}
