import type { ReactNode } from 'react';
import type { Ctx } from './registry';
import { statusTone, type Status, type Tone } from './i18n';

/** The card every visual block sits in: action title + faint note, like the app's report cards. */
export function Card({ type, block, ctx, children, plain, className }: {
  type: string; block: { title?: string; note?: string }; ctx: Ctx; children: ReactNode; plain?: boolean; className?: string;
}) {
  const head = block.title || block.note
    ? <header className="bh">{block.title && <h3 id={`${ctx.id}-t`}>{block.title}</h3>}{block.note && <p>{block.note}</p>}</header>
    : null;
  return <figure className={`blk blk-${type}${plain ? ' plain' : ''}${className ? ' ' + className : ''}`} aria-labelledby={block.title ? `${ctx.id}-t` : undefined}>
    {head}{children}
  </figure>;
}

export function Pill({ status, ctx }: { status: Status; ctx: Ctx }) {
  return <span className={`pill t-${statusTone[status]}`}>{ctx.t.status[status]}</span>;
}
export function TonePill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill t-${tone}`}>{children}</span>;
}

/** Swatch legend for multi-series charts; series colours are c1..c4 from the theme. */
export function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return <ul className="legend" aria-hidden="true">{names.map((n, i) => <li key={i}><i className={`sw c${i + 1}`}/>{n}</li>)}</ul>;
}

/** Visually hidden data table: the accessible twin of a chart. */
export function SrTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: Array<Array<string | number>> }) {
  return <table className="sr-only"><caption>{caption}</caption><thead><tr>{columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>)}</tr>)}</tbody></table>;
}

export function Md({ html, className }: { html: string; className?: string }) {
  return <div className={className ?? 'md'} dangerouslySetInnerHTML={{ __html: html }}/>;
}
