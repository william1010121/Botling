import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { expVerdictEnum, type ExpVerdict, type Tone } from '../core/i18n';
import { fmt } from '../core/text';
import { Card, TonePill } from '../core/ui';
import { runFigure, type FigureOutput } from '../core/figure';
import { FigureView, scriptFields } from './figure';

type Result = { metric: string; base: number; new: number; ci?: [number, number]; unit?: string };
type ExpFigure = { script: string; args?: string[]; format?: 'svg' | 'png'; timeout?: number; alt: string; caption?: string };
type Exp = { question: string; hypothesis: string; success: string; baseline: string; baselineTuned?: boolean; runs: number; spread: string; result?: Result; verdict: ExpVerdict; figure?: ExpFigure };

const verdictTone: Record<ExpVerdict, Tone> = { supported: 'good', not_supported: 'bad', inconclusive: 'warn' };
/** The difference's confidence interval contains 0: the gap is inside the noise. */
export const withinNoise = (r?: Result) => !!r?.ci && r.ci[0] <= 0 && r.ci[1] >= 0;
const signed = (v: number, unit?: string) => `${v > 0 ? '+' : ''}${fmt(v, unit)}`;

export const experiment = defineBlock({
  type: 'experiment',
  description: 'The experiment card: the verdict and the result with its interval, its own chart (a .py figure) with a one-sentence reading guide, and the design (question, hypothesis, success criterion set beforehand, baseline, runs, what ± means) collapsed under it.',
  when: 'Every experiment report (kind "experiment"), in the first section, once per main hypothesis. It answers "was the comparison fair and is the gap real?". Its chart is `figure` (a .py reading the result files, like a figure block; the renderer draws no chart of its own), e.g. each unit\'s baseline → method for this one comparison; never the same script and args as another chart. When the interval of the difference crosses 0 the card itself says "not significant"; never call that gap an improvement.',
  fields: {
    question: z.string().trim().min(1).max(120).describe('What the experiment wants to know, in plain words.'),
    hypothesis: z.string().trim().min(1).max(160).describe('"If we change X, metric Y improves by ≥ Z" — falsifiable, with direction.'),
    success: z.string().trim().min(1).max(120).describe('The success criterion fixed before running.'),
    baseline: z.string().trim().min(1).max(120).describe('What the new method is compared against (previous version, paper score, chance level).'),
    baselineTuned: z.boolean().optional().describe('true = the baseline got the same tuning budget and training length.'),
    runs: z.number().int().min(1).max(1000).describe('Independent runs (seeds / folds) per setting.'),
    spread: z.string().trim().min(1).max(60).describe('What the ± or error bar is: std or SE, across seeds or subjects, and n.'),
    result: z.strictObject({
      metric: z.string().trim().min(1).max(24),
      base: z.number(),
      new: z.number(),
      ci: z.tuple([z.number(), z.number()]).optional().describe('95% interval of the difference new − base.'),
      unit: z.string().trim().max(8).optional().describe('Unit of base and new, e.g. "%" (the difference is then shown in pp), "ms".'),
    }).optional(),
    figure: z.strictObject({
      ...scriptFields,
      alt: z.string().trim().min(1).max(200).describe('What the chart shows, for screen readers.'),
      caption: z.string().trim().min(1).max(200).optional().describe('One-sentence reading guide under the chart.'),
    }).optional().describe('The card\'s chart: a matplotlib .py reading the result files, run like a figure block.'),
    verdict: expVerdictEnum.describe('supported | not_supported | inconclusive (the gap is inside the noise or runs are missing).'),
  },
  refine: (v, ctx) => {
    const ci = v.result?.ci;
    if (ci && ci[0] > ci[1]) ctx.addIssue({ code: 'custom', path: ['result', 'ci'], message: 'ci must be [low, high]' });
  },
  examples: [{
    question: '加了 SESS 前處理，模型在沒看過的新受試者身上會不會更準？',
    hypothesis: '加 SESS 後，跨受試者準確率至少高 3 個百分點。',
    success: '9 人中至少 7 人變好，且差距的 95% 區間不含 0。',
    baseline: '同模型、同訓練長度、不加 SESS',
    baselineTuned: true,
    runs: 3,
    spread: '受試者間標準差（9 人，每人 3 seeds 先平均）',
    result: { metric: '準確率', base: 41.9, new: 50.8, ci: [2.2, 15.6], unit: '%' },
    verdict: 'supported',
    figure: { script: 'figures/paired.py', args: ['figures/per_subject.csv', '資料集 A', '條件 1', '模型 X'], alt: '每位受試者不加與加 SESS 的準確率，一人一欄', caption: '每一欄是一位受試者：空心 = 基準、實心 = 方法；綠色線段 = 變好。' },
  }],
  fit: 'full',
  visual: false,
  prepare: (b: Exp, _mode, env): FigureOutput | undefined => (b.figure ? runFigure(b.figure, env.baseDir, `fig-${env.id}`) : undefined),
  Doc: ({ block, ctx }) => {
    const b = block as Exp & { title?: string; note?: string };
    const t = ctx.t.exp;
    const r = b.result;
    const noise = withinNoise(r);
    const du = r?.unit === '%' ? 'pp' : r?.unit;
    return <Card type="experiment" block={b} ctx={ctx}>
      <p className="xv"><span className="xl">{t.verdict}</span><TonePill tone={verdictTone[b.verdict]}>{ctx.t.expVerdict[b.verdict]}</TonePill>{noise && <span className="xn">{t.noise}</span>}</p>
      {r && <p className="xr"><b>{r.metric}</b> {fmt(r.base, r.unit)} → {fmt(r.new, r.unit)}<span className="xd">{t.diff} {signed(r.new - r.base, du)}{r.ci && ` · ${t.ci} [${signed(r.ci[0])}, ${signed(r.ci[1])}]`}</span></p>}
      {b.figure && <figure className="xfig"><FigureView out={ctx.prepared as FigureOutput | undefined} alt={b.figure.alt}/>{b.figure.caption && <figcaption>{b.figure.caption}</figcaption>}</figure>}
      <details className="xmore"><summary>{t.design}</summary><dl className="xg">
        <div><dt>{t.question}</dt><dd>{b.question}</dd></div>
        <div><dt>{t.hypothesis}</dt><dd>{b.hypothesis}</dd></div>
        <div><dt>{t.success}</dt><dd>{b.success}</dd></div>
        <div><dt>{t.baseline}</dt><dd>{b.baseline}{b.baselineTuned !== undefined && <span className={`xt t-${b.baselineTuned ? 'good' : 'warn'}`}>{b.baselineTuned ? t.tunedYes : t.tunedNo}</span>}</dd></div>
        <div><dt>{t.runs}</dt><dd>{t.runsN(b.runs)}</dd></div>
        <div><dt>{t.spread}</dt><dd>{b.spread}</dd></div>
      </dl></details>
    </Card>;
  },
  slide: { weight: (b: Exp) => (b.figure ? 0.95 : b.result ? 0.5 : 0.4) },
});
