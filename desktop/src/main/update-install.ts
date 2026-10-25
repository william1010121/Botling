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
import {readSmallJSON,validRoot,processAlive,issueFor,recordIssue,visibleRecovery,writeRecord,recoveryAccepted,recoveryCode,UPDATE_RECORDS} from "./update-state";
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
restore="$data.update-restore-$token"; after="$data.update-after-$token"
result() { printf '%s\n' "$1" > "$root/result.tmp" && /bin/mv "$root/result.tmp" "$root/result"; }
decide() {
  printf '%s:%s\n' "$1" "$token" > "$root/decision.$$" || return 1
  /bin/ln "$root/decision.$$" "$root/decision" 2>/dev/null || true
  /bin/rm -f "$root/decision.$$" || true
  [ -f "$root/decision" ] && [ "$(/bin/cat "$root/decision")" = "$1:$token" ]
}
space_for() {
  need=$(/usr/bin/du -sk "$1" 2>/dev/null | /usr/bin/awk '{print $1}') || return 1
  free=$(/bin/df -Pk "$2" 2>/dev/null | /usr/bin/awk 'NR==2 {print $4}') || return 1
  case "$need:$free" in *[!0-9:]*|:*|*:) return 1;; esac
  [ "$free" -gt "$((need + 65536))" ]
}
copy_one() { space_for "$1" "$root" && /usr/bin/ditto "$1" "$2"; }
copy_profile() {
  local entry name profile
  /bin/mkdir -p "$2" || return 1
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="\${entry##*/}"
    case "$name" in Cache|'Code Cache'|GPUCache|ShaderCache|GrShaderCache|DawnGraphiteCache|DawnWebGPUCache|SingletonLock|SingletonSocket|SingletonCookie) continue;; esac
    if [ "$name" = Partitions ] && [ "$1" = "$data/electron" ]; then
      /bin/mkdir -p "$2/Partitions" || return 1
      for profile in "$entry"/* "$entry"/.[!.]* "$entry"/..?*; do
        [ -e "$profile" ] || [ -L "$profile" ] || continue
        if [ -d "$profile" ] && [ ! -L "$profile" ]; then copy_profile "$profile" "$2/Partitions/\${profile##*/}" || return 1
        else copy_one "$profile" "$2/Partitions/\${profile##*/}" || return 1; fi
      done
    else copy_one "$entry" "$2/$name" || return 1; fi
  done
}
snapshot_data() {
  local entry name
  /bin/mkdir -p "$root/data-before" || return 1
  for entry in "$data"/* "$data"/.[!.]* "$data"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="\${entry##*/}"
    case "$name" in update-pending.json|update-recovery.json|update-dismissed.json|update-recovered.json|update-last-boot.json|update-orphan-commit.json|update-cleanup|update-diagnostics) continue;; esac
    if [ "$name" = electron ] && [ -d "$entry" ] && [ ! -L "$entry" ]; then copy_profile "$entry" "$root/data-before/electron" || return 1
    else copy_one "$entry" "$root/data-before/$name" || return 1; fi
  done
  printf complete > "$root/snapshot.complete" || return 1
}
reopen() {
  # Only variables actually present in the launch environment are forwarded.
  [ "\${HOME+x}" != x ] || set -- --env "HOME=$HOME" "$@"
  [ "\${TMPDIR+x}" != x ] || set -- --env "TMPDIR=$TMPDIR" "$@"
  [ "\${BOTLING_IMPORT_FROM+x}" != x ] || set -- --env "BOTLING_IMPORT_FROM=$BOTLING_IMPORT_FROM" "$@"
  [ "\${BOTLING_1X_DIR+x}" != x ] || set -- --env "BOTLING_1X_DIR=$BOTLING_1X_DIR" "$@"
  [ "\${CODEX_HOME+x}" != x ] || set -- --env "CODEX_HOME=$CODEX_HOME" "$@"
  [ "\${CLAUDE_CONFIG_DIR+x}" != x ] || set -- --env "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" "$@"
  /usr/bin/open -n "$available" --env "BOTLING_DATA_DIR=$data" "$@" >/dev/null 2>&1
}
finish() {
  code=$?
  trap - EXIT
  trap '' HUP INT TERM
  [ "$code" -ne 0 ] || exit 0
  if [ -f "$root/decision" ] && [ "$(/bin/cat "$root/decision")" = "commit:$token" ]; then result booted || true; exit 0; fi
  # A never-completed snapshot cannot be a recovery copy. Free its bytes before any journal
  # allocation: ENOSPC must not prevent the record that lets startup reclaim the transaction.
  if [ "$code" -eq 18 ] && [ "$moved" -eq 0 ] && [ "$snapshot" -eq 0 ]; then
    /bin/rm -rf "$root/data-before" "$root/download.zip" "$staged" || { printf 'incomplete snapshot cleanup failed\n' > "$root/cleanup-error" || true; }
  fi
  decide rollback || { result failed:22 || true; exit 22; }
  if [ -n "$new_pid" ]; then
    kill -TERM "$new_pid" 2>/dev/null || true
    n=0
    while kill -0 "$new_pid" 2>/dev/null && [ "$n" -lt "$grace" ]; do n=$((n+1)); /bin/sleep 0.1 || true; done
    kill -KILL "$new_pid" 2>/dev/null || true
    wait "$new_pid" 2>/dev/null || true
  fi
  available="$target"
  if [ "$moved" -eq 1 ] && [ -d "$previous" ]; then
    if [ -e "$target" ]; then /bin/mv "$target" "$root/failed.app" || code=15; fi
    if [ ! -e "$target" ]; then /bin/mv "$previous" "$target" || code=15; fi
    if [ -d "$previous" ]; then available="$previous"; code=15; fi
  fi
  # Prepare a complete sibling before any live data rename. Every failure remains fail-closed.
  if [ "$snapshot" -eq 1 ] && [ -n "$new_pid" ]; then
    if [ -e "$restore" ] || [ -e "$after" ]; then code=19
    elif ! space_for "$root/data-before" "\${data%/*}"; then code=19
    elif ! /usr/bin/ditto "$root/data-before" "$restore"; then
      /bin/rm -rf "$restore" || { printf 'partial restore cleanup failed\n' > "$root/cleanup-error" || true; }
      code=19
    elif ! /bin/rm -rf "$restore/update-pending.json" "$restore/update-recovery.json" "$restore/update-dismissed.json" "$restore/update-recovered.json" "$restore/update-last-boot.json" "$restore/update-orphan-commit.json" "$restore/update-cleanup" "$restore/update-diagnostics"; then code=19
    elif [ -e "$data" ] && ! /bin/mv "$data" "$after"; then code=20
    elif ! /bin/mv "$restore" "$data"; then
      if [ -e "$after" ]; then /bin/mv "$after" "$data" || true; fi
      code=21
    else printf restored > "$root/data-restored" || true; fi
  fi
  result "failed:$code" || true
  case "$code" in 19|20|21|22) exit "$code";; esac
  if [ "$code" -eq 10 ]; then while kill -0 "$parent" 2>/dev/null; do /bin/sleep 0.1 || true; done; fi
  if ! kill -0 "$parent" 2>/dev/null && [ -d "$available" ]; then reopen --args "$@" || true; fi
  exit "$code"
}
trap 'finish "$@"' EXIT
trap 'exit 17' HUP INT TERM
printf '%s' "$$" > "$root/helper.pid" || exit 18
# Complete path metadata is written before a snapshot or restore can be attempted.
/usr/bin/plutil -create xml1 "$root/recovery.plist" || exit 18
for key in dataDir before restore after token; do
  case "$key" in dataDir) value="$data";; before) value="$root/data-before";; restore) value="$restore";; after) value="$after";; token) value="$token";; esac
  /usr/bin/plutil -insert "$key" -string "$value" "$root/recovery.plist" || exit 18
