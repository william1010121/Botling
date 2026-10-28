import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';
import { fmt } from '../core/text';

type Head = string | { label: string; status?: Status };
type Cell = number | null | string[];
type Matrix = { rows: Head[]; cols: Head[]; cells: Cell[][]; scale: 'seq' | 'div'; unit?: string };
const label = (h: Head) => (typeof h === 'string' ? h : h.label);
const status = (h: Head) => (typeof h === 'string' ? undefined : h.status);

/** Map a number to one of 6 (seq) or 7 (div, centred on 0) theme shades. */
export function shade(v: number, lo: number, hi: number, scale: 'seq' | 'div'): string {
  if (scale === 'div') {
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const k = Math.round((v / m) * 3);
    return k === 0 ? 'h0' : k > 0 ? `hp${k}` : `hn${-k}`;
  }
  return `h${hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 5)}`;
}

const head = z.union([z.string().trim().min(1).max(16), z.strictObject({ label: z.string().trim().min(1).max(16), status: statusEnum.optional() })]);
export const matrix = defineBlock({
  type: 'matrix',
  description: 'A grid of rows × columns: a heatmap of numbers, or a placement grid where each cell lists short item names.',
  when: 'Two dimensions at once: priority × status, module × platform failures, hour × weekday load. Cells hold numbers (heatmap) or arrays of ≤4 short names (placement). ≤30×30.',
  fields: {
    rows: z.array(head).min(1).max(30),
    cols: z.array(head).min(1).max(30).describe('A column with a status colours the item chips placed in it.'),
    cells: z.array(z.array(z.union([z.number(), z.null(), z.array(z.string().trim().min(1).max(14)).max(4)]))),
    scale: z.enum(['seq', 'div']).default('seq').describe('seq = low→high; div = negative↔positive around 0.'),
    unit: z.string().trim().max(8).optional(),
  },
  refine: (v, c) => {
    const m = v as unknown as Matrix;
    if (m.cells.length !== m.rows.length) c.addIssue({ code: 'custom', path: ['cells'], message: `needs ${m.rows.length} rows of cells` });
    m.cells.forEach((r, i) => { if (r.length !== m.cols.length) c.addIssue({ code: 'custom', path: ['cells', i], message: `needs ${m.cols.length} cells, one per column` }); });
  },
  examples: [
    { title: 'P0 只剩一項，卡在安裝', rows: ['P0', 'P1', 'P2'], cols: [{ label: '受阻', status: 'blocked' }, { label: '進行中', status: 'active' }, { label: '完成', status: 'done' }], cells: [[['離線安裝'], null, null], [null, ['Rust 後端', '手機同步'], ['任務面板']], [null, ['報告改版'], ['CPU 降低']]] },
    { title: '週三晚上最忙', note: '每小時訊息數', rows: ['週一', '週二', '週三'], cols: ['9時', '12時', '15時', '18時', '21時'], cells: [[12, 30, 22, 18, 9], [10, 28, 25, 31, 14], [14, 35, 29, 44, 52]] },
  ],
  fit: b => (b.cols.length > 6 ? 'full' : 'visual'),
  visual: true,
  Doc: ({ block, ctx }) => {
    const m = block as Matrix;
    const nums = m.cells.flat().filter((c): c is number => typeof c === 'number');
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return <Card type="matrix" block={block} ctx={ctx}>
      <div className="mx-scroll">
        <table className={`mx${m.cols.length > 8 ? ' dense' : ''}`} style={{ ['--cols' as string]: m.cols.length }}>
          <thead><tr><td/>{m.cols.map((h, j) => <th key={j} scope="col">{status(h) ? <span className={`pill t-${statusTone[status(h)!]}`}>{label(h)}</span> : label(h)}</th>)}</tr></thead>
          <tbody>{m.rows.map((r, i) => <tr key={i}><th scope="row">{label(r)}</th>{m.cols.map((h, j) => {
            const c = m.cells[i]?.[j] ?? null;
            if (Array.isArray(c)) return <td key={j} className={`mc${c.length ? ' on' : ''}`}>{c.map((n, k) => <span key={k} className={`chip t-${status(h) ? statusTone[status(h)!] : 'info'}`}>{n}</span>)}</td>;
            if (typeof c === 'number') return <td key={j} className={`mc num ${shade(c, lo, hi, m.scale)}`}>{fmt(c)}</td>;
            return <td key={j} className="mc"><span className="sr-only">–</span></td>;
          })}</tr>)}</tbody>
        </table>
      </div>
      {nums.length > 0 && <p className="mx-key" aria-hidden="true"><span>{fmt(lo, m.unit)}</span><i className={`ramp ${m.scale}`}/><span>{fmt(hi, m.unit)}</span></p>}
    </Card>;
  },
  slide: { weight: b => 0.2 + b.rows.length * 0.1 },
});
