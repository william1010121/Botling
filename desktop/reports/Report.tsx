import type { Block, Report as ReportData } from './schema';

const labels = {
  en: { summary: 'Summary', evidence: 'Evidence', next: 'Next steps', limits: 'Limits & open questions', asOf: 'As of', complete: 'Complete', partial: 'Partial', pending: 'Pending', blocked: 'Blocked', unverified: 'Unverified' },
  'zh-Hant': { summary: '重點', evidence: '證據', next: '下一步', limits: '限制與待確認', asOf: '資料截至', complete: '完成', partial: '部分完成', pending: '待處理', blocked: '受阻', unverified: '未驗證' },
};
type Labels = typeof labels.en;
function BlockView({ block, words }: { block: Block; words: Labels }) {
  switch (block.type) {
    case 'paragraph': return <p>{block.text}</p>;
    case 'list': { const List = block.ordered ? 'ol' : 'ul'; return <List>{block.items.map((item, i) => <li key={i}>{item}</li>)}</List>; }
    case 'table': return <div className="table-scroll" role="region" aria-label={block.caption} tabIndex={0}><table><caption>{block.caption}</caption><thead><tr>{block.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
    case 'finding': return <article className="finding"><div className="finding-heading"><h3>{block.title}</h3><span className={`status ${block.status}`}>{words[block.status]}</span></div><p>{block.evidence}</p>{block.next && <p className="next"><strong>{words.next} · </strong>{block.next}</p>}</article>;
  }
}
export function Report({ report }: { report: ReportData }) {
  const words = labels[report.lang];
  return <main lang={report.lang} className="report">
    <header><p className="eyebrow">Botling / {words.asOf} {report.asOf}</p><h1>{report.title}</h1>{report.subtitle && <p className="subtitle">{report.subtitle}</p>}</header>
    <aside className="summary" aria-labelledby="summary-title"><h2 id="summary-title">{words.summary}</h2><p>{report.summary}</p></aside>
    {report.sections.map((section, i) => <section key={i} aria-labelledby={`section-${i}`}><h2 id={`section-${i}`}>{section.title}</h2>{section.blocks.map((block, j) => <BlockView key={j} block={block} words={words}/>)}</section>)}
    {!!report.evidence?.length && <section aria-labelledby="evidence-title"><h2 id="evidence-title">{words.evidence}</h2><dl>{report.evidence.map((item, i) => <div key={i}><dt>{item.source}</dt><dd>{item.detail}</dd></div>)}</dl></section>}
    {!!report.nextSteps?.length && <section aria-labelledby="next-title"><h2 id="next-title">{words.next}</h2><ol>{report.nextSteps.map((item, i) => <li key={i}>{item}</li>)}</ol></section>}
    {!!report.limitations?.length && <section className="limitations" aria-labelledby="limits-title"><h2 id="limits-title">{words.limits}</h2><ul>{report.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></section>}
    <footer>Botling · Report v{report.schemaVersion}</footer>
  </main>;
}
