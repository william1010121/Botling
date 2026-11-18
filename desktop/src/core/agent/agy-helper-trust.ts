// The Antigravity file helper Botling runs is the one this build compiled from agy-file-helper.c and shipped inside the signed app as
// data (`agy-file-helper.base64` next to the core bundle, written by scripts/package-agy-helper.mjs). There is no pinned hash in the source:
// the installed copy of the helper is trusted when it is byte for byte the shipped one.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

let folder = __dirname;
/** Where the shipped helper is read from (tests; the core bundle's own folder otherwise). */
export function useShippedHelperDir(dir: string) { folder = dir; }
/** The helper shipped with this build. Throws when the build has none (fail closed). */
export function shippedHelperBytes(): Buffer {
  const missing = 'Bundled Botling helper is missing. Install a complete Botling build that includes Antigravity support.';
  let bytes: Buffer;
  try { bytes = Buffer.from(readFileSync(join(folder, 'agy-file-helper.base64'), 'utf8'), 'base64'); }
  catch { throw Error(missing); }
  // An empty or unreadable shipped file is no helper: it must never make an empty installed file "the shipped one".
  if (bytes.length === 0) throw Error(missing);
  return bytes;
}
export const shippedHelperSha = () => createHash('sha256').update(shippedHelperBytes()).digest('hex');
