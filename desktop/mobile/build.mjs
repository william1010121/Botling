// Botling Web: the desktop renderer and chat page (build-renderer.mjs, web mode) plus this folder's
// shell entry, sign-in page and phone layout. The mobile bridge serves dist/ under /mobile/.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { buildRenderer } from '../build-renderer.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
await buildRenderer({ root: join(root, '..'), outdir: out, web: true });
console.log(`Botling Web built: ${out}`);
