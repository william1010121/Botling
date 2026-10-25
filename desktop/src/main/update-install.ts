// Ed25519 authenticates the ZIP before extraction, quarantine removal, or app replacement.
// The shell helper needs no Node runtime (packaged Electron has RunAsNode disabled).
import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { basename, dirname, join, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { compareVersions, parseVersion, RELEASE_PAGE } from "./updates";
import { trustKey, verifyManifest, type Manifest } from "../../scripts/release-manifest.mjs";
import type { ReleaseView } from "../contract";

export interface InstallOptions {
  current: string; appPath: string; dataDir: string; publicKey: string | null;
  platform: string; arch: string;
  fetch: (url: string) => Promise<Response>;
  /** Only dependency injection for tests, never a packaged environment knob. */
  assetURL?: (release: ReleaseView) => string;
  launchArgs?: string[];
}
const run = promisify(execFile);
// Native removal avoids Electron's ASAR virtual-filesystem recursion inside packaged bundles.
const removeTree = async (path: string) => { await run("/bin/rm", ["-rf", path], {timeout:120_000}); };
interface Pending { token: string; root: string; target: string; version: string; executable: string }
const MOVE_GUIDE = "Move Botling 2.app to Applications and open it there before updating (read-only or App Translocation copies cannot update).";

export function writableApp(target: string): void {
  if (!target.endsWith(".app") || (target.includes("/AppTranslocation/") || target.includes("/.botling-update-")) || !existsSync(target)) throw new Error(MOVE_GUIDE);
  if (realpathSync(target) !== target || lstatSync(target).isSymbolicLink()) throw new Error(MOVE_GUIDE);
  try {
    accessSync(target, constants.W_OK);
    accessSync(dirname(target), constants.W_OK);
    // A real write probe also catches read-only mounted volumes; access(W_OK) alone is insufficient.
    const probe = mkdtempSync(join(dirname(target), ".botling-write-probe-"));
    rmSync(probe, { recursive: true });
  } catch { throw new Error(MOVE_GUIDE); }
}

async function readBounded(response: Response, limit: number, destination?: string): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`Update download failed: HTTP ${response.status}`);
  const file = destination ? await open(destination, "wx", 0o600) : null;
  const chunks: Buffer[] = [];
  let count = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw new Error("Update download exceeds signed size or limit");
      if (file) await file.writeFile(value); else chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); await file?.close(); }
  return Buffer.concat(chunks);
}

export async function verifyArchive(zip: string, manifest: Manifest): Promise<void> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(zip)) { size += chunk.length; hash.update(chunk); }
  if (size !== manifest.size) throw new Error("Update size mismatch");
  if (hash.digest("hex") !== manifest.sha256) throw new Error("Update SHA-256 mismatch");
}

