// Build pinned helper as data; Electron signing must not mutate these verified bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function packageAgyHelper(root) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  mkdirSync(join(root, 'out/core'), {recursive:true});
  const stage = mkdtempSync(join(root, 'out/core/.agy-helper-'));
  try {
    const file = join(stage, 'botling-agy-file-helper');
    execFileSync('/usr/bin/clang', ['-std=c11','-D_DARWIN_C_SOURCE','-O2','-Wall','-Wextra','-Werror',join(root,'src/core/agent/agy-file-helper.c'),'-o',file]);
    const bytes = readFileSync(file);
    const pin = readFileSync(join(root,'src/core/agent/agy-mcp.ts'),'utf8').match(/AGY_FILE_HELPER_SHA = '([a-f0-9]{64})'/)?.[1];
    if (!pin || createHash('sha256').update(bytes).digest('hex') !== pin) throw Error('Built Antigravity helper differs from reviewed pin; packaging stopped.');
    execFileSync('/usr/bin/codesign', ['--verify','--strict',file]);
    writeFileSync(join(root,'out/core/agy-file-helper.base64'),bytes.toString('base64'));
  } finally { rmSync(stage,{recursive:true,force:true}); }
}
