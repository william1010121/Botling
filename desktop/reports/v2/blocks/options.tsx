import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { type Tone } from '../core/i18n';
import { Card } from '../core/ui';

type Opt = { name: string; summary?: string; recommended?: boolean; cells: Array<{ text: string; tone: Tone }> };
type Options = { criteria: string[]; options: Opt[]; verdict?: string };
const mark: Record<Tone, string> = { good: '●', warn: '◐', bad: '○', info: '●', neutral: '·' };

export const options = defineBlock({
  type: 'options',
  description: 'Options compared on the same criteria (2–4 options incl. "do nothing", 2–7 criteria), each cell rated good / warn / bad, with the recommended option marked.',
  when: 'Every decision or comparison report. Same criteria for every option (cost, risk, time, reversibility…). Put the recommendation in verdict and in the section takeaway.',
  fields: {
    criteria: z.array(z.string().trim().min(1).max(16)).min(2).max(7),
    options: z.array(z.strictObject({
      name: z.string().trim().min(1).max(20),
      summary: z.string().trim().min(1).max(40).optional(),
      recommended: z.boolean().optional(),
      cells: z.array(z.strictObject({ text: z.string().trim().min(1).max(36), tone: z.enum(['good', 'warn', 'bad', 'neutral']).default('neutral') })),
    })).min(2).max(4),
    verdict: z.string().trim().min(1).max(120).optional(),
  },
  refine: (v, c) => {
    const o = v as unknown as Options;
    o.options.forEach((opt, i) => { if (opt.cells.length !== o.criteria.length) c.addIssue({ code: 'custom', path: ['options', i, 'cells'], message: `needs ${o.criteria.length} cells, one per criterion` }); });
    if (o.options.filter(x => x.recommended).length > 1) c.addIssue({ code: 'custom', path: ['options'], message: 'at most one option can be recommended' });
  },
  examples: [{ title: '自己畫 SVG 最划算', criteria: ['離線輸出', '套件大小'], options: [{ name: '自己畫 SVG', recommended: true, cells: [{ text: '可以', tone: 'good' }, { text: '+40 KB', tone: 'good' }] }, { name: 'Recharts', cells: [{ text: '輸出空白', tone: 'bad' }, { text: '+450 KB', tone: 'warn' }] }], verdict: '選自己畫：唯一能在產生時就畫好、不需要瀏覽器執行的方案。' }],
  fit: 'full',
  visual: true,
  Doc: ({ block, ctx }) => {
    const o = block as Options;
    const cell = (c: { text: string; tone: Tone }) => <span className={`op-c t-${c.tone}`}><i aria-hidden="true">{mark[c.tone]}</i>{c.text}</span>;
    return <Card type="options" block={block} ctx={ctx}>
      <div className="op-wide tbl-scroll">
        <table className="tbl op" style={{ ['--n' as string]: o.options.length }}>
          <thead><tr><td/>{o.options.map((opt, i) => <th key={i} scope="col" className={opt.recommended ? 'rec' : undefined}>
            {opt.recommended && <span className="badge">{ctx.t.recommended}</span>}<b>{opt.name}</b>{opt.summary && <small>{opt.summary}</small>}
          </th>)}</tr></thead>
          <tbody>{o.criteria.map((cr, r) => <tr key={r}><th scope="row">{cr}</th>{o.options.map((opt, i) => <td key={i} className={opt.recommended ? 'rec' : undefined}>{cell(opt.cells[r])}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="op-narrow" aria-hidden="true">{o.options.map((opt, i) => <section key={i} className={`op-card${opt.recommended ? ' rec' : ''}`}>
        <p className="oph">{opt.recommended && <span className="badge">{ctx.t.recommended}</span>}<b>{opt.name}</b></p>
        {opt.summary && <p className="ops">{opt.summary}</p>}
        <dl>{o.criteria.map((cr, r) => <div key={r}><dt>{cr}</dt><dd>{cell(opt.cells[r])}</dd></div>)}</dl>
      </section>)}</div>
      {o.verdict && <p className="verdict-line"><b>{ctx.t.verdictLabel}</b>{o.verdict}</p>}
    </Card>;
  },
  slide: { weight: b => 0.3 + b.criteria.length * 0.09 + (b.verdict ? 0.08 : 0) },
});

export const proscons = defineBlock({
  type: 'proscons',
  description: 'Two lists, pros and cons of one option, with an optional one-line verdict.',
  when: 'Weighing a single option. For several options use options. ≤5 points per side, one line each.',
  fields: {
    pros: z.array(z.string().trim().min(1).max(50)).min(1).max(5),
    cons: z.array(z.string().trim().min(1).max(50)).min(1).max(5),
    verdict: z.string().trim().min(1).max(100).optional(),
  },
  examples: [{ title: 'Vega-Lite 功能強，但要瀏覽器才畫得出來', pros: ['圖表種類齊全', '宣告式規格，bot 容易寫'], cons: ['產生時需要 headless 瀏覽器', '輸出要帶 400 KB 執行檔'], verdict: '留作進階選項，不當預設。' }],
  fit: 'half',
  visual: false,
  Doc: ({ block, ctx }) => <Card type="proscons" block={block} ctx={ctx}>
    <div className="pc">
      <section className="t-good"><h4>{ctx.t.pros}</h4><ul>{block.pros.map((p: string, i: number) => <li key={i}><i aria-hidden="true">+</i>{p}</li>)}</ul></section>
      <section className="t-bad"><h4>{ctx.t.cons}</h4><ul>{block.cons.map((p: string, i: number) => <li key={i}><i aria-hidden="true">−</i>{p}</li>)}</ul></section>
    </div>
    {block.verdict && <p className="verdict-line"><b>{ctx.t.verdictLabel}</b>{block.verdict}</p>}
  </Card>,
  slide: { weight: b => 0.25 + Math.max(b.pros.length, b.cons.length) * 0.1, side: true },
});