// Hash incrementally and yield file I/O; never load an entire ZIP or bundle into main's heap.
async function treeDigest(folder: string): Promise<string> {
  if (!(await fs.lstat(folder)).isDirectory()) throw new Error("Staged bundle must be a directory");
  const hash = createHash("sha256");
  async function visit(path: string, relative: string): Promise<void> {
    const stat = await fs.lstat(path);
    hash.update(JSON.stringify([relative, stat.mode & 0o777, stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file"]));
    if (stat.isSymbolicLink()) {
      const resolved = await fs.realpath(path);
      if (resolved !== folder && !resolved.startsWith(folder + sep)) throw new Error("Staged symlink escapes verified app");
      hash.update(await fs.readlink(path));
    } else if (stat.isDirectory()) for (const entry of (await fs.readdir(path)).sort()) await visit(join(path, entry), `${relative}/${entry}`);
    else if (stat.isFile()) for await (const bytes of createReadStream(path)) hash.update(bytes);
    else throw new Error("Unsupported staged file type");
  }
  await visit(folder, ""); return hash.digest("hex");
}

function newer(version: string, current: string): void {
  const a = parseVersion(version), b = parseVersion(current);
  if (!a || !b || a.major !== 2 || compareVersions(a, b) <= 0) throw new Error("Update would downgrade or reinstall this version");
}

/** Exit handling precedes every fallible operation. A healthy process has no receipt deadline:
 * a keychain prompt is not a failed boot. Rollback waits for graceful shutdown before restoring
 * the flushed data snapshot. Candidate output is discarded, never a lifetime unbounded log.
 */
export const SWAP_SCRIPT = `#!/bin/sh
set -eu
parent="$1"; target="$2"; staged="$3"; previous="$4"; receipt="$5"; token="$6"; executable="$7"; delay="$9"
root="\${staged%/*}"
data="\${10-}"; parent_attempts="\${11-1200}"; grace="\${12-50}"
if [ "$#" -ge 12 ]; then shift 12; else shift "$#"; fi
new_pid=''; moved=0; snapshot=0
finish() {
  code=$?
  trap - EXIT HUP INT TERM
  [ "$code" -ne 0 ] || exit 0
  if [ -n "$new_pid" ]; then
    kill -TERM "$new_pid" 2>/dev/null || true
    n=0
    while kill -0 "$new_pid" 2>/dev/null && [ "$n" -lt "$grace" ]; do n=$((n+1)); /bin/sleep 0.1; done
    kill -KILL "$new_pid" 2>/dev/null || true
    wait "$new_pid" 2>/dev/null || true
  fi
  available="$target"
  if [ "$moved" -eq 1 ] && [ -d "$previous" ]; then
    if [ -e "$target" ]; then /bin/mv "$target" "$root/failed.app" || code=15; fi
    if [ ! -e "$target" ]; then /bin/mv "$previous" "$target" || code=15; fi
    if [ -d "$previous" ]; then available="$previous"; code=15; fi
  fi
  if [ "$snapshot" -eq 1 ]; then
    /bin/rm -rf "$data"
    /usr/bin/ditto "$root/data-before" "$data" || code=16
  fi
  printf 'failed:%s\n' "$code" > "$root/result"
  # A timeout must not reopen into the old single-instance lock and then disappear on late exit.
  if [ "$code" -eq 10 ]; then while kill -0 "$parent" 2>/dev/null; do /bin/sleep 0.1; done; fi
  if ! kill -0 "$parent" 2>/dev/null && [ -d "$available" ]; then
    /usr/bin/open -n "$available" --env "HOME=$HOME" --env "TMPDIR=\${TMPDIR-}" --env "BOTLING_DATA_DIR=$data" --env "BOTLING_IMPORT_FROM=\${BOTLING_IMPORT_FROM-}" --env "BOTLING_1X_DIR=\${BOTLING_1X_DIR-}" --env "CODEX_HOME=\${CODEX_HOME-}" --env "CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR-}" --args "$@" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap 'finish "$@"' EXIT
trap 'exit 17' HUP INT TERM
printf '%s' "$$" > "$root/helper.pid"
n=0
while kill -0 "$parent" 2>/dev/null; do
  n=$((n+1)); [ "$n" -lt "$parent_attempts" ] || exit 10
  /bin/sleep 0.1
done
[ ! -e "$previous" ] || exit 11
# Old main has flushed core/cookies and exited. Every startup write is now recoverable.
if [ -n "$data" ] && [ -d "$data" ]; then /usr/bin/ditto "$data" "$root/data-before" || exit 16; snapshot=1; fi
/bin/mv "$target" "$previous" || exit 14
moved=1
/bin/mv "$staged" "$target" || exit 12
"$target/Contents/MacOS/$executable" "--botling-update-token=$token" "--botling-update-data=$data" "$@" >/dev/null 2>&1 &
new_pid=$!
printf '%s' "$new_pid" > "$root/new.pid"
while :; do
  if [ -f "$receipt" ] && [ "$(/bin/cat "$receipt")" = "$token" ] && kill -0 "$new_pid" 2>/dev/null; then
    # Commit marker precedes starting external work. After this, rollback is forbidden.
    printf 'booted\n' > "$root/result"
    trap - EXIT HUP INT TERM
    /bin/rm -rf "$previous" "$root/data-before"
    /bin/rm -f "$root/download.zip"
    exit 0
  fi
  kill -0 "$new_pid" 2>/dev/null || exit 13
  /bin/sleep "$delay"
done
`;

export class VerifiedInstaller {
  private staged: { pending: Pending; manifest: Manifest; zip: string; app: string; digest: string } | null = null;
  private busy = false;
  private availability: { at: number; error: string | null } | null = null;
  constructor(private readonly options: InstallOptions) {}
  unavailable(refresh = false): string | null {
    if (!refresh && this.availability && Date.now() - this.availability.at < 30_000) return this.availability.error;
    let error: string | null = null;
    try {
      trustKey(this.options.publicKey);
      if (this.options.platform !== "darwin") throw new Error("Self-update is currently available on macOS only. Open the release page to download.");
      writableApp(this.options.appPath);
    } catch (failure) { error = (failure as Error).message; }
    this.availability = { at: Date.now(), error };
    return error;
  }
  get ready(): string | null { return this.staged?.manifest.version ?? null; }
  async stage(release: ReleaseView): Promise<void> {
    if (this.busy) throw new Error("An update is already being prepared");
    const unavailable = this.unavailable(true);
    if (unavailable) throw new Error(unavailable);
    await recoverUpdates(this.options.dataDir, this.options.appPath);
    if (existsSync(join(this.options.dataDir, "update-pending.json")) || (await fs.readdir(join(this.options.dataDir, "update-cleanup")).catch(() => [])).length) throw new Error("The previous update still needs recovery; restart before preparing another update");
    newer(release.version, this.options.current);
    if (!release.asset || !new RegExp(`^Botling-2-.+-mac-${this.options.arch}\\.zip$`).test(release.asset)) throw new Error("No compatible macOS ZIP in this release");
    if (!release.url.startsWith(`${RELEASE_PAGE}tag/v${release.version}`) || new URL(release.url).pathname !== `/william1010121/Botling/releases/tag/v${release.version}`) throw new Error("Invalid release URL");
    this.busy = true;
    let root: string | undefined;
    try {
      await this.discard();
      const url = this.options.assetURL?.(release) ?? `${RELEASE_PAGE}download/v${encodeURIComponent(release.version)}/${encodeURIComponent(release.asset)}`;
      const manifest = verifyManifest(JSON.parse((await readBounded(await this.options.fetch(`${url}.manifest.json`), 16_384)).toString("utf8")), this.options.publicKey);
      if (manifest.version !== release.version) throw new Error("Signed version does not match release");
      newer(manifest.version, this.options.current);
      root = mkdtempSync(join(dirname(this.options.appPath), ".botling-update-"));
      chmodSync(root, 0o700);
      writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: process.pid, target: this.options.appPath, dataDir: this.options.dataDir }), { mode: 0o600 });
      const zip = join(root, "download.zip");
      await readBounded(await this.options.fetch(url), manifest.size, zip);
      await verifyArchive(zip, manifest);
      const entries = (await run("/usr/bin/unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split("\n");
      if (entries.some((entry) => !entry.startsWith("Botling 2.app/") || entry.split("/").some((part) => part === "..") || entry.includes("\\") || entry.includes("\r"))) throw new Error("Unsafe update archive paths");
      await run("/usr/bin/ditto", ["-x", "-k", zip, root]);
      const app = join(root, "Botling 2.app");
      const plist = join(app, "Contents", "Info.plist");
      const value = async (key: string) => (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" })).stdout.trim();
      if (await value("CFBundleIdentifier") !== "io.github.william1010121.Botling2" || await value("CFBundleShortVersionString") !== manifest.version) throw new Error("Update bundle identity or version mismatch");
      const executable = await value("CFBundleExecutable");
      if (!/^[A-Za-z0-9 ._-]+$/.test(executable) || !existsSync(join(app, "Contents", "MacOS", executable))) throw new Error("Invalid update executable");
      // Validate symlinks before xattr so even a signed archive cannot clear attributes outside the bundle.
      const digest = await treeDigest(app);
      // This is the only quarantine removal, scoped to the authenticated extracted bundle.
      await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]);
      // Probe actual staged-bundle rename, never move the live application for preflight.
      const probe = join(root, "rename-probe.app");
      await fs.rename(app, probe); await fs.rename(probe, app);
      this.staged = { app, zip, manifest, digest, pending: { root, token: randomUUID(), target: this.options.appPath, version: manifest.version, executable } };
    } catch (error) {
      if (root) await removeTree(root);
      throw error;
    } finally { this.busy = false; }
  }
  /** Called ONLY by the explicit Restart to update IPC. No quit hook auto-installs. */
  async restart(parentPid: number): Promise<void> {
    if (this.busy) throw new Error("An update is already being prepared");
    this.busy = true;
    try {
    if (!this.staged) throw new Error("Download and verify the update first");
    writableApp(this.options.appPath);
    newer(this.staged.manifest.version, this.options.current);
    await verifyArchive(this.staged.zip, this.staged.manifest);
    if (await treeDigest(this.staged.app) !== this.staged.digest) throw new Error("Verified staged app changed; download again");
    const installedVersion = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(this.options.appPath, "Contents", "Info.plist")], { encoding: "utf8" })).stdout.trim();
    newer(this.staged.manifest.version, installedVersion);
    const { pending, app } = this.staged;
    const script = join(pending.root, "swap.sh");
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
    mkdirSync(this.options.dataDir, { recursive: true });
    writeFileSync(join(this.options.dataDir, "update-pending.json"), JSON.stringify(pending), { mode: 0o600 });
    const child = spawn("/bin/sh", [script, String(parentPid), pending.target, app, join(pending.root, "previous.app"), join(pending.root, "boot.ok"), pending.token, pending.executable, "0", "0.1", this.options.dataDir, "1200", "50", ...(this.options.launchArgs ?? [])], { detached: true, stdio: "ignore" });
    // Synchronous spawn failure must not cause the running app to quit.
    if (!child.pid) throw new Error("Could not start update helper");
    child.on("error", () => {});
    child.unref();
    this.staged = null;
    } finally { this.busy = false; this.availability = null; }
  }
  async discard(): Promise<void> {
    const staged = this.staged; this.staged = null;
    if (staged) await removeTree(staged.pending.root);
  }
}

