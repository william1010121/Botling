// Explicit reviewed local-only assembly recovery. No compile path or implicit approval.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, cloneAssemblyConfig, digest, releaseSource, runReleaseSigner, verifyFrozen, variants } from './release-variants.mjs';
import { checkArtifact } from './release-check.mjs';

export const COMPILED_SHA = 'f7860bc9af7211788c74a9fa553abcc767eb81b2';
export const ALLOWED_CHANGES = Object.freeze([
  'desktop/scripts/release-variants.mjs', 'desktop/scripts/release-variants.test.mjs',
  'desktop/scripts/release-recovery.mjs', 'desktop/scripts/release-recovery.test.mjs',
  'desktop/docs/release-variants-recovery.md',
]);
const PRESERVED = ['public-production', 'local-trial-preserving', 'stage-local'];
// These ignored dependency/generated-output trees are not tracked compile inputs. No source-tree exceptions.
const NON_INPUTS = ['desktop/node_modules', 'Web/node_modules', 'desktop/out', 'desktop/mobile/dist', 'desktop/.cache', 'desktop/dist', 'desktop/test-results', 'desktop/playwright-report'];
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b, message) => demand(JSON.stringify(a) === JSON.stringify(b), message);
const hash = text => /^[a-f0-9]{64}$/.test(text || '');
const sha = text => /^[a-f0-9]{40}$/.test(text || '');
const inside = (path, root) => path === root || path.startsWith(root + '/');
const overlap = (a, b) => inside(a, b) || inside(b, a);
const git = (desktop, args) => execFileSync('git', ['--no-replace-objects', '-C', desktop, ...args], { maxBuffer: 64 * 1024 * 1024 });
function keys(value, names) { same(Object.keys(value ?? {}).sort(), [...names].sort(), 'Unexpected recovery record fields'); }
function canonical(path, directory = true) {
  demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Canonical absolute path required');
  const st = lstatSync(path);
  demand(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile()) && realpathSync(path) === path, 'Canonical non-symlink path required');
  return st;
}
function absent(path) { try { lstatSync(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
function ownedRecord(path, pin) {
  demand(hash(pin), 'Externally pinned record SHA-256 required');
  const before = canonical(path, false);
  demand(before.uid === process.getuid() && (before.mode & 0o7777) === 0o600 && before.size <= 1024 * 1024, 'Unsafe operator record ownership/mode/size');
  const parent = canonical(dirname(path));
  demand(parent.uid === process.getuid() && !(parent.mode & 0o022), 'Unsafe operator record parent');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    demand(st.dev === before.dev && st.ino === before.ino && st.isFile() && st.uid === process.getuid() && (st.mode & 0o7777) === 0o600, 'Operator record changed');
    const bytes = readFileSync(fd); demand(digest(bytes) === pin, 'Pinned operator record changed');
    return JSON.parse(bytes);
  } finally { closeSync(fd); }
}
// Preserve directories and legal app symlinks, without traversing symlinks. No excluded entries.
export function preservedTreeDigest(root) {
  canonical(root);
  const records = [];
  function walk(path) {
    const st = lstatSync(path), entry = { path: relative(root, path) || '.', mode: st.mode & 0o7777 };
    if (st.isSymbolicLink()) {
      const target = readlinkSync(path);
      demand(!isAbsolute(target) && inside(realpathSync(path), root), 'Preserved symlink must resolve within its tree');
      records.push({ ...entry, type: 'link', target });
    } else if (st.isDirectory()) {
      records.push({ ...entry, type: 'directory' });
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      demand(st.isFile(), 'Nonregular preserved tree entry');
      records.push({ ...entry, type: 'file', size: st.size, sha256: digest(readFileSync(path)) });
    }
  }
  walk(root); return digest(JSON.stringify(records));
}
function tree(desktop, revision) {
  demand(sha(revision), 'Full source SHA required');
  same(git(desktop, ['rev-parse', `${revision}^{commit}`]).toString().trim(), revision, 'Source must resolve to exact commit');
  return git(desktop, ['ls-tree', '-rz', '--full-tree', revision]).toString().split('\0').filter(Boolean).map(record => {
    const [info, path] = record.split('\t'), [mode, type, oid] = info.split(' ');
    demand(type === 'blob' && ['100644', '100755'].includes(mode), 'Symlink/submodule compiled input forbidden');
    demand(path && !path.includes('\n') && !path.includes('\\') && !path.split('/').some(x => !x || x === '.' || x === '..'), 'Unsafe tracked input path');
    return { record, path, mode, oid };
  });
}
export function recoverySourceEvidence(desktop, compiledSHA, assemblySHA) {
  const before = tree(desktop, compiledSHA), after = tree(desktop, assemblySHA);
  git(desktop, ['merge-base', '--is-ancestor', compiledSHA, assemblySHA]);
  const prior = new Map(before.map(file => [file.path, file])), next = new Map(after.map(file => [file.path, file]));
  const changedFiles = [...new Set([...prior.keys(), ...next.keys()])].sort().filter(path => prior.get(path)?.record !== next.get(path)?.record).map(path => {
    demand(ALLOWED_CHANGES.includes(path), `Unapproved changed input: ${path}`);
    const info = item => item ? { mode: item.mode, oid: item.oid } : null;
    return { path, before: info(prior.get(path)), after: info(next.get(path)) };
  });
  demand(changedFiles.length > 0, 'Recovery requires a reviewed packager diff');
  const inputs = files => digest(files.filter(file => !ALLOWED_CHANGES.includes(file.path)).map(file => file.record).sort().join('\0') + '\0');
  const compiledInputsSHA256 = inputs(before);
  same(inputs(after), compiledInputsSHA256, 'Tracked compiled inputs changed');
  const diffSHA256 = digest(git(desktop, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', compiledSHA, assemblySHA]));
  return { changedFiles, compiledInputsSHA256, diffSHA256 };
}
function cleanInputs(desktop, assemblySHA) {
  demand(!git(desktop, ['status', '--porcelain', '--untracked-files=all']).length, 'Dirty/untracked source checkout');
  same(git(desktop, ['rev-parse', 'HEAD']).toString().trim(), assemblySHA, 'Assembly HEAD changed');
  const checkout = realpathSync(join(desktop, '..'));
  // Compare actual bytes too, including assume-unchanged/skip-worktree paths hidden from git status.
  for (const file of tree(desktop, assemblySHA)) {
    const path = join(checkout, file.path), st = canonical(path, false), bytes = readFileSync(path);
    demand(!(st.mode & 0o6000) && Boolean(st.mode & 0o111) === (file.mode === '100755'), 'Tracked input mode changed');
    same(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), file.oid, 'Tracked worktree bytes changed');
  }
  for (const path of git(checkout, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) {
    demand(NON_INPUTS.some(root => inside(path, root)), `Untracked ignored compiled input: ${path}`);
  }
}
function preserved(manifest) {
  const errors = [];
  for (const name of PRESERVED) {
    try { same(preservedTreeDigest(join(manifest.frozenRoot, name)), manifest.preservedTrees[name], `Preserved tree changed: ${name}`); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Preserved public/failed-local trees changed');
}
function paths(manifest, desktop, options, created) {
  const checkout = realpathSync(join(desktop, '..'));
  canonical(manifest.frozenRoot);
  demand(!overlap(manifest.frozenRoot, checkout), 'Frozen root must be outside checkout');
  for (const record of [options.manifestPath, options.approvalPath]) demand(!inside(record, checkout) && !inside(record, manifest.frozenRoot), 'Operator records must be outside source and frozen roots');
  demand(!overlap(manifest.stage, manifest.output), 'Recovery stage/output overlap');
  for (const path of [manifest.stage, manifest.output]) {
    demand(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Canonical recovery destination required');
    const parent = canonical(dirname(path));
    demand(parent.uid === process.getuid() && !(parent.mode & 0o022), 'Unsafe recovery parent');
    for (const protectedPath of [checkout, manifest.frozenRoot, options.manifestPath, options.approvalPath]) demand(!overlap(path, protectedPath), 'Recovery destination overlaps protected input');
    if (!created) demand(absent(path), 'Recovery destination already exists');
    else if (!absent(path)) canonical(path);
  }
}
export function verifyRecovery(options, { compiledSHA = COMPILED_SHA, created = false } = {}) {
  const { desktop, manifestPath, manifestSHA256, approvalPath, approvalSHA256 } = options;
  const approval = ownedRecord(approvalPath, approvalSHA256), manifest = ownedRecord(manifestPath, manifestSHA256);
  keys(approval, ['schema', 'action', 'manifestSHA256', 'assemblySourceSHA', 'compiledSourceSHA', 'variant', 'explicitApproval', 'reviewer', 'recordId']);
  keys(manifest, ['schema', 'scope', 'variant', 'compiledSourceSHA', 'assemblySourceSHA', 'diffSHA256', 'compiledInputsSHA256', 'changedFiles', 'frozenRoot', 'compiledManifestSHA256', 'preservedTrees', 'stage', 'output']);
  demand(approval.schema === 1 && approval.action === 'assemble-local-recovery' && approval.explicitApproval === true && approval.variant === 'local'
    && typeof approval.reviewer === 'string' && approval.reviewer.trim() && typeof approval.recordId === 'string' && approval.recordId.trim(), 'Explicit external local-only approval required');
  same(approval.manifestSHA256, manifestSHA256, 'Approval does not bind manifest bytes');
  demand(manifest.schema === 1 && manifest.scope === 'local-only-packager-recovery' && manifest.variant === 'local', 'Recovery is local only');
  same(manifest.compiledSourceSHA, compiledSHA, 'Unreviewed compiled base');
  same(approval.compiledSourceSHA, compiledSHA, 'Approval compiled SHA mismatch');
  same(approval.assemblySourceSHA, manifest.assemblySourceSHA, 'Approval assembly SHA mismatch');
  cleanInputs(desktop, manifest.assemblySourceSHA);
  const evidence = recoverySourceEvidence(desktop, compiledSHA, manifest.assemblySourceSHA);
  for (const field of ['changedFiles', 'diffSHA256', 'compiledInputsSHA256']) same(manifest[field], evidence[field], `Reviewed ${field} mismatch`);
  paths(manifest, desktop, options, created);
  const frozenPath = join(manifest.frozenRoot, 'COMPILED_PROVENANCE.json'); canonical(frozenPath, false);
  same(digest(readFileSync(frozenPath)), manifest.compiledManifestSHA256, 'Original frozen manifest changed');
  const frozen = JSON.parse(readFileSync(frozenPath));
  same(frozen.source.sourceSHA, compiledSHA, 'Frozen source identity mismatch');
  const current = releaseSource(desktop);
  same({ ...current, sourceSHA: compiledSHA }, frozen.source, 'Non-SHA source/toolchain/trust/storage changed');
  verifyFrozen(manifest.frozenRoot, frozen.source);
  keys(manifest.preservedTrees, PRESERVED);
  for (const name of PRESERVED) demand(hash(manifest.preservedTrees[name]), 'Preserved tree pin missing');
  preserved(manifest);
  return { manifest, frozen, current, record: { compiledSourceSHA: compiledSHA, assemblySourceSHA: manifest.assemblySourceSHA,
    manifestPath, manifestSHA256, approvalPath, approvalSHA256, approval, compiledManifestSHA256: manifest.compiledManifestSHA256,
    diffSHA256: manifest.diffSHA256, compiledInputsSHA256: manifest.compiledInputsSHA256 } };
}
function postcheck(options, verified, policy) {
  const errors = [];
  // Run all preservation checks even when an earlier source/approval check fails.
  for (const check of [() => verifyRecovery(options, { ...policy, created: true }),
    () => verifyFrozen(verified.manifest.frozenRoot, verified.frozen.source), () => preserved(verified.manifest)]) {
    try { check(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Recovery postcheck failed; retain all outputs and do not retry');
}
export async function recoverLocal(options, actions, policy) {
  const verified = verifyRecovery(options, policy); // Before any signer or builder callback.
  const { manifest, frozen, record } = verified;
  let result, failure;
  try {
    await actions.preflight();
    verifyRecovery(options, policy); // Recheck after preflight and before exclusive mkdir/build.
    result = await actions.assemble({ manifest, source: frozen.source, recovery: { stage: manifest.stage, output: manifest.output, record, assertFresh: () => paths(manifest, options.desktop, options, false) } });
    postcheck(options, verified, policy); // No ZIP signing if the builder changed protected inputs.
    await actions.sign(result);
  } catch (error) { failure = error; }
  try { postcheck(options, verified, policy); } catch (error) { failure = failure ? new AggregateError([failure, error], 'Assembly and recovery postcheck failed; outputs retained') : error; }
  if (failure) throw failure;
  writeFileSync(join(manifest.output, 'RECOVERY_COMPLETE.json'), JSON.stringify({ schema: 1, ...record, preservedTrees: manifest.preservedTrees }, null, 2) + '\n', { flag: 'wx' });
  return result;
}

async function main(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; demand(['--manifest', '--manifest-sha256', '--approval', '--approval-sha256', '--key-file', '--check'].includes(flag) && !(flag in parsed), 'Invalid recovery arguments');
    parsed[flag] = flag === '--check' ? true : args[++i]; demand(parsed[flag], 'Recovery argument requires a value');
  }
  demand(process.platform === 'darwin' && process.arch === 'arm64', 'Recovery requires macOS arm64');
  for (const name of ['CSC_LINK', 'CSC_NAME', 'BOTLING_RELEASE_KEY', 'NODE_OPTIONS', 'NODE_PATH']) demand(!process.env[name], 'Unsafe recovery environment');
  const desktop = fileURLToPath(new URL('../', import.meta.url));
  const options = { desktop, manifestPath: parsed['--manifest'], manifestSHA256: parsed['--manifest-sha256'], approvalPath: parsed['--approval'], approvalSHA256: parsed['--approval-sha256'] };
  if (parsed['--check']) { verifyRecovery(options); console.log('Reviewed local recovery checks passed; no assembly or signing performed'); return; }
  const keyFile = parsed['--key-file'] ?? process.env.BOTLING_RELEASE_KEY_FILE;
  demand(isAbsolute(keyFile || ''), 'Explicit signing key file path required');
  process.env.BOTLING_RELEASE_BUILD = '1'; process.env.BOTLING_UNSIGNED_UPDATES = '0'; process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  await recoverLocal(options, {
    preflight: () => runReleaseSigner(desktop, ['preflight'], keyFile),
    assemble: async ({ manifest, source, recovery }) => {
      // Cache writes are confined to the exclusively created recovery output, never preserved trees.
      process.env.ELECTRON_BUILDER_CACHE = join(manifest.output, '.cache/electron-builder');
      process.env.electron_config_cache = join(manifest.output, '.cache/electron');
      process.env.ELECTRON_CACHE = process.env.electron_config_cache;
      const { build, Platform } = await import('electron-builder');
      const base = cloneAssemblyConfig((await import(pathToFileURL(join(desktop, 'electron-builder.config.cjs')).href)).default);
      return assemble(desktop, manifest.frozenRoot, 'local', source,
        config => build({ projectDir: desktop, targets: Platform.MAC.createTarget(), config, publish: 'never' }), base, undefined, recovery);
    },
    sign: result => {
      runReleaseSigner(desktop, ['sign', variants.local.version, result.zip], keyFile);
      const manifest = `${result.zip}.manifest.json`;
      checkArtifact(readFileSync(result.zip), JSON.parse(readFileSync(manifest)), JSON.parse(readFileSync(join(desktop, 'release-config.json'))).publicKey, variants.local.version);
      const files = [...result.artifacts, manifest];
      writeFileSync(join(result.output, 'SHA256SUMS.txt'), files.map(path => `${digest(readFileSync(path))}  ${relative(result.output, path)}\n`).join(''), { flag: 'wx' });
    },
  });
  console.log('Local recovery assembled; preserved trees unchanged. Acceptance/install approval still required.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`Local recovery refused: ${error.message}`); process.exitCode = 1; }
}
