import { renderToStaticMarkup } from 'react-dom/server';
import { ZodError } from 'zod';
import { Report } from './Report';
import { reportSchema } from './schema';
import css from './report.css';
import { renderV2, type RenderResult } from './v2/render';
import { formatPath } from './v2/spec';
export { reportSchema } from './schema';
export { renderV2, renderBlock, css as v2css, PAGER } from './v2/render';
export { validateSpec, reportSpecSchema, blockSchema, minimalExample } from './v2/spec';
export { planLayout, planSlides, layoutInputs } from './v2/planner';
export { lintSpec, budgets } from './v2/lint';
export { blocks, registry } from './v2/blocks';
export { promptDoc, jsonSchema } from './v2/promptdoc';

/** v1: render once with React, deliver readable HTML even when scripts cannot run. */
export function renderReport(input: unknown): string {
  const report = reportSchema.parse(input);
  const head = renderToStaticMarkup(<><title>{report.title}</title><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="color-scheme" content="light dark"/></>);
  return '<!doctype html><meta charset="utf-8">' + head + `<style>${css}</style>` + renderToStaticMarkup(<Report report={report}/>);
}

/** Version dispatch: `version: 2` specs use the block system; everything else is a v1 report. */
export async function renderAny(input: unknown, opts: { mode?: 'doc' | 'slide' } = {}): Promise<RenderResult> {
  if (input && typeof input === 'object' && (input as { version?: unknown }).version === 2) return renderV2(input, opts);
  if (opts.mode === 'slide') return { ok: false, errors: [{ path: 'version', message: 'Slides need a version 2 spec.' }], warnings: [] };
  try {
    return { ok: true, errors: [], warnings: [], html: renderReport(input) };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, errors: e.issues.map(i => ({ path: formatPath(i.path), message: i.message })), warnings: [] };
    throw e;
  }
}
