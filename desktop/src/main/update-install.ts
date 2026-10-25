// Ed25519 authenticates the ZIP before extraction, quarantine removal, or app replacement.
// The shell helper needs no Node runtime (packaged Electron has RunAsNode disabled).
import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { compareVersions, parseVersion, RELEASE_PAGE } from "./updates";
import { trustKey, verifyManifest, type Manifest } from "../../scripts/release-manifest.mjs";
import type { ReleaseView } from "../contract";

export interface InstallOptions {
  current: string; appPath: string; dataDir: string; publicKey: string | null;
  platform: string; arch: string;
  fetch: (url: string) => Promise<Response>;
  /** Only dependency injection for tests, never a packaged environment knob. */
  assetURL?: (release: ReleaseView) => string;
}
interface Pending { token: string; root: string; target: string; version: string; executable: string }
const MOVE_GUIDE = "Move Botling 2.app to Applications and open it there before updating (read-only or App Translocation copies cannot update).";

export function writableApp(target: string): void {
  if (!target.endsWith(".app") || target.includes("/AppTranslocation/") || !existsSync(target)) throw new Error(MOVE_GUIDE);
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

export function verifyArchive(zip: string, manifest: Manifest): void {
  const bytes = readFileSync(zip);
  if (bytes.length !== manifest.size) throw new Error("Update size mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("Update SHA-256 mismatch");
}

// Detect accidental or local modifications of the extracted staging tree before restart.
// Symlink targets and executable modes are part of the digest; attributes such as quarantine are not.
function treeDigest(folder: string): string {
  if (!lstatSync(folder).isDirectory()) throw new Error("Staged bundle must be a directory");
  const hash = createHash("sha256");
  function visit(path: string, relative: string) {
    const stat = lstatSync(path);
    hash.update(JSON.stringify([relative, stat.mode & 0o777, stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file"]));
    if (stat.isSymbolicLink()) {
      const resolved = realpathSync(path);
      if (resolved !== folder && !resolved.startsWith(folder + sep)) throw new Error("Staged symlink escapes verified app");
      hash.update(readlinkSync(path));
    }
    else if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) visit(join(path, entry), `${relative}/${entry}`);
    else if (stat.isFile()) hash.update(readFileSync(path));
    else throw new Error("Unsupported staged file type");
  }
  visit(folder, ""); return hash.digest("hex");
}

function newer(version: string, current: string): void {
  const a = parseVersion(version), b = parseVersion(current);
  if (!a || !b || a.major !== 2 || compareVersions(a, b) <= 0) throw new Error("Update would downgrade or reinstall this version");
}

/** Bounded transaction: wait for old PID, swap siblings, retain previous until boot receipt.
 * Every mutation is quoted positional data, never evaluated shell text. A failed boot is killed
 * before the previous bundle is restored; the failed bundle/log is retained for diagnosis.
 */
export const SWAP_SCRIPT = `#!/bin/sh
set -eu
parent="$1"; target="$2"; staged="$3"; previous="$4"; receipt="$5"; token="$6"; executable="$7"; attempts="$8"; delay="$9"
root="\${staged%/*}"
# Do not swap if the old app is still shutting down after two minutes.
n=0
while kill -0 "$parent" 2>/dev/null; do
  n=$((n+1)); [ "$n" -lt 1200 ] || exit 10
  /bin/sleep 0.1
done
[ ! -e "$previous" ] || exit 11
/bin/mv "$target" "$previous"
if ! /bin/mv "$staged" "$target"; then /bin/mv "$previous" "$target"; exit 12; fi
new_pid=''
rollback() {
  trap - EXIT HUP INT TERM
  if [ -n "$new_pid" ]; then kill -TERM "$new_pid" 2>/dev/null || true; /bin/sleep 0.2; kill -KILL "$new_pid" 2>/dev/null || true; wait "$new_pid" 2>/dev/null || true; fi
  /bin/mv "$target" "$root/failed.app"
  /bin/mv "$previous" "$target"
  printf 'rolled-back\\n' > "$root/result"
  # LaunchServices owns the restored app; the helper itself always exits.
  /usr/bin/open -n "$target" >/dev/null 2>&1 || true
  exit 13
}
trap rollback EXIT HUP INT TERM
"$target/Contents/MacOS/$executable" "--botling-update-token=$token" > "$root/boot.log" 2>&1 &
new_pid=$!
n=0
while [ "$n" -lt "$attempts" ]; do
  if [ -f "$receipt" ] && [ "$(/bin/cat "$receipt")" = "$token" ] && kill -0 "$new_pid" 2>/dev/null; then
    trap - EXIT HUP INT TERM
    /bin/rm -rf "$previous"
    /bin/rm -f "$root/download.zip"
    printf 'booted\\n' > "$root/result"
    exit 0
  fi
  kill -0 "$new_pid" 2>/dev/null || exit 13
  n=$((n+1)); /bin/sleep "$delay"
done
exit 13
`;

export class VerifiedInstaller {
  private staged: { pending: Pending; manifest: Manifest; zip: string; app: string; digest: string } | null = null;
  private busy = false;
  constructor(private readonly options: InstallOptions) {}
  unavailable(): string | null {
    try {
      trustKey(this.options.publicKey);
      if (this.options.platform !== "darwin") throw new Error("Self-update is currently available on macOS only. Open the release page to download.");
      writableApp(this.options.appPath);
      return null;
    } catch (error) { return (error as Error).message; }
  }
  get ready(): string | null { return this.staged?.manifest.version ?? null; }
  async stage(release: ReleaseView): Promise<void> {
    if (this.busy) throw new Error("An update is already being prepared");
    const unavailable = this.unavailable();
    if (unavailable) throw new Error(unavailable);
    newer(release.version, this.options.current);
    if (!release.asset || !new RegExp(`^Botling-2-.+-mac-${this.options.arch}\\.zip$`).test(release.asset)) throw new Error("No compatible macOS ZIP in this release");
    if (!release.url.startsWith(`${RELEASE_PAGE}tag/v${release.version}`) || new URL(release.url).pathname !== `/william1010121/Botling/releases/tag/v${release.version}`) throw new Error("Invalid release URL");
    this.busy = true;
    let root: string | undefined;
    try {
      this.discard();
      const url = this.options.assetURL?.(release) ?? `${RELEASE_PAGE}download/v${encodeURIComponent(release.version)}/${encodeURIComponent(release.asset)}`;
      const manifest = verifyManifest(JSON.parse((await readBounded(await this.options.fetch(`${url}.manifest.json`), 16_384)).toString("utf8")), this.options.publicKey);
      if (manifest.version !== release.version) throw new Error("Signed version does not match release");
      newer(manifest.version, this.options.current);
      root = mkdtempSync(join(dirname(this.options.appPath), ".botling-update-"));
      chmodSync(root, 0o700);
      const zip = join(root, "download.zip");
      await readBounded(await this.options.fetch(url), manifest.size, zip);
      verifyArchive(zip, manifest);
      const entries = execFileSync("/usr/bin/unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n");
      if (entries.some((entry) => !entry.startsWith("Botling 2.app/") || entry.split("/").some((part) => part === "..") || entry.includes("\\") || entry.includes("\r"))) throw new Error("Unsafe update archive paths");
      execFileSync("/usr/bin/ditto", ["-x", "-k", zip, root]);
      const app = join(root, "Botling 2.app");
      const plist = join(app, "Contents", "Info.plist");
      const value = (key: string) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim();
      if (value("CFBundleIdentifier") !== "io.github.william1010121.Botling2" || value("CFBundleShortVersionString") !== manifest.version) throw new Error("Update bundle identity or version mismatch");
      const executable = value("CFBundleExecutable");
      if (!/^[A-Za-z0-9 ._-]+$/.test(executable) || !existsSync(join(app, "Contents", "MacOS", executable))) throw new Error("Invalid update executable");
      // Validate symlinks before xattr so even a signed archive cannot clear attributes outside the bundle.
      const digest = treeDigest(app);
      // This is the only quarantine removal, scoped to the authenticated extracted bundle.
      execFileSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]);
      this.staged = { app, zip, manifest, digest, pending: { root, token: randomUUID(), target: this.options.appPath, version: manifest.version, executable } };
    } catch (error) {
      if (root) rmSync(root, { recursive: true, force: true });
      throw error;
    } finally { this.busy = false; }
  }
  /** Called ONLY by the explicit Restart to update IPC. No quit hook auto-installs. */
  restart(parentPid: number): void {
    if (!this.staged) throw new Error("Download and verify the update first");
    writableApp(this.options.appPath);
    newer(this.staged.manifest.version, this.options.current);
    verifyArchive(this.staged.zip, this.staged.manifest);
    if (treeDigest(this.staged.app) !== this.staged.digest) throw new Error("Verified staged app changed; download again");
    const installedVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(this.options.appPath, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
    newer(this.staged.manifest.version, installedVersion);
    const { pending, app } = this.staged;
    const script = join(pending.root, "swap.sh");
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
    mkdirSync(this.options.dataDir, { recursive: true });
    writeFileSync(join(this.options.dataDir, "update-pending.json"), JSON.stringify(pending), { mode: 0o600 });
    const child = spawn("/bin/sh", [script, String(parentPid), pending.target, app, join(pending.root, "previous.app"), join(pending.root, "boot.ok"), pending.token, pending.executable, "300", "0.1"], { detached: true, stdio: "ignore" });
    // Synchronous spawn failure must not cause the running app to quit.
    if (!child.pid) throw new Error("Could not start update helper");
    child.on("error", () => {});
    child.unref();
    this.staged = null;
  }
  discard(): void {
    if (this.staged) rmSync(this.staged.pending.root, { recursive: true, force: true });
    this.staged = null;
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
