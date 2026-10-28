// Signed developer hot installs. The complete candidate bundle is authenticated from its ZIP,
// compared against the running kernel/storage epoch, then atomically exchanged on disk with a
// durable rollback journal. Core/renderer parts run from immutable copies; mobile snapshots are
// generation-bound and fenced until runtime activation commits. Main supplies real process/UI ports.
// The first installation of this infrastructure changes main and therefore requires restart.
import { parseStorageContract, storageCompatible, STORAGE_RESTART_REASON, type StorageContract } from "../storage-contract";
import { visitMobile, exactTree, bundleVersion, requireNewer, type AuthenticatedBuild } from "./hot-auth";
import { HotTransaction } from "./hot-transaction";
import type * as NodeFs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { CHAT_FILES } from "./renderer-loading";
import { HOT_PARTS, PART_NAMES, type HotPart, type HotReport, type InstallPlan } from "../hot-install-plan";
import type { SwapOutcome } from "./core-swap";

/** node:fs, or Electron's original-fs (reads app.asar as the plain file it is, past Electron's archive cache). */
export type Fs = typeof NodeFs;

// ------------------------------------------------------------------------------------------------
// The app's files: Resources/app.asar (read directly) or Resources/app/

interface AsarEntry { size: number; offset: number; unpacked: boolean }
export interface AppSource {
  /** App-relative paths ("out/core/main.cjs", "package.json"). Links are listed with `link`. */
  files: Map<string, { size: number; link?: string }>;
  read(path: string): Promise<Buffer>;
}

const MAX_HEADER = 64 * 1024 * 1024;

async function readAsar(file: string, fs: Fs): Promise<AppSource> {
  const handle = await fs.promises.open(file, "r");
  let header: { files?: Record<string, unknown> };
  let base: number;
  try {
    const sizes = Buffer.alloc(8);
    await handle.read(sizes, 0, 8, 0);
    const pickle = sizes.readUInt32LE(4);
    if (sizes.readUInt32LE(0) !== 4 || pickle < 8 || pickle > MAX_HEADER) throw new Error("not an asar archive");
    const raw = Buffer.alloc(pickle);
    await handle.read(raw, 0, pickle, 8);
    const length = raw.readUInt32LE(4);
    if (length > pickle - 8) throw new Error("not an asar archive");
    header = JSON.parse(raw.subarray(8, 8 + length).toString("utf8"));
    base = 8 + pickle;
  } finally { await handle.close(); }
  const entries = new Map<string, AsarEntry>();
  const files = new Map<string, { size: number; link?: string }>();
  const visit = (node: Record<string, unknown>, prefix: string) => {
    for (const [name, value] of Object.entries(node)) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error(`unsafe name in app.asar: ${name}`);
      const item = value as { files?: Record<string, unknown>; size?: unknown; offset?: unknown; unpacked?: unknown; link?: unknown };
      const path = prefix ? `${prefix}/${name}` : name;
      if (item.files) visit(item.files, path);
      else if (typeof item.link === "string") files.set(path, { size: 0, link: item.link });
      else {
        const size = Number(item.size), offset = Number(item.offset ?? 0);
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error(`bad entry in app.asar: ${path}`);
        entries.set(path, { size, offset, unpacked: item.unpacked === true });
        files.set(path, { size });
      }
    }
  };
  visit(header.files ?? {}, "");
  return {
    files,
    read: async (path) => {
      const entry = entries.get(path);
      if (!entry) throw new Error(`${path} is not in app.asar`);
      if (entry.unpacked) return fs.promises.readFile(join(`${file}.unpacked`, ...path.split("/")));
      const handle = await fs.promises.open(file, "r");
      try {
        const bytes = Buffer.alloc(entry.size);
        const { bytesRead } = await handle.read(bytes, 0, entry.size, base + entry.offset);
        if (bytesRead !== entry.size) throw new Error(`${path} is cut short in app.asar`);
        return bytes;
      } finally { await handle.close(); }
    },
  };
}

async function readFolder(root: string, fs: Fs): Promise<AppSource> {
  const files = new Map<string, { size: number; link?: string }>();
  const visit = async (dir: string, prefix: string) => {
    for (const name of (await fs.promises.readdir(dir)).sort()) {
      const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.promises.lstat(path);
      if (stat.isSymbolicLink()) files.set(rel, { size: 0, link: await fs.promises.readlink(path) });
      else if (stat.isDirectory()) await visit(path, rel);
      else if (stat.isFile()) files.set(rel, { size: stat.size });
    }
  };
  await visit(root, "");
  return { files, read: (path) => fs.promises.readFile(join(root, ...path.split("/"))) };
}

