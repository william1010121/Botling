import { z } from 'zod';
import { defineBlock, type Ctx } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';
import { layoutGraph, roundedPath, LINE, type GraphLayout, type PlacedNode } from '../core/graph';

type Flow = { dir: 'LR' | 'TB'; nodes: Array<{ id: string; label: string; sub?: string; status?: Status; kind?: string }>; edges: Array<{ from: string; to: string; label?: string; kind?: string }>; title?: string };
type Prepared = { main: GraphLayout; narrow?: GraphLayout };

function NodeShape({ n }: { n: PlacedNode }) {
  const { w, h } = n;
  if (n.kind === 'decision') return <polygon className="nb" points={`10,0 ${w - 10},0 ${w},${h / 2} ${w - 10},${h} 10,${h} 0,${h / 2}`}/>;
  return <rect className="nb" width={w} height={h} rx={n.kind === 'start' || n.kind === 'end' ? h / 2 : 12}/>;
}

function Graph({ g, ctx, cls, maxW }: { g: GraphLayout; ctx: Ctx; cls: string; maxW?: number }) {
  const label = (g.nodes.map(n => n.label).join(' → '));
  return <svg className={`fl ${cls}`} viewBox={`0 0 ${g.w} ${g.h}`} width={g.w} height={g.h} style={{ maxWidth: maxW ?? g.w }} role="img" aria-label={label}>
    <defs><marker id={`${ctx.id}-${cls}-a`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" className="ah"/></marker></defs>
    {g.edges.map((e, i) => <path key={i} className={`edge${e.kind === 'dashed' ? ' dash' : ''}`} d={roundedPath(e.points)} markerEnd={`url(#${ctx.id}-${cls}-a)`}/>)}
    {g.edges.filter(e => e.label && e.lx !== undefined).map((e, i) => <g key={i} className="el" transform={`translate(${e.lx} ${e.ly})`}><rect width={e.lw} height={18} rx={6}/><text x={e.lw! / 2} y={13} textAnchor="middle">{e.label}</text></g>)}
    {g.nodes.map(n => {
      const tone = n.status ? statusTone[n.status as Status] : 'none';
      const cx = n.kind === 'decision' || n.kind === 'start' || n.kind === 'end';
      const tx = cx ? n.w / 2 : 16;
      const top = 11 + 14;
      return <g key={n.id} className={`nd k-${n.kind ?? 'step'} t-${tone}${n.status === 'blocked' || n.status === 'risk' ? ' hot' : ''}`} transform={`translate(${n.x} ${n.y})`}>
        <NodeShape n={n}/>
        {n.status && !cx && <rect className="sb" x={0} y={10} width={3} height={n.h - 20} rx={1.5}/>}
        {n.lines.map((l, i) => <text key={i} className="nt" x={tx} y={top + i * LINE} textAnchor={cx ? 'middle' : 'start'}>{l}</text>)}
        {(n.sub || n.status) && <text className="ns" x={tx} y={top + n.lines.length * LINE + 1} textAnchor={cx ? 'middle' : 'start'}>
          {n.status && <tspan className="sc">{ctx.t.status[n.status as Status]}</tspan>}{n.status && n.sub ? ' · ' : ''}{n.sub}
        </text>}
      </g>;
    })}
  </svg>;
}

export const flow = defineBlock({
  type: 'flow',
  description: 'Flowchart laid out automatically (elkjs): boxes with optional status colour, decisions, start/end pills, labelled arrows; left→right or top→bottom.',
  when: 'A process, pipeline, causal chain or state change where the arrows are the point (where it is stuck, what caused what). ≤12 nodes in a report; mark the bottleneck with status blocked.',
  fields: {
    dir: z.enum(['LR', 'TB']).default('LR'),
    nodes: z.array(z.strictObject({
      id: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/),
      label: z.string().trim().min(1).max(30),
      sub: z.string().trim().min(1).max(24).optional(),
      status: statusEnum.optional(),
      kind: z.enum(['step', 'decision', 'start', 'end']).optional(),
    })).min(2).max(25),
    edges: z.array(z.strictObject({
      from: z.string(), to: z.string(),
      label: z.string().trim().min(1).max(16).optional(),
      kind: z.enum(['solid', 'dashed']).optional(),
    })).max(40),
  },
  refine: (v, c) => {
    const f = v as unknown as Flow;
    const ids = new Set<string>();
    f.nodes.forEach((n, i) => { if (ids.has(n.id)) c.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `duplicate id "${n.id}"` }); ids.add(n.id); });
    f.edges.forEach((e, i) => (['from', 'to'] as const).forEach(k => { if (!ids.has(e[k])) c.addIssue({ code: 'custom', path: ['edges', i, k], message: `unknown node id "${e[k]}"` }); }));
  },
  examples: [{ title: '卡在安裝：新版 .2 裝上後退回 .1', nodes: [{ id: 'impl', label: '實作', status: 'done' }, { id: 'review', label: '複審', status: 'done' }, { id: 'pack', label: '打包', status: 'done' }, { id: 'install', label: '安裝', sub: '退回 .1', status: 'blocked' }, { id: 'accept', label: '驗收', status: 'pending' }], edges: [{ from: 'impl', to: 'review' }, { from: 'review', to: 'pack' }, { from: 'pack', to: 'install' }, { from: 'install', to: 'accept' }] }],
  fit: b => (b.nodes.length <= 6 && b.dir === 'TB' ? 'visual' : 'full'),
  visual: true,
  prepare: async (b: Flow, mode): Promise<Prepared> => {
    const main = await layoutGraph(b.nodes, b.edges, b.dir);
    const narrow = mode === 'doc' && b.dir === 'LR' && main.w > 360 ? await layoutGraph(b.nodes, b.edges, 'TB') : undefined;
    return { main, narrow };
  },
  Doc: ({ block, ctx }) => {
    const p = ctx.prepared as Prepared;
    return <Card type="flow" block={block} ctx={ctx} className={p.narrow ? 'has-narrow' : undefined}>
      <div className="fl-wrap"><Graph g={p.main} ctx={ctx} cls="wide"/>{p.narrow && <Graph g={p.narrow} ctx={ctx} cls="narrow"/>}</div>
    </Card>;
  },
  Slide: ({ block, ctx }) => {
    const p = ctx.prepared as Prepared;
    const fitW = Math.min(p.main.w * 1.25, 1136, (400 * p.main.w) / p.main.h);
    return <Card type="flow" block={block} ctx={ctx}><div className="fl-wrap"><Graph g={p.main} ctx={ctx} cls="wide" maxW={Math.round(fitW)}/></div></Card>;
  },
  slide: { weight: b => (b.dir === 'TB' ? 0.8 : 0.6) },
});
