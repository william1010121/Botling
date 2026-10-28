import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
/** One immutable boot generation. No request reads live bundle files after activation. A new core
 * boot gets a new id even when mobile bytes are unchanged, fencing clients of the previous core. */
export interface MobileGeneration { id: string; files: ReadonlyMap<string, Buffer> }
export function loadMobileGeneration(root: string): MobileGeneration {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Mobile assets must be a real directory');
  const files = new Map<string, Buffer>(); let bytes = 0;
  function visit(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = prefix + name, st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error('Mobile symlink refused');
      if (st.isDirectory()) visit(path, rel + '/');
      else if (st.isFile()) {
        bytes += st.size;
        if (bytes > 128 * 1024 * 1024 || files.size >= 4096) throw new Error('Mobile generation exceeds size limit');
        files.set(rel, readFileSync(path));
      } else throw new Error('Unsupported mobile resource');
    }
  }
  visit(root, '');
  if (!files.has('index.html') || !files.has('web.js')) throw new Error('Mobile entry points missing');
  return { id: randomBytes(32).toString('hex'), files };
}
export function generationBytes(generation: MobileGeneration, name: string): Buffer | undefined {
  const bytes = generation.files.get(name);
  if (!bytes || !/\.(?:html|js|css|webmanifest)$/.test(name)) return bytes;
  // Keep API routes stable; all asset/frame URLs carry this document's immutable generation.
  return Buffer.from(bytes.toString('utf8').replace(/(?<!\/api)\/mobile\//g, `/mobile/g/${generation.id}/`));
}