done
/usr/bin/plutil -convert json -o "$root/recovery.json" "$root/recovery.plist" || exit 18
/bin/rm -f "$root/recovery.plist" || exit 18
n=0
while kill -0 "$parent" 2>/dev/null; do n=$((n+1)); [ "$n" -lt "$parent_attempts" ] || exit 10; /bin/sleep 0.1; done
[ ! -e "$previous" ] || exit 11
if [ -n "$data" ] && [ -d "$data" ]; then snapshot_data || exit 18; snapshot=1; fi
/bin/mv "$target" "$previous" || exit 14
moved=1
/bin/mv "$staged" "$target" || exit 12
"$target/Contents/MacOS/$executable" "--botling-update-token=$token" "--botling-update-data=$data" "$@" >/dev/null 2>&1 &
new_pid=$!
printf '%s' "$new_pid" > "$root/new.pid" || exit 13
while :; do
  if [ -f "$receipt" ] && [ "$(/bin/cat "$receipt")" = "$token" ] && kill -0 "$new_pid" 2>/dev/null; then
    # Commit marker precedes starting external work. After this, rollback is forbidden.
    decide commit || exit 22
    result booted || exit 22
    trap - EXIT HUP INT TERM
    /bin/rm -rf "$previous" "$root/data-before" "$root/download.zip" &
    cleanup_pid=$!
    printf '%s' "$cleanup_pid" > "$root/cleanup.pid" || true
    wait "$cleanup_pid" || true
    exit 0
  fi
  kill -0 "$new_pid" 2>/dev/null || exit 13
  /bin/sleep "$delay"
