// Third-party licence notices for the bundled report command (out/report/report.cjs). Every package
// esbuild put into the bundle (from its metafile) is listed with its full licence text, so the
// shipped Resources/report folder carries them next to the code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Packages (name → folder) whose files are inputs of an esbuild metafile. */
export function bundledPackages(metafile, root) {
  const found = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = input.split(/[\\/]/);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const name = parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
    found.set(name, join(root, ...parts.slice(0, at + 1 + name.split('/').length)));
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

function licenceText(folder) {
  const file = readdirSync(folder).find(f => /^(licen[cs]e|copying)([-.][\w.-]*)?$/i.test(f));
  return file ? readFileSync(join(folder, file), 'utf8').trim() : null;
}

/** The notices file: one section per package with name, version, licence id and full text. */
export function thirdPartyNotices(metafile, root) {
  const out = ['Third-party software bundled in report.cjs (Botling report command).', 'Each package below is included unmodified; its licence text follows.', ''];
  const missing = [];
  for (const [name, folder] of bundledPackages(metafile, root)) {
    const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    let text = existsSync(folder) ? licenceText(folder) : null;
    // elkjs is dual-licensed EPL-2.0 OR GPL-3.0-or-later; its package carries the full EPL-2.0 text, used here.
    if (text && name === 'elkjs') text = `Used under EPL-2.0 (elected from "EPL-2.0 OR GPL-3.0-or-later"), unmodified. Source code: https://github.com/kieler/elkjs\n\n${text}`;
    if (!text) { missing.push(name); text = `(no licence file in the package; declared licence: ${pkg.license ?? 'unknown'})`; }
    out.push('='.repeat(78), `${name} ${pkg.version} — ${pkg.license ?? 'unknown'}`, pkg.homepage ? `Source: ${pkg.homepage}` : '', '-'.repeat(78), text, '');
  }
  return { text: out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n', missing };
}
export const NOTICES_FILE = 'THIRD_PARTY_LICENSES.txt';
