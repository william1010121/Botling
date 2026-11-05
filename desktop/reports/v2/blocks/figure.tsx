import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { runFigure, type FigureOutput } from '../core/figure';
import { Card } from '../core/ui';

type Figure = { script: string; args?: string[]; format?: 'svg' | 'png'; timeout?: number; alt: string; caption?: string; role?: 'chart' | 'flowchart'; perUnit?: boolean; missing?: string[]; title?: string; note?: string };

/** How a figure script is run; shared by the figure block and the experiment card's own figure. */
export const scriptFields = {
  script: z.string().trim().min(1).max(400).regex(/\.py$/i, 'script must be a .py file').describe('Path to the .py file, absolute or relative to the spec file.'),
  args: z.array(z.string().max(400)).max(20).optional().describe('Command-line arguments for the script (data files, options); it runs with the spec\'s folder as working directory.'),
  format: z.enum(['svg', 'png']).default('svg').describe('svg (default: sharp, recoloured for dark mode) or png (very many points; drawn twice, once per theme).'),
  timeout: z.number().int().min(5).max(300).default(60).describe('Seconds before the script is stopped and the block reports an error.'),
};

/** The image a figure script produced (inline SVG, or a light and a dark PNG); the alt text when there is none. */
export function FigureView({ out, alt }: { out?: FigureOutput; alt: string }) {
  if (out?.svg) return <div className="fg" role="img" aria-label={alt} data-zoom="" tabIndex={0} style={out.width ? { maxWidth: out.width } : undefined} dangerouslySetInnerHTML={{ __html: out.svg }}/>;
  if (out?.png) return <div className="fg" data-zoom="" tabIndex={0} role="button"><img className="fg-l" src={out.png.light} alt={alt}/><img className="fg-d" src={out.png.dark} alt=""/></div>;
  return <p className="fg-none">{alt}</p>;
}

export const figure = defineBlock({
  type: 'figure',
  description: 'A data chart drawn by your own matplotlib script (.py), run when the page is rendered and embedded in the page; follows the light and dark themes.',
  when: 'Every data chart: comparisons, signed deltas, trends over time, before/after, shares, heatmaps, per-subject scores, small multiples, scatter, distributions, error bars, curves. Never a hand-written SVG. The script draws with matplotlib (the current figure is saved; theme colours are C0 blue, C1 orange, C2 green, C3 purple, C4 red, C5 grey) and reads its data from files — never type numbers into the script. In an experiment report the first chart is a figure with perUnit: true: small multiples, one panel per model and condition, each unit a thin line from baseline to method, the mean thick and labelled; conditions not run are not drawn (caption and `missing`). Follow "Chart design" in the guide.',
  fields: {
    ...scriptFields,
    alt: z.string().trim().min(1).max(200).describe('What the chart shows, for screen readers and as the fallback text.'),
    caption: z.string().trim().min(1).max(200).optional().describe('One-sentence reading guide: what each mark is and what higher / further right means.'),
    role: z.enum(['chart', 'flowchart']).optional().describe('flowchart = a process diagram (the pipeline, how the data is split, what is compared), drawn in the clean-flowchart style from template flowchart.py: rounded boxes, right-angle arrows. One or more open the report. Default chart.'),
    perUnit: z.boolean().optional().describe('true = the complete results: every unit before → after, one panel per model and condition (template per_subject.py); the first chart of an experiment report.'),
    missing: z.array(z.string().trim().min(1).max(60)).max(12).optional().describe('Conditions with no results, shown as one "未跑" line under the chart; never draw them as empty panels.'),
  },
  examples: [{ title: '同一份資料，只差有沒有先做 SESS', role: 'flowchart', script: 'figures/flowchart.py', args: ['figures/flowchart.json'], alt: '流程圖：原始腦波分成兩條路（不加 SESS、加 SESS），送進同一個模型，用兩種考法評分，最後配對比較', caption: '每個方框是一個步驟；兩條路只差藍色那一步，其餘完全相同。' }, { title: '每位受試者在每個條件下的準確率', script: 'figures/per_subject.py', args: ['figures/per_subject.csv'], alt: '小圖：每個條件一列、每個模型一格；每位受試者一條線連接基準與方法，粗線是平均', caption: '每條細線是一位受試者：藍 = 用了方法變好、橘 = 變差；粗線是平均。資料集 B 的條件 2 沒有跑。', perUnit: true, missing: ['資料集 B · 條件 2'] }],
  fit: 'full',
  visual: true,
  prepare: (b: Figure, _mode, env): FigureOutput => runFigure(b, env.baseDir, `fig-${env.id}`),
  Doc: ({ block, ctx }) => {
    const b = block as Figure;
    const out = ctx.prepared as FigureOutput | undefined;
    return <Card type="figure" block={b} ctx={ctx} className={b.role === 'flowchart' ? 'fg-flow' : undefined}>
      <FigureView out={out} alt={b.alt}/>
      {(b.caption || b.missing?.length) && <figcaption>{b.caption && <p>{b.caption}</p>}{b.missing?.length ? <p className="fg-miss"><b>{ctx.t.notRun}</b>{b.missing.join('、')}</p> : null}</figcaption>}
    </Card>;
  },
  slide: { weight: () => 0.9 },
});
