import { z } from 'zod';
import { defineBlock, type Ctx } from '../core/registry';
import { statusEnum, statusTone, toneEnum, type Status, type Tone } from '../core/i18n';
import { Card } from '../core/ui';

type CellObj = { text: string; status?: Status; tone?: Tone; strong?: boolean };
type Cell = string | number | CellObj;
type Table = { columns: string[]; rows: Cell[][]; highlight?: number; title?: string };
const isNum = (c: Cell) => typeof c === 'number' || (typeof c === 'string' && /^[-+−]?[\d.,]+\s?[%a-zA-Z]{0,3}$/.test(c.trim()));

function CellView({ cell, ctx }: { cell: Cell; ctx: Ctx }) {
  if (typeof cell !== 'object') return <>{typeof cell === 'number' ? cell.toLocaleString('en-US') : cell}</>;
  const inner = cell.strong ? <b>{cell.text}</b> : cell.text;
  if (cell.status) return <span className={`cell-s t-${statusTone[cell.status]}`}><i aria-hidden="true"/>{cell.status === 'skipped' ? <s>{inner}</s> : inner}<span className="sr-only">（{ctx.t.status[cell.status]}）</span></span>;
  if (cell.tone) return <span className={`cell-s t-${cell.tone}`}><i aria-hidden="true"/>{inner}</span>;
  return <>{inner}</>;
}

export const table = defineBlock({
  type: 'table',
  description: 'A compact table; cells can carry a status or tone dot. Numeric columns align right.',
  when: 'Exact values the reader will look up, or a few rows × few attributes. ≤8 rows in the body of a report; larger data goes to an appendix file. Strings never imply status, regardless of wording or column heading. Supply cell objects with explicit status or tone; status="skipped" strikes the text. strong controls bold text.',
  fields: {
    columns: z.array(z.string().trim().min(1).max(24)).min(2).max(6),
    rows: z.array(z.array(z.union([z.string().trim().max(60), z.number(), z.strictObject({
      text: z.string().trim().min(1).max(60), status: statusEnum.optional(), tone: toneEnum.optional(), strong: z.boolean().optional(),
    })]))).min(1).max(20),
    highlight: z.number().int().min(0).optional().describe('Index of the row to emphasise.'),
  },
  refine: (v, c) => (v.rows as Cell[][]).forEach((r, i) => { if (r.length !== (v.columns as string[]).length) c.addIssue({ code: 'custom', path: ['rows', i], message: `needs ${(v.columns as string[]).length} cells, one per column` }); }),
  examples: [{ title: '四條工作線，一條受阻', columns: ['工作線', '狀態', '下一步'], rows: [['任務面板 .11', { text: '已安裝', status: 'done' }, '收集回饋'], ['Rust 遷移', { text: '進行中', status: 'active' }, '補完 IPC'], ['手機版對齊', { text: '受阻', status: 'blocked' }, '修 bot 清單'], ['報告改版', { text: '進行中', status: 'active' }, '定稿區塊']] }],
  fit: 'full',
  visual: false,
  Doc: ({ block, ctx }) => {
    const t = block as Table;
    const numeric = t.columns.map((_, j) => t.rows.every(r => isNum(r[j]) || r[j] === ''));
    return <Card type="table" block={block} ctx={ctx}>
      <div className="tbl-scroll" role="region" aria-label={t.title ?? t.columns.join(' / ')} tabIndex={0}>
        <table className="tbl">
          <thead><tr>{t.columns.map((c, j) => <th key={j} scope="col" className={numeric[j] ? 'r' : undefined}>{c}</th>)}</tr></thead>
          <tbody>{t.rows.map((r, i) => <tr key={i} className={t.highlight === i ? 'hi' : undefined}>{r.map((c, j) => j === 0
            ? <th key={j} scope="row"><CellView cell={c} ctx={ctx}/></th>
            : <td key={j} className={numeric[j] ? 'r' : undefined}><CellView cell={c} ctx={ctx}/></td>)}</tr>)}</tbody>
        </table>
      </div>
    </Card>;
  },
  slide: {
    weight: b => 0.16 + b.rows.length * 0.085,
    split: b => { const out = []; const size = Math.ceil(b.rows.length / Math.ceil(b.rows.length / 7)); for (let i = 0; i < b.rows.length; i += size) out.push({ ...b, rows: b.rows.slice(i, i + size), highlight: b.highlight !== undefined && b.highlight >= i && b.highlight < i + size ? b.highlight - i : undefined }); return out; },
  },
});