/** A receipt only after this exact signed version has a loaded window and responsive core. */
export function acknowledgeUpdateBoot(dataDir: string, target: string, version: string, argv: string[]): boolean {
  const token = argv.find((arg) => arg.startsWith("--botling-update-token="))?.split("=")[1];
  if (!token) return false;
  try {
    const pending = JSON.parse(readFileSync(join(dataDir, "update-pending.json"), "utf8")) as Pending;
    if (pending.token !== token || pending.target !== target || pending.version !== version
      || dirname(pending.root) !== dirname(target) || !basename(pending.root).startsWith(".botling-update-")) return false;
    writeFileSync(join(pending.root, "boot.ok"), token, { flag: "wx", mode: 0o600 });
    return true;
  } catch { return false; }
}

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 2) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
async function smallJSON(file: string): Promise<any> {
  if ((await fs.lstat(file)).isSymbolicLink() || (await fs.stat(file)).size > 8192) throw new Error('Invalid update metadata');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
/** Only reclaim roots owned by this app/data pair, and never while their helper is running.
 * Unknown sibling folders and live downloads are deliberately left alone. Diagnostics: last five,
 * each at most a 16 KiB tail (legacy boot.log) plus fixed metadata; failed bundles are then removed.
 */
export async function recoverUpdates(dataDir: string, target: string, collect = true): Promise<string | null> {
  const diagnostics = join(dataDir, 'update-diagnostics');
  const prior: any[] = [];
  const claims = join(dataDir, 'update-cleanup');
  const owned: any[] = [];
  for (const name of await fs.readdir(claims).catch(() => [] as string[])) {
    if (!/^\.botling-update-gc-[a-f0-9-]+\.json$/.test(name)) continue;
    try {
      const claim = {...await smallJSON(join(claims,name)), claimFile:join(claims,name)};
      if (claim.target === target && claim.dataDir === dataDir && claim.root === name.slice(0,-5)
        && !existsSync(join(dirname(target),claim.root)) && !alive(claim.collectorPid)) await fs.rm(claim.claimFile,{force:true});
      else owned.push(claim);
    } catch {}
  }
  const names = (await fs.readdir(diagnostics).catch(() => [] as string[])).filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)).sort().reverse();
  for (const name of names.slice(0, 5)) try {
    const file = join(diagnostics, name);
    if ((await fs.lstat(file)).size <= 18000) prior.push(JSON.parse(await fs.readFile(file,'utf8')));
  } catch {}
  let failure: string | null = null;
  let pending: Pending | null = null;
  try { pending = await smallJSON(join(dataDir, 'update-pending.json')); } catch {}
  for (const name of await fs.readdir(dirname(target)).catch(() => [] as string[])) {
    if (!name.startsWith('.botling-update-')) continue;
    const root = join(dirname(target), name);
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) continue;
      const owner = await smallJSON(join(root, 'owner.json')).catch(() => null);
      const claim = owned.find(log => log.root === name && log.target === target && log.dataDir === dataDir);
      const record = claim ?? prior.find(log => log.root === name && log.target === target && log.dataDir === dataDir);
      if (claim && alive(claim.collectorPid)) continue;
      const ours = owner ? owner.target === target && owner.dataDir === dataDir : !!record;
      const isPending = pending?.root === root && pending?.target === target;
      if (!ours && !isPending) continue;
      const result = (await fs.readFile(join(root, 'result'), 'utf8').catch(() => record?.result ?? '')).slice(0, 100).trim();
      if (result.startsWith('failed:')) failure = `The update did not finish (${result}). The available app was reopened.`;
      if (!collect) continue;
      const helper = await fs.readFile(join(root, 'helper.pid'), 'utf8').catch(() => record?.helper ?? '');
      const candidate = await fs.readFile(join(root, 'new.pid'), 'utf8').catch(() => '');
      if (alive(helper)) continue;
      if (result === 'booted' && alive(candidate) && !existsSync(join(root, 'activated.ok'))) continue;
      if (!result && (alive(owner?.pid) || alive(candidate))) continue;
      // Never erase the only recovery copy after a failed restore.
      if (result === 'failed:15' || result === 'failed:16') continue;
      let tail = '';
      try {
        const log = await fs.open(join(root, 'boot.log'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stat = await log.stat(); const bytes = Buffer.alloc(Math.min(8192, stat.size)); await log.read(bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length)); tail = bytes.toString('base64'); } finally { await log.close(); }
      } catch {}
      // Atomic claim prevents two app/test sweepers from partially deleting one another's metadata.
      const garbage = join(dirname(root), `.botling-update-gc-${randomUUID()}`);
      await fs.rename(root, garbage);
      await fs.mkdir(claims, {recursive:true});
      const claimFile = join(claims, basename(garbage) + '.json');
      const ownership = {result: result || 'orphan', failure, target, dataDir, root: basename(garbage), helper, collectorPid:process.pid};
      await fs.writeFile(claimFile, JSON.stringify(ownership), {mode:0o600,flag:'wx'});
      if (claim?.claimFile) await fs.rm(claim.claimFile,{force:true});
      await fs.mkdir(diagnostics, {recursive:true});
      const diagnostic = join(diagnostics, `${Date.now()}-${randomUUID()}.json`);
      await fs.writeFile(diagnostic, JSON.stringify({result: result || 'orphan', failure, target, dataDir, root: basename(garbage), helper, tailBase64: tail}), {mode:0o600});
      // Use the native filesystem namespace, with a bounded child lifetime. Keep the external
      // ownership record if deletion is interrupted, so the next start can finish it.
      try { await removeTree(garbage); await fs.rm(claimFile,{force:true}); }
      catch(error) {
        ownership.collectorPid=0;
        await fs.writeFile(claimFile,JSON.stringify(ownership),{mode:0o600});
        const log=JSON.parse(await fs.readFile(diagnostic,'utf8')); log.cleanupError=(error as NodeJS.ErrnoException).code;
        await fs.writeFile(diagnostic,JSON.stringify(log),{mode:0o600});
      }
      if (isPending) await fs.rm(join(dataDir, 'update-pending.json'), {force:true});
    } catch { /* A concurrent collector may already have claimed this root. */ }
  }
  const logs = (await fs.readdir(diagnostics).catch(() => [] as string[])).filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)).sort().reverse();
  for (const name of logs.slice(5)) await fs.rm(join(diagnostics,name), {force:true});
  if (!failure) for (const name of logs.slice(0,5)) {
    try { const record = JSON.parse(await fs.readFile(join(diagnostics,name),'utf8')); if (record.result === 'booted') break; if (record.failure) {failure=record.failure;break;} } catch {}
  }
  return failure;
}
