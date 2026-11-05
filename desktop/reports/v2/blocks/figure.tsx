import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { runFigure, type FigureOutput } from '../core/figure';
import { Card } from '../core/ui';

type Figure = { script: string; args?: string[]; format?: 'svg' | 'png'; timeout?: number; alt: string; caption?: string; perUnit?: boolean; missing?: string[]; title?: string; note?: string };

export const figure = defineBlock({
  type: 'figure',
  description: 'A data chart drawn by your own matplotlib script (.py), run when the page is rendered and embedded in the page; follows the light and dark themes.',
  when: 'Every data chart: comparisons, signed deltas, trends over time, before/after, shares, heatmaps, per-subject scores, small multiples, scatter, distributions, error bars, curves. Never a hand-written SVG. The script draws with matplotlib (the current figure is saved; theme colours are C0 blue, C1 orange, C2 green, C3 purple, C4 red, C5 grey) and reads its data from files — never type numbers into the script. In an experiment report the first chart is a figure with perUnit: true: one panel per compared condition, units on the x axis, one colour per model as dots or grouped bars (no lines), each model\'s mean in the panel title, 未跑 for panels not run.',
  fields: {
    script: z.string().trim().min(1).max(400).regex(/\.py$/i, 'script must be a .py file').describe('Path to the .py file, absolute or relative to the spec file.'),
    args: z.array(z.string().max(400)).max(20).optional().describe('Command-line arguments for the script (data files, options); it runs with the spec\'s folder as working directory.'),
    format: z.enum(['svg', 'png']).default('svg').describe('svg (default: sharp, recoloured for dark mode) or png (very many points; drawn twice, once per theme).'),
    timeout: z.number().int().min(5).max(300).default(60).describe('Seconds before the script is stopped and the block reports an error.'),
    alt: z.string().trim().min(1).max(200).describe('What the chart shows, for screen readers and as the fallback text.'),
    caption: z.string().trim().min(1).max(200).optional().describe('One-sentence reading guide: what each mark is and what higher / further right means.'),
    perUnit: z.boolean().optional().describe('true = the complete results: one panel per compared condition, every unit (subject, sample, task…) on the x axis, one colour per model; the first chart of an experiment report.'),
    missing: z.array(z.string().trim().min(1).max(60)).max(12).optional().describe('Conditions with no results, shown as "未跑" under the chart (also draw an empty, labelled panel).'),
  },
  examples: [{ title: '每位受試者在每個條件下的準確率', script: 'figures/per_subject.py', args: ['figures/per_subject.csv'], alt: '2×2 格：資料集 A / B × 條件 1 / 2；橫軸是受試者，每個模型一種顏色，空心是基準、實心是方法', caption: '每一欄是一位受試者；同色的空心點是基準、實心點是方法；格子標題是各模型的平均（基準 → 方法）。', perUnit: true, missing: ['資料集 B · 條件 2'] }],
  fit: 'full',
  visual: true,
  prepare: (b: Figure, _mode, env): FigureOutput => runFigure(b, env.baseDir, `fig-${env.id}`),
  Doc: ({ block, ctx }) => {
    const b = block as Figure;
    const out = ctx.prepared as FigureOutput | undefined;
    return <Card type="figure" block={b} ctx={ctx}>
      {out?.svg && <div className="fg" role="img" aria-label={b.alt} data-zoom="" tabIndex={0} dangerouslySetInnerHTML={{ __html: out.svg }}/>}
      {out?.png && <div className="fg" data-zoom="" tabIndex={0} role="button"><img className="fg-l" src={out.png.light} alt={b.alt}/><img className="fg-d" src={out.png.dark} alt=""/></div>}
      {!out && <p className="fg-none">{b.alt}</p>}
      {(b.caption || b.missing?.length) && <figcaption>{b.caption && <p>{b.caption}</p>}{b.missing?.length ? <p className="fg-miss"><b>{ctx.t.notRun}</b>{b.missing.join('、')}</p> : null}</figcaption>}
    </Card>;
  },
  slide: { weight: () => 0.9 },
});
