/** Explicit user action only. No runtime execution, login, or mutable registry trust. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { validateAgyRuntimePath } from './agy-runtime-settings';
import { AGY_FILE_HELPER_SHA } from './agent/agy-mcp';

export const AGY_ARCHIVE_URL = 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip';
export const AGY_ARCHIVE_SHA = 'c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b';
export const agyLocalDestination = () => join(homedir(), 'Library/Application Support/Botling/runtimes/antigravity/1.4.3');
const command = (folder: string) => join(folder, 'agy_acp_server.par');
const runtimeFiles = ['agy_acp_server.par', 'localharness_external', 'botling-agy-file-helper'];
function requireRegularFiles(folder: string) {
  for (const name of runtimeFiles) {
    if (!lstatSync(join(folder, name)).isFile()) throw Error('Local runtime files must be regular files, not symlinks.');
  }
}
const exec = promisify(execFile);
export function verifyArchive(bytes: Buffer) {
  if (createHash('sha256').update(bytes).digest('hex') !== AGY_ARCHIVE_SHA) throw Error('Official ACP 1.4.3 archive hash mismatch. Retry the download.');
}
/** Reject external volumes and symlinked parents, including externally relocated home folders. */
export function assertLocalDestination(path: string) {
  let parent = resolve(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  if (process.platform !== 'darwin' || realpathSync(parent) !== parent || statSync(parent).dev !== statSync('/System/Volumes/Data').dev) {
    throw Error('Antigravity requires a canonical folder on the local macOS data disk. External or symlinked destinations are not supported.');
  }
}
async function downloadArchive(file: string) {
  const response = await fetch(AGY_ARCHIVE_URL, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw Error(`Official download failed (HTTP ${response.status}). Check the connection and retry.`);
  const chunks: Buffer[] = []; let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > 256 * 1024 * 1024) { await reader.cancel(); throw Error('Official download exceeded its size limit.'); }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks); verifyArchive(bytes); writeFileSync(file, bytes, { mode: 0o600 });
}
async function extractArchive(archive: string, folder: string) {
  // Extract only exact pinned filenames to chosen files, never trust archive paths/symlinks.
  for (const name of ['agy_acp_server.par', 'localharness_external']) {
    const { stdout } = await exec('/usr/bin/unzip', ['-p', archive, name], { encoding: 'buffer', maxBuffer: 384 * 1024 * 1024, timeout: 30_000 });
    writeFileSync(join(folder, name), stdout, { mode: 0o700 });
  }
}
function packagedHelper() {
  // Stored as data in app.asar: packaging/signing must not rewrite the pinned Mach-O bytes.
  let bytes: Buffer;
  try { bytes = Buffer.from(readFileSync(join(__dirname, 'agy-file-helper.base64'), 'utf8'), 'base64'); }
  catch { throw Error('Bundled Botling helper is missing. Install a complete Botling build that includes Antigravity support.'); }
  if (createHash('sha256').update(bytes).digest('hex') !== AGY_FILE_HELPER_SHA) throw Error('Bundled Botling helper hash mismatch. Install a complete trusted Botling build.');
  return bytes;
}
interface InstallOptions {
  destination?: string; platform?: string; arch?: string;
  assertLocal?: (folder: string) => void;
  download?: (file: string) => Promise<void>;
  extract?: (archive: string, folder: string) => Promise<void>;
  helper?: () => Buffer;
  validate?: (command: string, workspace: string) => void;
}
export class AgyRuntimeInstaller {
  private pending: Promise<string> | null = null;
  constructor(private options: InstallOptions = {}) {}
  install(workspace: string): Promise<string> {
    if (this.pending) return this.pending;
    this.pending = this.perform(workspace).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async perform(workspace: string) {
    const o = this.options;
    if ((o.platform ?? process.platform) !== 'darwin' || (o.arch ?? process.arch) !== 'arm64') throw Error('Automatic Antigravity installation requires macOS arm64.');
    const destination = o.destination ?? agyLocalDestination();
    const local = o.assertLocal ?? assertLocalDestination;
    local(destination);
    const validate = o.validate ?? validateAgyRuntimePath;
    if (existsSync(destination)) {
      try { requireRegularFiles(destination); validate(command(destination), workspace); return command(destination); } catch { /* stage repair before touching old bytes */ }
    }
    // Fail missing/untrusted packaging before downloading anything.
    const helper = (o.helper ?? packagedHelper)();
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    local(dirname(destination));
    const lock = destination + '.install-lock';
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw Error(`Another Antigravity installation may be running. Wait and retry. If interrupted, remove the empty lock folder: ${lock}`); }
    let stage: string | undefined;
    const backup = destination + '.previous-' + randomUUID();
    try {
      stage = mkdtempSync(join(dirname(destination), '.install-'));
      const payload = join(stage, 'runtime'), archive = join(stage, 'server.zip');
      mkdirSync(payload, { mode: 0o700 });
      await (o.download ?? downloadArchive)(archive);
      await (o.extract ?? extractArchive)(archive, payload);
      writeFileSync(join(payload, 'botling-agy-file-helper'), helper, { mode: 0o700 });
      for (const name of runtimeFiles) chmodSync(join(payload, name), 0o700);
      validate(command(payload), workspace);
      local(destination);
      const previous = existsSync(destination);
      if (previous) renameSync(destination, backup);
      try { renameSync(payload, destination); }
      catch (error) { if (previous) renameSync(backup, destination); throw error; }
      if (previous) rmSync(backup, { recursive: true, force: true });
      return command(destination);
    } catch (error) {
      throw Error(`Antigravity installation failed: ${(error as Error).message}. Saved runtime settings were not changed; retry from Doctor.`);
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