done
`;

const RESERVE_BYTES=64*1024*1024,MAX_EXPANDED_BYTES=2*1024*1024*1024;
const PROFILE_CACHE=new Set(['Cache','Code Cache','GPUCache','ShaderCache','GrShaderCache','DawnGraphiteCache','DawnWebGPUCache','SingletonLock','SingletonSocket','SingletonCookie']);
/** Mirror the helper's exclusions only at Chromium profile roots. Core stores are never filtered. */
async function persistentBytes(path:string,profile=false,partitions=false):Promise<number>{
 const stat=await fs.lstat(path).catch(()=>null);if(!stat)return 0;if(!stat.isDirectory())return stat.size;
 let bytes=0;
 for(const entry of await fs.readdir(path)){
  if(profile&&PROFILE_CACHE.has(entry))continue;
  const next=join(path,entry);
  if(profile&&entry==='Partitions')bytes+=await persistentBytes(next,false,true);
  else bytes+=await persistentBytes(next,partitions);
 }
 return bytes;
}
async function dataBytes(dataDir:string):Promise<number>{
 let bytes=0;for(const entry of await fs.readdir(dataDir).catch(()=>[] as string[])){if(UPDATE_RECORDS.includes(entry))continue;bytes+=await persistentBytes(join(dataDir,entry),entry==='electron');}return bytes;
}
async function requireSpace(path:string,bytes:number):Promise<void>{
 const stat=await fs.statfs(path);if(stat.bavail*stat.bsize<bytes+RESERVE_BYTES)throw new Error('Insufficient free space for a bounded update and complete data snapshot');
}

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
      await requireSpace(dirname(this.options.appPath),manifest.size);
      const token=randomUUID();
      root = mkdtempSync(join(dirname(this.options.appPath), ".botling-update-"));
      chmodSync(root, 0o700);
      writeFileSync(join(root, "owner.json"), JSON.stringify({ pid: process.pid, target: this.options.appPath, dataDir: this.options.dataDir, token }), { mode: 0o600 });
      const zip = join(root, "download.zip");
      await readBounded(await this.options.fetch(url), manifest.size, zip);
      await verifyArchive(zip, manifest);
      const entries = (await run("/usr/bin/unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split("\n");
      if (entries.some((entry) => !entry.startsWith("Botling 2.app/") || entry.split("/").some((part) => part === "..") || entry.includes("\\") || entry.includes("\r"))) throw new Error("Unsafe update archive paths");
      const summary=(await run("/usr/bin/unzip",["-Z","-t",zip],{encoding:"utf8",maxBuffer:16384})).stdout;
      const expanded=Number(/(\d+) bytes uncompressed/.exec(summary)?.[1]);
      if(!Number.isSafeInteger(expanded)||expanded<1||expanded>MAX_EXPANDED_BYTES)throw new Error("Update archive exceeds the 2 GiB expanded-size limit");
      const snapshot=await dataBytes(this.options.dataDir);
      await requireSpace(root,expanded+snapshot*2);
      await fs.mkdir(this.options.dataDir,{recursive:true});await requireSpace(this.options.dataDir,snapshot);
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
      this.staged = { app, zip, manifest, digest, pending: { root, token, target: this.options.appPath, version: manifest.version, executable } };
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
    const snapshot=await dataBytes(this.options.dataDir);await requireSpace(pending.root,snapshot*2);await requireSpace(this.options.dataDir,snapshot);
    const script = join(pending.root, "swap.sh");
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
    mkdirSync(this.options.dataDir, { recursive: true });
    writeFileSync(join(this.options.dataDir, "update-pending.json"), JSON.stringify(pending), { mode: 0o600 });
    let child:ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", [script, String(parentPid), pending.target, app, join(pending.root, "previous.app"), join(pending.root, "boot.ok"), pending.token, pending.executable, "0", "0.1", this.options.dataDir, "1200", "50", ...(this.options.launchArgs ?? [])], { detached: true, stdio: "ignore" });
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
      if(!child.pid)throw new Error("Could not start update helper");
    }catch(error){
      const file=join(this.options.dataDir,"update-pending.json");
      try{if(readSmallJSON(file).token===pending.token)await fs.rm(file,{force:true});}catch{}
      throw new Error("Could not start update helper",{cause:error});
    }
    child.on('error',()=>{});
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
    if (existsSync(join(pending.root,"boot.ok"))) return readFileSync(join(pending.root,"boot.ok"),"utf8") === token;
    writeFileSync(join(pending.root, "boot.ok"), token, { flag: "wx", mode: 0o600 });
    return true;
  } catch { return false; }
}

// All callers join one collection in-process. Cross-process leases are published before a root
// is renamed, and callers await their owner's completion rather than treating a live lease as done.
const collections = new Map<string, Promise<string | null>>();
async function smallJSON(file:string):Promise<any>{return readSmallJSON(file);}
const readText = (file:string) => fs.readFile(file,'utf8').then(s=>s.trim()).catch(()=>'');
async function waitForOwner(pid:unknown,what:string):Promise<void>{
 const end=Date.now()+130_000;
 while(processAlive(pid)){if(Date.now()>end)throw new Error(`Update cleanup still active: ${what} (pid ${pid})`);await new Promise(r=>setTimeout(r,50));}
}
async function sweepUpdates(dataDir:string,target:string,collect:boolean):Promise<string|null>{
 const claims=join(dataDir,'update-cleanup'),diagnostics=join(dataDir,'update-diagnostics');
 const pendingFile=join(dataDir,'update-pending.json');let pending:Pending|null=null;
 try{pending=await smallJSON(pendingFile);}catch{}
 const clearPending=async(root:string)=>{try{if((await smallJSON(pendingFile)).root===root)await fs.rm(pendingFile,{force:true});}catch{}};
 if(pending&&pending.target!==target&&validRoot(pending.root,pending.target)){
  let owner;try{owner=await smallJSON(join(pending.root,'owner.json'));}catch{}
  if(owner?.target===pending.target&&owner.dataDir===dataDir){await sweepUpdates(dataDir,pending.target,collect);try{pending=await smallJSON(pendingFile);}catch{pending=null;}}
 }
 let pendingCollection=false;
 if(pending&&!existsSync(pending.root)){
  for(const name of await fs.readdir(claims).catch(()=>[] as string[])){
   if(!/^\.botling-update-gc-[a-z0-9-]+\.json$/.test(name))continue;
   let claim;try{claim=await smallJSON(join(claims,name));}catch{continue;}
   if(claim.target===pending.target&&claim.dataDir===dataDir&&(claim.source===basename(pending.root)||(!claim.source&&processAlive(claim.collectorPid))))pendingCollection=true;
  }
 }
 if(pending&&!existsSync(pending.root)&&!pendingCollection){
  await recordIssue(issueFor(dataDir,target,pending.root,24,pending.token));
  if(collect)await clearPending(pending.root);
 }
 const validClaim=(c:any)=>c.dataDir===dataDir&&c.target===target&&/^\.botling-update-gc-[a-z0-9-]+$/.test(c.root)&&(!c.source||/^\.botling-update-[a-zA-Z0-9-]+$/.test(c.source));
 async function collectClaim(c:any,file:string):Promise<void>{
  if(!collect)return;
  if(c.collectorPid!==process.pid&&processAlive(c.collectorPid)){
   // The foreign owner can delete its lease before exiting; synchronize on that durable completion.
   const end=Date.now()+130_000;
   while(existsSync(file)&&processAlive(c.collectorPid)){if(Date.now()>end)throw new Error(`Update collector did not complete: ${file}`);await new Promise(r=>setTimeout(r,50));}
   if(!existsSync(file))return;
   c=await smallJSON(file);if(!validClaim(c))return;
  }
  await waitForOwner(c.helper,'helper finalization');await waitForOwner(c.cleanupPid,'helper native deletion');
  c.collectorPid=process.pid;await writeRecord(file,c);
  const source=join(dirname(target),c.source||c.root),garbage=join(dirname(target),c.root);
  if(source!==garbage&&existsSync(source)&&!existsSync(garbage))await fs.rename(source,garbage);
  await fs.mkdir(diagnostics,{recursive:true});
  const diagnostic=typeof c.diagnostic==='string'&&dirname(c.diagnostic)===diagnostics?c.diagnostic:join(diagnostics,`${Date.now()}-${randomUUID()}.json`);
  c.diagnostic=diagnostic;await writeRecord(file,c);
  const report={...c,phase:'deleting',startedAt:Date.now(),completedAt:0,nativePid:0,cleanupError:null as string|null};
  try{
   for(const path of [garbage,...(c.cleanupPaths??[]).filter((path:unknown)=>typeof c.token==='string'&&/^[a-zA-Z0-9-]+$/.test(c.token)&&(path===`${dataDir}.update-after-${c.token}`||path===`${dataDir}.update-restore-${c.token}`))]){
    // Native ASAR-unaware removal, exactly one attempt; its exit is the completion barrier.
    await new Promise<void>((resolve,reject)=>{const child=execFile('/bin/rm',['-rf',path],{timeout:120_000},error=>error?reject(error):resolve());report.nativePid=child.pid??0;});
   }
   report.phase='complete';report.completedAt=Date.now();await writeRecord(diagnostic,report);
   if(c.source)await clearPending(join(dirname(target),c.source));
   await fs.rm(file,{force:true});
  }catch(error){
   report.phase='failed';report.cleanupError=String(error).slice(0,500);await writeRecord(diagnostic,report);
   c.collectorPid=0;await writeRecord(file,c);throw error;
  }
 }
 // Resume interrupted removals and join existing collectors even when their root is already gone.
 for(const name of await fs.readdir(claims).catch(()=>[] as string[])){
  if(!/^\.botling-update-gc-[a-z0-9-]+\.json$/.test(name))continue;
  const file=join(claims,name);let c;try{c=await smallJSON(file);}catch{continue;}
  if(validClaim(c))await collectClaim(c,file);
 }
 if(collect&&pendingCollection&&pending&&!existsSync(pending.root))await clearPending(pending.root);
 for(const name of await fs.readdir(dirname(target)).catch(()=>[] as string[])){
  if(!name.startsWith('.botling-update-')||name.startsWith('.botling-update-gc-'))continue;
  const root=join(dirname(target),name);if(!validRoot(root,target))continue;
  let owner:any=null;try{owner=await smallJSON(join(root,'owner.json'));}catch{}
  const isPending=pending?.root===root&&(pending.target===target||owner?.target===pending.target);
  if(!(owner?.target===target&&owner.dataDir===dataDir)&&!isPending)continue;
  let result=await readText(join(root,'result'));const helper=await readText(join(root,'helper.pid')),candidate=await readText(join(root,'new.pid'));
  if(!result&&(await readText(join(root,'decision'))).startsWith('rollback:')&&!processAlive(helper))result='failed:22';
  const token=isPending?pending!.token:owner?.token;
  const code=recoveryCode(dataDir,target,root,Number(/^failed:(\d+)$/.exec(result)?.[1]),token);
  const accepted=code&&recoveryAccepted(issueFor(dataDir,target,root,code,token));
  if(code){const at=(await fs.stat(join(root,'result')).catch(()=>null))?.mtimeMs??Date.now();await recordIssue(issueFor(dataDir,target,root,code,token,at));}
  if(!collect||([15,16,19,20,21,22,25,26].includes(code)&&!accepted))continue;
  if(processAlive(helper)){if(!result)continue;await waitForOwner(helper,'helper final result');}
  if(result==='booted'&&processAlive(candidate)&&!existsSync(join(root,'activated.ok')))continue;
  if(!result&&(processAlive(owner?.pid)||processAlive(candidate)))continue;
  const cleanupPaths:string[]=[];
  try{
   const metadata=await smallJSON(join(root,'recovery.json'));
   if(metadata.dataDir===dataDir&&metadata.token===token&&/^[a-zA-Z0-9-]+$/.test(token??'')&&(accepted||result==='booted'||existsSync(join(root,'data-restored')))){
    for(const kind of ['after','restore']){const expected=`${dataDir}.update-${kind}-${token}`;if(metadata[kind]===expected)cleanupPaths.push(expected);}
   }
  }catch{}
  let tail='';try{const f=await fs.open(join(root,'boot.log'),constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await f.stat(),bytes=Buffer.alloc(Math.min(8192,stat.size));await f.read(bytes,0,bytes.length,Math.max(0,stat.size-bytes.length));tail=bytes.toString('base64');}finally{await f.close();}}catch{}
  const garbageName='.botling-update-gc-'+createHash('sha256').update(root).digest('hex').slice(0,32),file=join(claims,garbageName+'.json');
  const claim={root:garbageName,source:name,target,dataDir,result:result||'orphan',helper,cleanupPid:Number(await readText(join(root,'cleanup.pid'))),collectorPid:process.pid,token,cleanupPaths,tailBase64:tail,failure:code?issueFor(dataDir,target,root,code,token).message:null};
  await fs.mkdir(claims,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';let won=false;
  try{await fs.writeFile(temp,JSON.stringify(claim),{flag:'wx',mode:0o600});try{await fs.link(temp,file);won=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}finally{await fs.rm(temp,{force:true});}
  await collectClaim(won?claim:await smallJSON(file),file);
 }
 const logs=(await fs.readdir(diagnostics).catch(()=>[] as string[])).filter(n=>/^\d+-[a-f0-9-]+\.json$/.test(n)).sort().reverse();
 for(const name of logs.slice(5))await fs.rm(join(diagnostics,name),{force:true});
 return visibleRecovery(dataDir).recoveryError;
}
export function recoverUpdates(dataDir:string,target:string,collect=true):Promise<string|null>{
 if(!collect)return sweepUpdates(dataDir,target,false);
 const key=dataDir+'\0'+target,previous=collections.get(key);if(previous)return previous;
 const work=sweepUpdates(dataDir,target,true).finally(()=>{collections.delete(key);});collections.set(key,work);return work;
}
