import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';

type Step = { from: string; to: string; label: string; kind?: 'call' | 'reply' | 'note'; status?: Status };
type Seq = { actors: string[]; steps: Step[] };

export const sequence = defineBlock({
  type: 'sequence',
  description: 'Sequence diagram: 2–5 actors as columns, numbered messages between them (call, dashed reply, or a note on one actor).',
  when: 'Who talks to whom in what order: request paths, handoffs, where a message got lost. Mark the failing step with status blocked/risk.',
  fields: {
    actors: z.array(z.string().trim().min(1).max(14)).min(2).max(5),
    steps: z.array(z.strictObject({
      from: z.string(), to: z.string(),
      label: z.string().trim().min(1).max(40),
      kind: z.enum(['call', 'reply', 'note']).optional(),
      status: statusEnum.optional(),
    })).min(1).max(14),
  },
  refine: (v, c) => {
    const s = v as unknown as Seq;
    s.steps.forEach((st, i) => (['from', 'to'] as const).forEach(k => { if (!s.actors.includes(st[k])) c.addIssue({ code: 'custom', path: ['steps', i, k], message: `must be one of: ${s.actors.join(', ')}` }); }));
  },
  examples: [{ title: '手機端拿到的清單在 Bridge 被截斷', actors: ['手機', 'Bridge', 'Core'], steps: [{ from: '手機', to: 'Bridge', label: 'GET /bots' }, { from: 'Bridge', to: 'Core', label: 'listBots()' }, { from: 'Core', to: 'Bridge', label: '3 個 bot', kind: 'reply' }, { from: 'Bridge', to: '手機', label: '只回傳第一個', kind: 'reply', status: 'blocked' }] }],
  fit: 'full',
  visual: true,
  Doc: ({ block, ctx }) => {
    const s = block as Seq;
    const n = s.actors.length;
    return <Card type="sequence" block={block} ctx={ctx}>
      <div className="sq" style={{ ['--n' as string]: n }} role="img" aria-label={s.steps.map((st, i) => `${i + 1}. ${st.from} → ${st.to}: ${st.label}`).join('；')}>
        <div className="sqa" aria-hidden="true">{s.actors.map((a, i) => <span key={i}>{a}</span>)}</div>
        <ol className="sqs" aria-hidden="true">{s.steps.map((st, i) => {
          const a = s.actors.indexOf(st.from), b = s.actors.indexOf(st.to);
          const lo = Math.min(a, b), hi = Math.max(a, b);
          const tone = st.status ? statusTone[st.status] : 'none';
          if (st.kind === 'note' || a === b) {
            return <li key={i} className={`t-${tone}`}><span className="sqn" style={{ gridColumn: `${a + 1} / span 1` }}><b>{i + 1}</b>{st.label}</span></li>;
          }
          const span = hi - lo + 1;
          return <li key={i} className={`t-${tone}`}>
            <span className={`sqm ${a < b ? 'r' : 'l'}${st.kind === 'reply' ? ' reply' : ''}`} style={{ gridColumn: `${lo + 1} / span ${span}`, ['--inset' as string]: `${50 / span}%` }}>
              <em><b>{i + 1}</b>{st.label}</em><i/>
            </span>
          </li>;
        })}</ol>
      </div>
    </Card>;
  },
  slide: {
    weight: b => 0.12 + b.steps.length * 0.1,
    split: b => (b.steps.length <= 7 ? [b] : [{ ...b, steps: b.steps.slice(0, 7) }, { ...b, steps: b.steps.slice(7) }]),
  },
});
