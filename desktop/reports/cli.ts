// The report command, shared by `node desktop/scripts/report.mjs` (development), the bundled
// out/report/report.cjs and the app's own `Botling --render-report` (packaged builds cannot run
// Electron as Node). Synchronous on purpose: the app runs it before anything else and exits.
//   <command> spec.json /abs/…/artifacts/report.html [--force] [--slides]   render, print one JSON line
//   <command> --check spec.json                                             validate + lint only
// Output JSON: {"ok", "errors": [{path, message, example?}], "warnings": [{path, message}], "htmlPath"?, "link"?, "slides"?}
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderAny } from './render';

export const USAGE = 'Usage: <report command> spec.json /abs/path/artifacts/report.html [--force] [--slides] | --check spec.json';
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** v2 image blocks may name a file next to the spec; inline it so the HTML stays self-contained. */
function inlineImages(spec: any, base: string): void {
  if (spec?.version !== 2 || !Array.isArray(spec.sections)) return;
  for (const sec of spec.sections) for (const b of Array.isArray(sec?.blocks) ? sec.blocks : []) {
    if (b?.type !== 'image' || typeof b.src !== 'string' || /^[a-z]+:/i.test(b.src)) continue;
    const file = resolve(base, b.src), type = MIME[extname(file).toLowerCase()];
    let real: string | null = null;
    try { real = realpathSync(file); } catch { /* left as is: validation reports it */ }
    if (!type || !real || !real.startsWith(base + sep)) continue;
    b.src = `data:${type};base64,${readFileSync(real).toString('base64')}`;
  }
}

const REJECT = 'Output must be an .html file inside an artifacts folder.';
/**
 * Where the page may go, decided without touching the disk: an .html file whose folder, after
 * resolving `..` and symlinks, is an `artifacts` folder named in the path or inside it. A missing
 * folder is allowed only when it is that artifacts folder itself and its parent exists (`create`).
 */
export function checkDestination(output: string): { destination: string; create?: string } {
  const destination = resolve(output);
  if (extname(destination).toLowerCase() !== '.html') throw Error(REJECT);
  const folder = dirname(destination);
  const parts = folder.split(sep);
  const at = parts.lastIndexOf('artifacts');
  if (at < 0) throw Error(REJECT);
  const artifacts = parts.slice(0, at + 1).join(sep) || sep;
  if (!existsSync(artifacts)) {
    if (folder !== artifacts || !existsSync(dirname(artifacts)) || !statSync(dirname(artifacts)).isDirectory()) throw Error(REJECT);
    return { destination, create: artifacts };
  }
  if (!existsSync(folder)) throw Error(REJECT);
  const root = realpathSync(artifacts), real = realpathSync(folder);
  if (real !== root && !real.startsWith(root + sep)) throw Error(REJECT);
  if (!root.split(sep).includes('artifacts')) throw Error(REJECT);
  return { destination };
}

export interface CliIO { stdout(text: string): void; stderr(text: string): void }
const defaultIO: CliIO = { stdout: t => writeSync(1, t), stderr: t => writeSync(2, t) };

/** Run the command; returns the exit code (0 ok, 1 errors). Never throws. */
export function runCli(args: string[], io: CliIO = defaultIO): number {
  const print = (value: unknown) => io.stdout(JSON.stringify(value) + '\n');
  try {
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const [input, output, ...extra] = args.filter(a => !a.startsWith('--'));
    if ([...flags].some(f => !['--force', '--slides', '--check'].includes(f)) || extra.length || !input || (!flags.has('--check') && !output)) throw Error(USAGE);
    const data = JSON.parse(readFileSync(resolve(input), 'utf8'));
    inlineImages(data, realpathSync(dirname(resolve(input))));
    const mode = flags.has('--slides') ? 'slide' : 'doc';
    const result = renderAny(data, { mode });
    const report = { ok: result.ok, errors: result.errors, warnings: result.warnings };
    if (flags.has('--check') || !result.html) { print(report); return result.ok ? 0 : 1; }
    // Everything is checked before anything is created; only a missing artifacts folder itself is made.
    const { destination, create } = checkDestination(output);
    if (create) { mkdirSync(create); if (realpathSync(create) !== realpathSync(dirname(create)) + sep + 'artifacts') throw Error('Output must be an .html file inside an artifacts folder.'); }
    // Explicit replacement only; never follow a pre-existing output symlink.
    const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (flags.has('--force') ? constants.O_TRUNC : constants.O_EXCL), 0o600);
    try { writeSync(fd, result.html); } finally { closeSync(fd); }
    const title = String(data.title).replace(/[[\]\n\r]/g, ' ');
    print({ ...report, htmlPath: destination, link: `[${title}](${pathToFileURL(destination).href})`, ...(mode === 'slide' && result.slides ? { slides: result.slides } : {}) });
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`report: ${message}\n`);
    print({ ok: false, errors: [{ path: '', message }], warnings: [] });
    return 1;
  }
}
