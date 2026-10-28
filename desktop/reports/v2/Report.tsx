import type { ReactNode } from 'react';
import { registry } from './blocks';
import { labels, levelTone, type Labels } from './core/i18n';
import type { Ctx, Mode } from './core/registry';
import { layoutInputs, planLayout, type AnyBlock, type SlidePlan } from './planner';
import type { BrokenBlock, ReportSpec } from './spec';

export type Prepared = WeakMap<object, unknown>;

function ErrorBlock({ block, t }: { block: BrokenBlock; t: Labels }) {
  return <div className="blk blk-error" role="note"><p><b>{t.brokenBlock}</b><code>{block.original}</code></p><p className="em">{block.path} — {block.message}</p></div>;
}

export function BlockView({ block, ctx, prepared }: { block: AnyBlock; ctx: Omit<Ctx, 'prepared'>; prepared: Prepared }) {
  if (block.type === '__error') return <ErrorBlock block={block as BrokenBlock} t={ctx.t}/>;
  const def = registry.get(block.type)!;
  const View = ctx.mode === 'slide' && def.Slide ? def.Slide : def.Doc;
  return <View block={block} ctx={{ ...ctx, prepared: prepared.get(block) }}/>;
}

function Verdict({ spec, t }: { spec: ReportSpec; t: Labels }) {
  const tone = spec.status ? levelTone[spec.status.level] : 'info';
  return <section className={`verdict t-${tone}`} aria-label={t.verdict}>
    <p className="vlabel"><span>{t.verdict}</span>{spec.status && <span className={`pill t-${tone}`}>{t.level[spec.status.level]}</span>}{spec.status?.reason && <span className="vreason">{spec.status.reason}</span>}</p>
    <p className="vline">{spec.tldr}</p>
    {spec.next && <NextChips next={spec.next} t={t}/>}
  </section>;
}

export function NextChips({ next, t }: { next: string[]; t: Labels }) {
  return <div className="plan"><span className="plabel">{t.next}</span>
    {next.map((s, i) => <span key={i} className="pstep-wrap">{i > 0 && <span className="parr" aria-hidden="true">→</span>}<span className="pstep"><i>{i + 1}</i>{s}</span></span>)}
  </div>;
}

export function Asks({ spec, t }: { spec: ReportSpec; t: Labels }) {
  if (!spec.asks) return null;
  return <section className="asks" aria-labelledby="asks-h"><h2 id="asks-h">{t.asks}</h2>
    {spec.asks.length === 0 ? <p className="noask">{t.noAsk}</p>
      : <ol>{spec.asks.map((a, i) => <li key={i}><i>{i + 1}</i><p><b>{a.what}</b>{(a.who || a.by) && <span>{[a.who, a.by && `${t.by} ${a.by}`].filter(Boolean).join(' · ')}</span>}</p></li>)}</ol>}
  </section>;
}

export function eyebrow(spec: ReportSpec, t: Labels) {
  return [t.report, spec.kind && t.kind[spec.kind], `${t.asOf} ${spec.asOf}`].filter(Boolean).join(' · ');
}

export function DocReport({ spec, prepared }: { spec: ReportSpec; prepared: Prepared }) {
  const t = labels[spec.lang];
  const ctx = (id: string): Omit<Ctx, 'prepared'> => ({ lang: spec.lang, t, mode: 'doc' as Mode, id });
  return <div className="rpt"><main className="rp" lang={spec.lang}>
    <header className="rp-head"><p className="eyebrow">{eyebrow(spec, t)}</p><h1>{spec.title}</h1>{spec.subtitle && <p className="subtitle">{spec.subtitle}</p>}</header>
    <Verdict spec={spec} t={t}/>
    {spec.sections.map((sec, si) => {
      const rows = planLayout(layoutInputs(sec.blocks, registry), sec.layout);
      const id = sec.id ?? `s${si + 1}`;
      return <section key={si} className="sec" id={id} aria-labelledby={`${id}-h`}>
        <header className={`sh${sec.blocks.every(b => b.type === 'sources') ? ' sr-only' : ''}`}>{sec.takeaway && <p className="kicker">{sec.title}</p>}<h2 id={`${id}-h`}>{sec.takeaway ?? sec.title}</h2></header>
        {rows.map((row, ri) => <div key={ri} className={`row r-${row.kind}`}>
          {row.cells.map(c => <div key={c.index} className="cell" style={row.cells.length > 1 ? { ['--span' as string]: c.span } : undefined}>
            <BlockView block={sec.blocks[c.index]} ctx={ctx(`${id}-b${c.index}`)} prepared={prepared}/>
          </div>)}
        </div>)}
      </section>;
    })}
    <Asks spec={spec} t={t}/>
    <footer className="rp-foot">Botling · Report v2{spec.kind ? ` · ${spec.kind}` : ''}</footer>
  </main></div>;
}

function SlideFrame({ n, total, spec, children, master }: { n: number; total: number; spec: ReportSpec; children: ReactNode; master: string }) {
  return <section className="sv" id={`slide-${n}`} aria-roledescription="slide" aria-label={`${n} / ${total}`}>
    <div className={`sl m-${master}`}>
      {children}
      <footer className="sf"><span>{spec.title}</span><span>{n} / {total}</span></footer>
    </div>
  </section>;
}

export function SlideDeck({ spec, slides, prepared }: { spec: ReportSpec; slides: SlidePlan[]; prepared: Prepared }) {
  const t = labels[spec.lang];
  const ctx = (id: string): Omit<Ctx, 'prepared'> => ({ lang: spec.lang, t, mode: 'slide' as Mode, id });
  const total = slides.length;
  return <main className="deck" lang={spec.lang}>
    {slides.map((s, i) => {
      const n = i + 1;
      const blocks = (list: AnyBlock[], side: string) => list.map((b, k) => <BlockView key={k} block={b} ctx={ctx(`p${n}-${side}${k}`)} prepared={prepared}/>);
      if (s.master === 'cover') {
        const tone = spec.status ? levelTone[spec.status.level] : 'info';
        return <SlideFrame key={i} n={n} total={total} spec={spec} master="cover">
          <p className="eyebrow">{eyebrow(spec, t)}</p>
          <h1>{spec.title}</h1>
          {spec.subtitle && <p className="subtitle">{spec.subtitle}</p>}
          <div className={`verdict t-${tone}`}><p className="vlabel"><span>{t.verdict}</span>{spec.status && <span className={`pill t-${tone}`}>{t.level[spec.status.level]}</span>}{spec.status?.reason && <span className="vreason">{spec.status.reason}</span>}</p><p className="vline">{spec.tldr}</p></div>
        </SlideFrame>;
      }
      if (s.master === 'closing') {
        return <SlideFrame key={i} n={n} total={total} spec={spec} master="closing">
          <h2>{spec.next ? t.next : t.asks}</h2>
          <div className="cl">
            {spec.next && <NextChips next={spec.next} t={t}/>}
            <Asks spec={spec} t={t}/>
          </div>
          {blocks(s.main, 'm')}
        </SlideFrame>;
      }
      return <SlideFrame key={i} n={n} total={total} spec={spec} master={s.master}>
        {s.kicker && s.kicker !== s.headline && <p className="kicker">{s.kicker}</p>}
        <h2>{s.headline}</h2>
        <div className="sev">
          <div className="evm">{blocks(s.main, 'm')}</div>
          {s.side.length > 0 && <div className="evs">{blocks(s.side, 's')}</div>}
        </div>
      </SlideFrame>;
    })}
  </main>;
}
