// Build pinned helper as data; Electron signing must not mutate these verified bytes.
//
// The helper's bytes are pinned (AGY_FILE_HELPER_SHA in src/core/agent/agy-mcp.ts, checked again by the runtime installer before it
// ever uses the helper). clang's output depends on the Xcode that built it (the linker's version is written into the file), so a runner
// with another Xcode cannot reproduce the pin from the reviewed C source. The pinned bytes are therefore also kept as text
// (scripts/agy-file-helper.pinned.base64, made with `node scripts/package-agy-helper.mjs --refresh` on a machine whose clang reproduces
// the pin). A build packages, in this order: its own compile when it matches the pin; else the kept bytes when they match the pin
// (test/unit/agy-helper-pinned.test.ts keeps that file and the pin together); else it stops (a CI build that is not a release only
// leaves the helper out).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PINNED_FILE = join(dirname(fileURLToPath(import.meta.url)), 'agy-file-helper.pinned.base64');
/** The bytes to package: the compiled ones when they are the pin, else the kept pinned ones when they are; null: neither is. */
export function pickHelper(compiled, pinned, pin) {
  if (!pin) return null;
  if (sha(compiled) === pin) return { bytes: compiled, how: 'compiled' };
  if (pinned && sha(pinned) === pin) return { bytes: pinned, how: 'pinned' };
  return null;
}
const compile = (root, file) => execFileSync('/usr/bin/clang', ['-std=c11','-D_DARWIN_C_SOURCE','-O2','-Wall','-Wextra','-Werror',join(root,'src/core/agent/agy-file-helper.c'),'-o',file]);
const pinOf = (root) => readFileSync(join(root,'src/core/agent/agy-mcp.ts'),'utf8').match(/AGY_FILE_HELPER_SHA = '([a-f0-9]{64})'/)?.[1];
export function packageAgyHelper(root) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  mkdirSync(join(root, 'out/core'), {recursive:true});
  const stage = mkdtempSync(join(root, 'out/core/.agy-helper-'));
  try {
    const file = join(stage, 'botling-agy-file-helper');
    compile(root, file);
    const pin = pinOf(root);
    const kept = existsSync(PINNED_FILE) ? Buffer.from(readFileSync(PINNED_FILE, 'utf8').trim(), 'base64') : null;
    const picked = pickHelper(readFileSync(file), kept, pin);
    if (!picked) {
      // Neither this Xcode's output nor the kept bytes are the pin. Only a release build must stop for it
      // (the runtime installer checks the pin again before it ever uses the helper).
      if (process.env.BOTLING_RELEASE_BUILD !== '1' && process.env.CI) { console.warn('Antigravity helper differs from the reviewed pin; not packaged (CI, not a release build).'); return; }
      throw Error('Built Antigravity helper differs from reviewed pin; packaging stopped.');
    }
    if (picked.how === 'pinned') {
      console.warn('This Xcode builds the Antigravity helper differently from the pin; packaging the kept pinned bytes (scripts/agy-file-helper.pinned.base64).');
      writeFileSync(file, picked.bytes, { mode: 0o755 });
    }
    execFileSync('/usr/bin/codesign', ['--verify','--strict',file]);
    writeFileSync(join(root,'out/core/agy-file-helper.base64'),picked.bytes.toString('base64'));
  } finally { rmSync(stage,{recursive:true,force:true}); }
}
/** `--refresh`: compiles the helper and keeps its bytes as the pinned text, when they are the pin (after a change of the C source: update the pin first). */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--refresh') {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  mkdirSync(join(root, 'out'), {recursive:true});
  const stage = mkdtempSync(join(root, 'out/.agy-refresh-'));
  try {
    const file = join(stage, 'botling-agy-file-helper');
    compile(root, file);
    const bytes = readFileSync(file);
    if (sha(bytes) !== pinOf(root)) throw Error(`This clang builds ${sha(bytes)}, not the pin ${pinOf(root)}; nothing written.`);
    writeFileSync(PINNED_FILE, bytes.toString('base64'));
    console.log('pinned bytes written:', PINNED_FILE);
  } finally { rmSync(stage,{recursive:true,force:true}); }
}
