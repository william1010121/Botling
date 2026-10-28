#!/usr/bin/env node
// Development entry of the report command (see reports/cli.ts for the contract):
//   node desktop/scripts/report.mjs spec.json /abs/.bot/artifacts/report.html [--force] [--slides]
//   node desktop/scripts/report.mjs --check spec.json      validate + lint only, writes nothing
//   node desktop/scripts/report.mjs --docs                 regenerate docs/report-blocks.md + JSON Schema
// The app ships the same command bundled (out/report/report.cjs, `Botling --render-report`).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadReports, root } from '../reports/load.mjs';

const args = process.argv.slice(2);
const api = await loadReports();
if (args.includes('--docs')) {
  const doc = join(root, 'docs/report-blocks.md'), schema = join(root, 'reports/v2/report-spec.schema.json');
  await writeFile(doc, api.promptDoc());
  await writeFile(schema, JSON.stringify(api.jsonSchema(), null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, written: [doc, schema] }));
} else {
  process.exitCode = api.runCli(args);
}
