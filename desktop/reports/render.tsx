import { renderToStaticMarkup } from 'react-dom/server';
import { Report } from './Report';
import { reportSchema } from './schema';
import css from './report.css';
export { reportSchema } from './schema';
/** Render once with React, deliver readable HTML even when scripts cannot run. */
export function renderReport(input: unknown): string {
  const report = reportSchema.parse(input);
  const head = renderToStaticMarkup(<><title>{report.title}</title><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="color-scheme" content="light dark"/></>);
  return '<!doctype html><meta charset="utf-8">' + head + `<style>${css}</style>` + renderToStaticMarkup(<Report report={report}/>);
}
