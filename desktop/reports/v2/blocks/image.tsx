import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { Card } from '../core/ui';
import { pct } from '../core/text';

type Ann = { x: number; y: number; label: string };

/** A tiny illustrative screenshot stand-in (PNG) so the example is self-contained. */
const sample = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAE4AAAAwCAIAAAAw4Nv7AAAAgUlEQVR42u3ZOwqAMBBAwRwiYGFhlyKx8f6X8wJWwc/iDrwLDGx+pNS63NK6bsErqKj/oLa2T5SdOsbxSaiZqTduS6hhqL0fE6GmGWC3pTDUiaFFvSjC6n1pgFFRUVFRUVFRUb1sUFFRUVFRUVFRURNQ575/nggVFRU1G9W5ivpWJ4nSWlRcCkv7AAAAAElFTkSuQmCC';

export const isSvg = (src: unknown) => typeof src === 'string' && /^data:image\/svg\+xml[;,]|\.svg$/i.test(src);

export const image = defineBlock({
  type: 'image',
  description: 'A screenshot or figure with up to 6 numbered annotations placed at relative positions (0–1).',
  when: 'Showing the actual UI or output the text refers to (a PNG / JPEG screenshot or photo). SVG images are disabled — never a chart or diagram: those are `figure` blocks drawn by a .py. Annotate what to look at; alt text says what the image proves. src must be a data: URI or a path next to the spec file (inlined by the CLI).',
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
    // SVG images are disabled: hand-written SVG charts were the source of overlapping labels. Older specs show the alt text.
    if (isSvg(block.src)) return <Card type="image" block={block} ctx={ctx}><p className="rt-note">{ctx.t.svgOff}</p><p className="fg-none">{block.alt}</p></Card>;
    return <Card type="image" block={block} ctx={ctx}>
      <div className="im"><img src={block.src} alt={block.alt} data-zoom="" tabIndex={0} role="button"/>{anns.map((a, i) => <span key={i} className="ia" style={{ left: pct(a.x), top: pct(a.y) }} aria-hidden="true">{i + 1}</span>)}</div>
      {(anns.length > 0 || block.caption) && <figcaption>{anns.length > 0 && <ol>{anns.map((a, i) => <li key={i}><i>{i + 1}</i>{a.label}</li>)}</ol>}{block.caption && <p>{block.caption}</p>}</figcaption>}
    </Card>;
  },
  slide: { weight: () => 0.8 },
});
