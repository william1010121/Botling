import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { toneEnum } from '../core/i18n';

const glyph = { good: '✓', warn: '!', bad: '!', info: 'i', neutral: '·' } as const;

export const callout = defineBlock({
  type: 'callout',
  description: 'One highlighted message with a tone: info, warn, bad (risk), good (success) or neutral.',
  when: 'A risk, a caveat or a decision the reader must not miss. At most one per section; never hide a risk anywhere else.',
  fields: {
    tone: toneEnum.default('info'),
    text: z.string().trim().min(1).max(240),
  },
  examples: [{ tone: 'warn', title: '還沒在實機驗證', text: '數字來自開發機；裝到使用者電腦後要再量一次才算完成。' }],
  fit: 'text',
  visual: false,
  Doc: ({ block }) => <aside className={`blk blk-callout t-${block.tone}`}>
    <i className="cg" aria-hidden="true">{glyph[block.tone as keyof typeof glyph]}</i>
    <div>{block.title && <p className="ct">{block.title}</p>}<p className="cx">{block.text}</p></div>
  </aside>,
  slide: { weight: () => 0.3, side: true },
});