/** The app files of a `.app` bundle. */
export async function openApp(bundle: string, fs: Fs): Promise<AppSource> {
  const resources = join(bundle, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  if (await fs.promises.stat(asar).then((stat) => stat.isFile(), () => false)) return readAsar(asar, fs);
  const folder = join(resources, "app");
  if (await fs.promises.stat(folder).then((stat) => stat.isDirectory(), () => false)) return readFolder(folder, fs);
  throw new Error(`${bundle} has no Contents/Resources/app.asar`);
}

// ------------------------------------------------------------------------------------------------
// Fingerprints

export type Place = { part: HotPart } | { kernel: string } | null;

/** Where an app file belongs (null: not shipped, ignored). */
export function classify(path: string): Place {
  if (path.endsWith(".map")) return null;
  if (path.endsWith(".node")) return { kernel: "native modules" };
  if (path === "package.json") return { kernel: "package.json" };
  if (path.startsWith("out/main/")) return { kernel: "main process" };
  if (path.startsWith("out/preload/")) return { kernel: "preloads" };
  if (path.startsWith("out/renderer/")) return { part: CHAT_FILES.test(path.slice("out/renderer".length)) ? "chat" : "shell" };
  if (/^out\/(core|host|web-extractors)\//.test(path)) return { part: "core" };
  return { kernel: "other app files" };
}

export interface BundlePrints {
  /** Known only when package metadata and staged core metadata agree. */
  storageContract?: StorageContract | null;
  /** Kernel pieces by name, each a digest. */
  kernel: Record<string, string>;
  /** Swappable parts' digests ("" when a part has no files). */
  parts: Record<HotPart, string>;
  /** Each part's files (path under out/ → sha256), for checking copies. */
  files: Record<HotPart, Record<string, string>>;
  bundleID: string;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const digest = (rows: [string, string][]) => sha(JSON.stringify(rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}

/** Info.plist keys that change with every build without changing what runs. */
const BUILD_KEYS = new Set(["CFBundleShortVersionString", "CFBundleVersion", "BotlingGitCommit", "BotlingGitDirty", "CCBGitCommit", "CCBGitDirty", "NSHumanReadableCopyright"]);

/** Info.plist's string and boolean values minus the per-build ones (ElectronAsarIntegrity follows app.asar, which is compared itself). */
export function plistValues(text: string): Record<string, string> {
  if (!text.trimStart().startsWith("<")) throw new Error("Info.plist is not XML");
  const cleaned = text.replace(/<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*(?:<key>[^<]*<\/key>\s*<dict>[\s\S]*?<\/dict>\s*)*<\/dict>/, "");
  const out: Record<string, string> = {};
  for (const match of cleaned.matchAll(/<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\s*\/>)/g)) {
    if (!BUILD_KEYS.has(match[1]!)) out[match[1]!] = match[2] ?? match[3]!;
  }
  return out;
}

async function hashFile(path: string, fs: Fs): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Everything in Contents/ outside the app's own files: Electron, the executable, Info.plist, other resources. */
async function bundleKernel(bundle: string, fs: Fs, kernel: Record<string, [string, string][]>) {
  const add = (what: string, row: [string, string]) => (kernel[what] ??= []).push(row);
  const contents = join(bundle, "Contents");
  const visit = async (dir: string, prefix: string) => {
    for (const name of (await fs.promises.readdir(dir)).sort()) {
      const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
      if (rel === "Info.plist" || rel === "_CodeSignature" || rel === "CodeResources" || rel === "embedded.provisionprofile") continue;
      if (rel === "Resources/mobile") continue;
      if (rel === "Resources/app.asar" || rel === "Resources/app.asar.unpacked" || rel === "Resources/app") continue;
      const what = rel.startsWith("Frameworks/") ? "Electron" : rel.startsWith("MacOS/") ? "executable" : "app resources";
      const stat = await fs.promises.lstat(path);
      if (stat.isSymbolicLink()) add(what, [rel, `link:${await fs.promises.readlink(path)}`]);
      else if (stat.isDirectory()) await visit(path, rel);
      else add(what, [rel, `${stat.mode & 0o777}:${await hashFile(path, fs)}`]);
    }
  };
  await visit(contents, "");
  const info = plistValues(await fs.promises.readFile(join(contents, "Info.plist"), "utf8"));
  add("Info.plist", ["Info.plist", JSON.stringify(sorted(info))]);
  return info;
}

/** A bundle's fingerprints; throws when it cannot be read completely. */
export async function bundlePrints(bundle: string, fs: Fs): Promise<BundlePrints> {
  const kernel: Record<string, [string, string][]> = {};
  const info = await bundleKernel(bundle, fs, kernel);
  const source = await openApp(bundle, fs);
  let declaredStorage: StorageContract | null = null;
  const files = { core: {}, chat: {}, shell: {}, mobile: {} } as Record<HotPart, Record<string, string>>;
  for (const [path, entry] of source.files) {
    const place = classify(path);
    if (!place) continue;
    if (entry.link !== undefined) {
      // A link inside the app's files: compared like a file, but a part with one cannot be copied out.
      if ("part" in place) throw new Error(`${path} is a link`);
      (kernel[place.kernel] ??= []).push([path, `link:${entry.link}`]);
      continue;
    }
    const bytes = await source.read(path);
    if ("part" in place) files[place.part][path.slice("out/".length)] = sha(bytes);
    else if (path === "package.json") {
      const json = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      declaredStorage = parseStorageContract(json.botlingStorageContract);
      // Retain in the kernel digest so even pre-gate planners restart on initial migration.
      delete json.version; delete json.description;
      (kernel["package.json"] ??= []).push([path, JSON.stringify(sorted(json))]);
    } else (kernel[place.kernel] ??= []).push([path, sha(bytes)]);
  }
  let coreStorage: StorageContract | null = null;
  const metadata = source.files.get("out/core/storage-contract.json");
  if (metadata && !metadata.link && metadata.size <= 4096) {
    try { coreStorage = parseStorageContract(JSON.parse((await source.read("out/core/storage-contract.json")).toString("utf8"))); } catch { /* unknown: restart */ }
  }
  const mobile = join(bundle, "Contents/Resources/mobile");
  if (fs.existsSync(mobile)) files.mobile = await visitMobile(mobile, fs);
  for (const [path, hash] of Object.entries(files.mobile)) if (path.endsWith(".node")) (kernel["native modules"] ??= []).push([`mobile/${path}`, hash]);
  return {
    storageContract: storageCompatible(declaredStorage, coreStorage) ? declaredStorage : null,
    kernel: Object.fromEntries(Object.entries(kernel).map(([what, rows]) => [what, digest(rows)])),
    parts: Object.fromEntries(HOT_PARTS.map((part) => [part, Object.keys(files[part]).length ? digest(Object.entries(files[part])) : ""])) as Record<HotPart, string>,
    files,
    bundleID: info.CFBundleIdentifier ?? "",
  };
}

export const samePrints = (a: BundlePrints, b: BundlePrints) =>
  JSON.stringify(sorted(a.kernel)) === JSON.stringify(sorted(b.kernel)) && HOT_PARTS.every((part) => a.parts[part] === b.parts[part]);

/** Hot when the kernel is the same; the parts that differ, in the order they are applied. */
export function planInstall(running: BundlePrints, incoming: BundlePrints): InstallPlan {
  const names = [...new Set([...Object.keys(running.kernel), ...Object.keys(incoming.kernel)])].sort();
  const changed = names.filter((name) => running.kernel[name] !== incoming.kernel[name]);
  if (incoming.kernel["native modules"] || running.kernel["native modules"]) if (!changed.includes("native modules")) changed.push("native modules");
  if (running.parts.mobile && !incoming.parts.mobile) return { mode: "restart", reasons: ["missing mobile resources"] };
  if (changed.length) return { mode: "restart", reasons: [`kernel changed: ${changed.join(", ")}`] };
  if (!storageCompatible(running.storageContract, incoming.storageContract)) return { mode: "restart", reasons: [STORAGE_RESTART_REASON] };
  return { mode: "hot", parts: HOT_PARTS.filter((part) => running.parts[part] !== incoming.parts[part] || (part === "core" && running.parts.mobile !== incoming.parts.mobile)) };
}

// ------------------------------------------------------------------------------------------------
// Copies and the bundle on disk

/**
 * Copies the files of `parts` out of `bundle` to `<stagingRoot>/<stamp>/` (paths as under out/), each checked
 * against `prints`; the shell and the chat page share out/renderer, so either copies both. Returns the new
 * core script and renderer folder.
 */
export async function stageParts(bundle: string, prints: BundlePrints, parts: HotPart[], stagingRoot: string, fs: Fs, stamp = `${Date.now()}`): Promise<{ dir: string; core?: string; renderer?: string }> {
  const source = await openApp(bundle, fs);
  const wanted: HotPart[] = parts.includes("chat") || parts.includes("shell") ? [...new Set<HotPart>([...parts, "chat", "shell"])] : parts;
  const dir = join(stagingRoot, stamp), partial = `${dir}.partial`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  await fs.promises.mkdir(partial, { recursive: true });
  for (const part of wanted) {
    for (const [path, expected] of Object.entries(prints.files[part])) {
      const bytes = part === "mobile" ? await fs.promises.readFile(join(bundle, "Contents/Resources/mobile", path)) : await source.read(`out/${path}`);
      if (sha(bytes) !== expected) throw new Error(`out/${path} changed since the build was compared (was it rebuilt?)`);
      const target = join(partial, ...(part === "mobile" ? ["mobile"] : []), ...path.split("/"));
      if (!resolve(target).startsWith(resolve(partial) + sep)) throw new Error(`unsafe path ${path}`);
      await fs.promises.mkdir(dirname(target), { recursive: true });
      await fs.promises.writeFile(target, bytes);
    }
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.rename(partial, dir);
  return {
    dir,
    ...(parts.includes("core") ? { core: join(dir, "core", "main.cjs") } : {}),
    ...(wanted.includes("shell") ? { renderer: join(dir, "renderer") } : {}),
  };
}

/** Removes copies under `stagingRoot` except those in use (`keep`: folders or files inside them). */
export async function pruneStaging(stagingRoot: string, keep: (string | null | undefined)[], fs: Fs) {
  const kept = new Set(keep.filter((path): path is string => !!path && path.startsWith(stagingRoot + sep)).map((path) => path.slice(stagingRoot.length + 1).split(sep)[0]));
  for (const name of await fs.promises.readdir(stagingRoot).catch(() => [] as string[])) {
    if (!kept.has(name)) await fs.promises.rm(join(stagingRoot, name), { recursive: true, force: true });
  }
}

export type Run = (file: string, args: string[]) => Promise<unknown>;

/**
 * Puts `build` at `target` the verified way: the running bundle is moved to `backup` (the running process
 * keeps its open files), the build is copied in with ditto and must have `expected`'s fingerprints. On any
 * failure the old bundle is moved back before this throws.
 */
export async function installBundle(build: string, target: string, backup: string, expected: BundlePrints, fs: Fs, run: Run): Promise<void> {
  await fs.promises.mkdir(dirname(backup), { recursive: true });
  await run("/bin/mv", [target, backup]);
  try {
    await run("/usr/bin/ditto", [build, target]);
    if (!samePrints(await bundlePrints(target, fs), expected)) throw new Error("the copy on disk differs from the build that was compared (was it rebuilt meanwhile?)");
  } catch (error) {
    await run("/bin/rm", ["-rf", target]).catch(() => {});
    await run("/bin/mv", [backup, target]);
    throw error;
  }
}

/** The previous bundle back at `target` (the new one removed). */
export async function restoreBundle(target: string, backup: string, run: Run): Promise<void> {
  if (!backup) throw new Error("there is no backup");
  await run("/bin/rm", ["-rf", target]);
  await run("/bin/mv", [backup, target]);
}

// ------------------------------------------------------------------------------------------------
// Applying

export interface ApplyPorts {
  /** Copies the parts out of the new build; the core script and renderer folder to use. */
  stage(parts: HotPart[]): Promise<{ core?: string; renderer?: string }>;
  /** Installs the new bundle on disk (or throws with the old one still there). */
  install(): Promise<void>;
  /** Puts the previous bundle back on disk. */
  restore(): Promise<void>;
  /** The running core's script now. */
  coreScript(): string;
  swapCore(script: string): Promise<SwapOutcome>;
  /** Serves the shell and chat page from `dir`; returns the folder used before. */
  useRenderer(dir: string): string;
  reloadChat(): Promise<boolean>;
  /** Reloads the shell; false when it did not come up. */
  reloadShell(): Promise<boolean>;
  log(line: string): void;
}

export type ApplyResult = Pick<HotReport, "ok" | "applied" | "error" | "disk">;

const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500);

function swapFailure(outcome: Extract<SwapOutcome, { ok: false }>): string {
  switch (outcome.stage) {
    case "self-check": return `the new core failed its self-check (${outcome.error})`;
    case "drain": return `the running core could not pause its work for the swap (${outcome.error})`;
    case "busy": return "another core swap was under way";
    case "start": return `the new core did not come up (${outcome.error})${outcome.rolledBack ? "" : "; the previous core did not come back either, restart Botling"}`;
  }
}

/** The hot path, in order: copy, install on disk, core swap, chat page reload, shell reload. Puts things back on failure. */
export async function applyHot(parts: HotPart[], ports: ApplyPorts): Promise<ApplyResult> {
  let staged: { core?: string; renderer?: string };
  try { staged = await ports.stage(parts); } catch (error) {
    return { ok: false, applied: [], error: `could not copy the new build's files: ${message(error)}`, disk: "untouched" };
  }
  try { await ports.install(); } catch (error) {
    return { ok: false, applied: [], error: `could not install it on disk: ${message(error)}`, disk: "untouched" };
  }
  const applied: HotPart[] = [];
  let previousCore: string | null = null;
  let previousRenderer: string | null = null;
  const undo = async (error: string): Promise<ApplyResult> => {
    ports.log(`hot install: ${error}; putting back what was applied (${applied.map((part) => PART_NAMES[part]).join(", ") || "nothing"})`);
    const still = [...applied];
    let disk: HotReport["disk"] = "restored";
    try { await ports.restore(); } catch (failure) { disk = "stuck"; ports.log(`hot install: restore failed: ${message(failure)}`); }
    if (disk === "stuck") return { ok: false, applied: still, error, disk };
    if (previousRenderer !== null) {
      ports.useRenderer(previousRenderer);
      for (const part of ["chat", "shell"] as const) {
        if (still.includes(part) && await (part === "chat" ? ports.reloadChat() : ports.reloadShell()).catch(() => false)) still.splice(still.indexOf(part), 1);
      }
    }
    if (previousCore !== null) {
      const back = await ports.swapCore(previousCore).catch((failure) => ({ ok: false as const, stage: "start" as const, error: message(failure) }));
      if (back.ok && still.includes("core")) still.splice(still.indexOf("core"), 1);
      else if (!back.ok) { if (!still.includes("core")) still.push("core"); ports.log(`hot install: the previous core could not be swapped back: ${back.error}`); }
    }
    return { ok: false, applied: still, error, disk };
  };
  if (parts.includes("core")) {
    const before = ports.coreScript();
    const outcome = await ports.swapCore(staged.core!).catch((error) => ({ ok: false as const, stage: "start" as const, error: message(error), rolledBack: false }));
    if (!outcome.ok) { if (outcome.stage === "start") previousCore = before; return undo(swapFailure(outcome)); }
    previousCore = before;
    applied.push("core");
  }
  if (staged.renderer) {
    previousRenderer = ports.useRenderer(staged.renderer);
    if (parts.includes("chat")) {
      applied.push("chat"); // A failed attempt also needs the previous page restored.
      if (!(await ports.reloadChat().catch(() => false))) return undo("the new chat page did not come up");
    }
    if (parts.includes("shell")) {
      applied.push("shell");
      if (!(await ports.reloadShell().catch(() => false))) return undo("the new shell did not come up");
    }
  }
  if (parts.includes("mobile")) applied.push("mobile");
  return { ok: true, applied, disk: "installed" };
}

// ------------------------------------------------------------------------------------------------
// The installer main holds

export interface HotInstallerOptions {
  /** The running app bundle (null: not running from one). */
  target: string | null;
  /** Real entry must authenticate a signed ZIP; no unsigned production fallback. */
  authenticate?: (path: string) => Promise<AuthenticatedBuild>;
  /** Main data folder for runtime copies and the durable transaction journal. Whole-bundle backups remain beside the app in owned .botling-hot-* roots. */
  dataDir: string;
  fs: Fs;
  run: Run;
  /** Everything else applyHot needs except staging and the bundle on disk. */
  ports: Omit<ApplyPorts, "stage" | "install" | "restore">;
  /** A report goes to the core running then. */
  notify(report: HotReport): void;
}

export interface InstallRequest { path: string; requester: string; note: string; from: string; to: string }

/** Identity of the bundle's app files and Info.plist on disk: tells whether it was replaced behind this process. */
function diskIdentity(bundle: string, fs: Fs): string {
  return ["Contents/Resources/app.asar", "Contents/Resources/app", "Contents/Info.plist"].map((rel) => {
    try { const stat = fs.statSync(join(bundle, rel)); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return "-"; }
  }).join("|");
}

export class HotInstaller {
  private readonly staging: string;
  /** The bundle on disk as this process knows it (null until first compared). */
  private running: BundlePrints | null = null;
  private identity: string | null;
  /** Set when the bundle on disk no longer matches what runs (a failed put-back); every later install restarts. */
  private stuck: string | null = null;
  private busy = false;
  private authenticated = new Map<string, AuthenticatedBuild>();
  /** Folders the running process uses under the staging root. */
  private inUse: { core: string | null; renderer: string | null } = { core: null, renderer: null };

  constructor(private readonly options: HotInstallerOptions) {
    this.staging = join(options.dataDir, "hot-builds");
    // Taken at start: the bundle this process was launched from.
    this.identity = options.target ? diskIdentity(options.target, options.fs) : null;
    // Copies from an earlier run are not used by this one.
    // Do not race a new staging operation or delete pending recovery evidence.
  }

  get installing() { return this.busy; }
  verified(path: string) { return this.authenticated.get(this.options.fs.realpathSync(path)); }

  private async runningPrints(): Promise<BundlePrints> {
    const target = this.options.target!;
    if (diskIdentity(target, this.options.fs) !== this.identity) throw new Error("the app on disk changed since Botling started");
    this.running ??= await bundlePrints(target, this.options.fs);
    return this.running;
  }

  /** Checks the path and compares; the plan and the new build's fingerprints. */
  async plan(path: string): Promise<{ plan: InstallPlan; build?: string; incoming?: BundlePrints }> {
    const restart = (reason: string) => ({ plan: { mode: "restart", reasons: [reason] } as InstallPlan });
    const target = this.options.target;
    if (!target) return restart("this Botling is not running from an app bundle");
    if (this.stuck) return { plan: { mode: "restart", blocked: true, reasons: [this.stuck] } };
    if (this.options.fs.existsSync(join(this.options.dataDir, "hot-install-pending.json"))) return { plan: { mode: "restart", blocked: true, reasons: ["A hot-install transaction needs completion or recovery"] } };
    if (this.options.fs.existsSync(join(this.options.dataDir, "update-pending.json"))) return { plan: { mode: "restart", blocked: true, reasons: ["A verified restart update is pending"] } };
    let build: string;
    try { build = this.options.fs.realpathSync(path); } catch { return restart(`there is no build at ${path}`); }
    if (build !== resolve(path)) return { plan: { mode: "restart", blocked: true, reasons: ["Candidate path cannot traverse symlinks"] } };
    if (!build.endsWith(".app") || build === target || build.startsWith(target + sep) || target.startsWith(build + sep)) return restart(`${path} cannot be installed in place`);
    if (!this.options.authenticate) return { plan: { mode: "restart", blocked: true, reasons: ["Signed candidate verification is unavailable"] } };
    let verified: AuthenticatedBuild;
    try {
      const fs = this.options.fs;
      const cached = this.authenticated.get(build);
      requireNewer(bundleVersion(await fs.promises.readFile(join(build, "Contents/Info.plist"), "utf8")), bundleVersion(await fs.promises.readFile(join(target, "Contents/Info.plist"), "utf8")));
      if (cached && await exactTree(build, fs) === cached.digest && await exactTree(cached.app, fs) === cached.digest) verified = cached;
      else verified = await this.options.authenticate(build);
      this.authenticated.set(build, verified);
    } catch (error) { return { plan: { mode: "restart", blocked: true, reasons: [message(error)] } }; }
    let running: BundlePrints;
    try { running = await this.runningPrints(); } catch (error) { return restart(`could not compare with the running build: ${message(error)}`); }
    let incoming: BundlePrints;
    try { incoming = await bundlePrints(verified.app, this.options.fs); } catch (error) { return restart(`could not read the new build: ${message(error)}`); }
    if (incoming.bundleID !== running.bundleID) return restart(`${path} is another app (${incoming.bundleID})`);
    const plan = planInstall(running, incoming);
    return { plan, build, incoming };
  }

  /**
   * Installs a build the user confirmed, when it can be hot: answers at once (the work goes on, and its report
   * goes to `notify`); {ok: false} when it needs a restart or another install is under way.
   */
  async install(request: InstallRequest): Promise<{ ok: boolean; error?: string; plan?: InstallPlan }> {
    if (this.busy) return { ok: false, error: "Another build is being installed." };
    this.busy = true;
    let planned: Awaited<ReturnType<HotInstaller["plan"]>>;
    try { planned = await this.plan(request.path); } catch (error) { this.busy = false; return { ok: false, error: message(error) }; }
    const { plan, build, incoming } = planned;
    if (plan.mode !== "hot" || !build || !incoming) { this.busy = false; return { ok: false, error: `${plan.blocked ? "Build refused" : "It needs a restart"}: ${plan.mode === "restart" ? plan.reasons.join("; ") : ""}`, plan }; }
    void this.apply(request, build, incoming, plan.parts).catch(error => {
      this.stuck = message(error);
      this.options.notify({ ok: false, applied: [], disk: "stuck", error: this.stuck, requester: request.requester, note: request.note, from: request.from, to: request.to });
    }).finally(() => { this.busy = false; });
    return { ok: true, plan };
  }

  private async apply(request: InstallRequest, build: string, incoming: BundlePrints, parts: HotPart[]) {
    const { fs, run, ports } = this.options;
    const verified = this.authenticated.get(build)!;
    build = verified.app;
    const transaction = new HotTransaction(this.options.dataDir, fs, run);
    const target = this.options.target!;
    const stamp = `${Date.now()}`;
    let staged: { dir: string; core?: string; renderer?: string } | null = null;
    ports.log(`hot install: ${build} (${parts.map((part) => PART_NAMES[part]).join(", ") || "no parts"})`);
    const old = await stageParts(target, await this.runningPrints(), ["core"], this.staging, fs, `${stamp}-previous`);
    const result = await applyHot(parts, {
      ...ports,
      coreScript: () => old.core!,
      stage: async (wanted) => {
        if (await exactTree(build, fs) !== verified.digest) throw new Error("Authenticated candidate changed");
        staged = await stageParts(build, incoming, wanted, this.staging, fs, stamp);
        return staged;
      },
      install: async () => {
        await transaction.prepare(target, build, verified.digest);
        try { await transaction.activate(); } catch (error) { await transaction.recover(); throw error; }
        this.identity = diskIdentity(target, fs);
        this.running = incoming;
      },
      restore: async () => {
        await transaction.rollback();
        this.identity = diskIdentity(target, fs);
        this.running = null;
      },
      swapCore: async (script) => {
        const outcome = await ports.swapCore(script);
        if (outcome.ok) this.inUse.core = script;
        return outcome;
      },
      useRenderer: (dir) => { this.inUse.renderer = dir; return ports.useRenderer(dir); },
    });
    if (!result.ok && result.disk === "untouched" && fs.existsSync(transaction.file)) result.disk = "stuck";
    if (result.disk === "stuck" || (!result.ok && result.applied.length)) this.stuck = "an earlier install left the app on disk different from the running build; restart Botling first";
    else if (result.ok) {
      try { await transaction.commit(); }
      catch (error) { result.ok = false; result.disk = "stuck"; result.error = `Could not finalize hot install: ${message(error)}`; this.stuck = result.error; }
    }
    if (!result.ok && result.disk === "restored" && result.applied.length === 0) await transaction.recover();
    // An uncertain rollback may still have a process using either generation. Preserve both.
    if (result.ok || (result.disk !== "stuck" && result.applied.length === 0)) await pruneStaging(this.staging, [this.inUse.core, this.inUse.renderer], fs).catch(() => {});
    void staged;
    this.authenticated.delete(request.path);
    this.options.notify({ ...result, requester: request.requester, note: request.note, from: request.from, to: request.to });
  }

}
