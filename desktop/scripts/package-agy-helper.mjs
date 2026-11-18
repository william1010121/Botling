// Build the file helper from its C source and keep it as data; Electron signing must not mutate these bytes.
//
// There is no pinned hash: Botling builds the helper itself, so whatever this Xcode makes is the helper of this build (clang's output
// differs between Xcode versions, and a release must not stop for that). The runtime trusts the copy shipped inside the signed app
// (out/core/agy-file-helper.base64, read by src/core/agent/agy-helper-trust.ts) and checks the installed helper against it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const clang = (root, file) => execFileSync('/usr/bin/clang', ['-std=c11','-D_DARWIN_C_SOURCE','-O2','-Wall','-Wextra','-Werror',join(root,'src/core/agent/agy-file-helper.c'),'-o',file]);
const codesignVerify = (file) => execFileSync('/usr/bin/codesign', ['--verify','--strict',file]);
/** `compile` and `verify` are the tools' places for tests; `platform` and `arch` are where this runs. */
export function packageAgyHelper(root, { platform = process.platform, arch = process.arch, compile = clang, verify = codesignVerify } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') return;
  mkdirSync(join(root, 'out/core'), {recursive:true});
  const stage = mkdtempSync(join(root, 'out/core/.agy-helper-'));
  try {
    const file = join(stage, 'botling-agy-file-helper');
    compile(root, file);
    verify(file);
    writeFileSync(join(root,'out/core/agy-file-helper.base64'),readFileSync(file).toString('base64'));
  } finally { rmSync(stage,{recursive:true,force:true}); }
}
