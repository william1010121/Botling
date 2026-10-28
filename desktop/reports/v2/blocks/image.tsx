import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { Card } from '../core/ui';
import { pct } from '../core/text';

type Ann = { x: number; y: number; label: string };

/** A tiny illustrative screenshot stand-in so the example is self-contained. */
const sample = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 240"><rect width="390" height="240" rx="16" fill="#1B1B1F"/><rect x="0" y="0" width="120" height="240" fill="#141417"/>'
  + '<rect x="14" y="20" width="92" height="22" rx="6" fill="#26262C"/><rect x="14" y="52" width="92" height="10" rx="5" fill="#2A2A31"/><rect x="14" y="72" width="70" height="10" rx="5" fill="#2A2A31"/>'
  + '<rect x="140" y="24" width="200" height="34" rx="12" fill="#2B2B31"/><rect x="170" y="74" width="200" height="54" rx="12" fill="#2B2B31"/><rect x="140" y="196" width="230" height="28" rx="10" fill="#2A2A31"/></svg>',
).toString('base64');

export const image = defineBlock({
  type: 'image',
  description: 'A screenshot or figure with up to 6 numbered annotations placed at relative positions (0–1).',
  when: 'Showing the actual UI or output the text refers to. Annotate what to look at; alt text says what the image proves. src must be a data: URI or a path next to the spec file (inlined by the CLI).',
  fields: {
    src: z.string().regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, 'src must be a base64 data:image URI (the CLI inlines local files)').max(4_000_000),
    alt: z.string().trim().min(1).max(160),
    caption: z.string().trim().min(1).max(100).optional(),
    annotations: z.array(z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), label: z.string().trim().min(1).max(40) })).max(6).optional(),
  },
  examples: [{ title: '側欄只剩 Main bot', alt: '手機版側欄只列出一個 bot', src: sample, annotations: [{ x: 0.16, y: 0.13, label: '只剩 Main' }, { x: 0.6, y: 0.88, label: '輸入框仍可用' }] }],
  fit: 'visual',
  visual: true,
  Doc: ({ block, ctx }) => {
    const anns: Ann[] = block.annotations ?? [];
    return <Card type="image" block={block} ctx={ctx}>
      <div className="im"><img src={block.src} alt={block.alt}/>{anns.map((a, i) => <span key={i} className="ia" style={{ left: pct(a.x), top: pct(a.y) }} aria-hidden="true">{i + 1}</span>)}</div>
      {(anns.length > 0 || block.caption) && <figcaption>{anns.length > 0 && <ol>{anns.map((a, i) => <li key={i}><i>{i + 1}</i>{a.label}</li>)}</ol>}{block.caption && <p>{block.caption}</p>}</figcaption>}
    </Card>;
  },
  slide: { weight: () => 0.8 },
});
