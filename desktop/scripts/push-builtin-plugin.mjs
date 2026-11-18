// `desktop/scripts/push-builtin-plugin.sh <name> [--data-dir <core data folder>]`: update a built-in plugin (desktop/builtin-plugins/<name>)
// in the running app, with no rebuild of the app and no restart. It builds the plugin from this checkout, checks the built folder with
// the plugin check, and puts it into `<core data>/builtin-overrides` (src/core/plugins/overrides.ts holds the rules and the layout);
// the app takes it at its next 1.5 s scan: program part swapped in the plugin host, web part loaded again in the chat page, open frames
// loaded again in place. `--remove` brings the app's own copy back. Only a plugin the app ships can be pushed; the core is not.
//
// The default core data folder is Botling 3's (`~/Library/Application Support/Botling 3/server`); another one (a dev trial, a test) goes
// with `--data-dir`. A folder with no plugin library in it is refused, so a wrong path does not leave a stray folder behind.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The plugins the core reads from the shipped folder itself: a pushed copy would not be the one it reads (same list as overrides.ts). */
export const CORE_FIXED_PLUGINS = ["botling.orchestration"];

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const sha = (data) => createHash("sha256").update(data).digest("hex");

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** The hash of a plugin folder as the catalog and the core take it (src/core/plugins/catalog.ts `folderHash`). */
export function contentHash(dir) {
  const files = listFiles(dir).map((file) => relative(dir, file).split(sep).join("/")).sort();
  return sha(files.map((file) => `${file}\0${sha(readFileSync(join(dir, file)))}\n`).join(""));
}

/** Throws when anything under `dir` is a link or a special file. */
function assertPlain(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) assertPlain(path);
    else if (!entry.isFile()) throw new Error(`The built plugin holds a link or a special file (${relative(dir, path)}), which a pushed plugin may not.`);
  }
}

/** Takes group and world write away from everything under `dir` (the core runs a pushed copy only when nobody else can write to it). */
function closeWrite(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) closeWrite(path);
    else chmodSync(path, (lstatSync(path).mode & 0o777 & ~0o022) | 0o600);
  }
  chmodSync(dir, 0o755);
}

const stampFile = (name) => `${name}.push.json`;

function readPreviousDir(root, name) {
  try {
    const body = JSON.parse(readFileSync(join(root, stampFile(name)), "utf8"));
    return typeof body.dir === "string" && body.dir.startsWith(`${name}@`) && !body.dir.includes("/") ? body.dir : null;
  } catch {
    return null;
  }
}

/** Removes a plugin's stamp and folders from the overrides folder: the app's own copy runs again. */
export function removeOverride({ name, root }) {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a plugin name.`);
  rmSync(join(root, stampFile(name)), { force: true });
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) if (entry.startsWith(`${name}@`)) rmSync(join(root, entry), { recursive: true, force: true });
}

/**
 * Puts a built plugin folder (`built`) into `root` as the pushed copy of `name`: a content-named folder beside the old one, then the
 * stamp moved with one rename (so a scan sees the old copy or the new one, never half of one, never the app's own in between). The
 * version gets `+push.<8 hex>` (the build's own hash) so open frames and the plugin list see an update; the folder is named by the hash
 * of what is finally in it. The current folder and the one before it stay; older ones go.
 */
export function placeOverride({ built, name, root, now = Date.now() }) {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a plugin name.`);
  assertPlain(built);
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.${name}.pushing-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(built, staging, { recursive: true });
    const buildId = contentHash(staging).slice(0, 8);
    const manifestFile = join(staging, "package.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.version = `${String(manifest.version).split("+")[0]}+push.${buildId}`;
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    closeWrite(staging);
    const hash = contentHash(staging);
    const dir = `${name}@${hash.slice(0, 12)}`;
    const folder = join(root, dir);
    const previous = readPreviousDir(root, name);
    if (existsSync(folder) && contentHash(folder) === hash) rmSync(staging, { recursive: true, force: true });
    else {
      rmSync(folder, { recursive: true, force: true });
      renameSync(staging, folder);
    }
    const stamp = join(root, `.${name}.push.json.${process.pid}`);
    writeFileSync(stamp, `${JSON.stringify({ v: 1, plugin: name, dir, folderHash: hash, pushedAt: now })}\n`, { mode: 0o644 });
    chmodSync(stamp, 0o644);
    renameSync(stamp, join(root, stampFile(name)));
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(`${name}@`) && entry !== dir && entry !== previous) rmSync(join(root, entry), { recursive: true, force: true });
    }
    return { dir, folder, hash, changed: dir !== previous };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The plugin check Maintainer runs (out/host/check-plugin.cjs), on a built folder; the problems it prints, none: it passes. */
function checkWithCli(desktopDir, folder) {
  const script = join(desktopDir, "out", "host", "check-plugin.cjs");
  if (!existsSync(script)) {
    const built = spawnSync(process.execPath, [join(desktopDir, "build.mjs")], { cwd: desktopDir, encoding: "utf8" });
    if (built.status !== 0 || !existsSync(script)) throw new Error(`The plugin check is not built (${script}) and node build.mjs failed:\n${built.stdout}${built.stderr}`);
  }
  const run = spawnSync(process.execPath, [script, folder], { encoding: "utf8", env: { ...process.env, BOTLING_BUILTIN_PLUGINS: join(desktopDir, "builtin-plugins") } });
  if (run.status === 0) return [];
  const lines = `${run.stdout}${run.stderr}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : [`the plugin check failed (exit ${run.status})`];
}

/** `build-builtin-plugins.mjs`, for this one plugin, into a scratch folder: its folder, and what removes the scratch folder. */
async function buildHere(desktopDir, name) {
  const scratch = mkdtempSync(join(tmpdir(), "push-builtin-"));
  const { buildBuiltinPlugins } = await import(pathToFileURL(join(desktopDir, "build-builtin-plugins.mjs")).href);
  await buildBuiltinPlugins({ root: desktopDir, outdir: scratch, only: [name] });
  return { folder: join(scratch, name), done: () => rmSync(scratch, { recursive: true, force: true }) };
}

/** How many agent commands (`ccb.contributes.agentCommands`) the built plugin declares. */
function agentCommandsOf(folder) {
  try {
    const list = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))?.ccb?.contributes?.agentCommands;
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Builds `name`, checks it and pushes it. `build(name)` and `check(folder)` are the real ones unless a test gives its own. Nothing is
 * put in place unless the build and the check both pass; an earlier push stays as it was.
 */
export async function pushBuiltinPlugin({ name, desktopDir, dataDir, build, check, now, log = console.log }) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`"${name}" is not a plugin name.`);
  const source = join(desktopDir, "builtin-plugins", name, "package.json");
  let declared;
  try { declared = JSON.parse(readFileSync(source, "utf8")).name; } catch { declared = null; }
  if (declared !== name) throw new Error(`The app ships no built-in plugin named "${name}" (no desktop/builtin-plugins/${name}).`);
  if (CORE_FIXED_PLUGINS.includes(name)) throw new Error(`"${name}" is read by the core from the app's own folder, so it cannot change while the app runs: it needs a new build.`);
  log(`${name}: building…`);
  let built;
  let done = () => {};
  if (build) built = await build(name);
  else ({ folder: built, done } = await buildHere(desktopDir, name));
  try {
    const problems = (check ?? ((folder) => checkWithCli(desktopDir, folder)))(built);
    if (problems.length) throw new Error(`${name}: the built plugin fails the plugin check, nothing was pushed:\n  ${problems.join("\n  ")}`);
    const placed = placeOverride({ built, name, root: join(dataDir, "builtin-overrides"), ...(now !== undefined ? { now } : {}) });
    // A command the app runs as its own flag (botling.report's --render-report) is found in the build's own folder before the app is
    // ready, with no registry: a push does not move it (src/core/plugins/app-command.ts has its own override folder for that).
    if (agentCommandsOf(built) > 0) log(`${name}: it declares agent commands that the app runs from its own build's folder; a push does not change those (see src/core/plugins/app-command.ts, plugin-overrides). Its panels and program part are updated.`);
    return placed;
  } finally {
    done();
  }
}

/** Botling 3's core data folder, where the app keeps its plugin library (`…/Botling 3/server/plugins`). */
export function defaultDataDir(env = process.env, home = homedir()) {
  return env.BOTLING_PUSH_DATA_DIR || join(home, "Library", "Application Support", "Botling 3", "server");
}

async function main(argv) {
  const args = argv.slice(2);
  const take = (flag) => { const at = args.indexOf(flag); if (at < 0) return undefined; const [, value] = args.splice(at, 2); return value; };
  const dataDir = resolve(take("--data-dir") ?? defaultDataDir());
  const remove = args.includes("--remove") ? (args.splice(args.indexOf("--remove"), 1), true) : false;
  const [name, ...extra] = args;
  if (!name || extra.length) throw new Error("usage: push-builtin-plugin.sh [--remove] [--data-dir <core data folder>] <plugin name, e.g. botling.catchup>");
  if (!existsSync(join(dataDir, "plugins")) && !existsSync(join(dataDir, "plugins.json"))) throw new Error(`${dataDir} is not a Botling core data folder (no plugin library in it). Pass the right one with --data-dir.`);
  const root = join(dataDir, "builtin-overrides");
  if (remove) {
    removeOverride({ name, root });
    console.log(`${name}: the pushed copy is removed; the app's own copy runs again from its next scan (about 2 s).`);
    return;
  }
  const desktopDir = resolve(here, "..");
  const result = await pushBuiltinPlugin({ name, desktopDir, dataDir });
  console.log(`${name}: ${result.changed ? "pushed" : "already pushed (same build)"} ${result.dir} to ${root}`);
  console.log("The running app takes it at its next scan (about 2 s): no rebuild, no restart. It runs only while the app's Developer mode (Settings) is on. A newer app build drops it by itself; --remove drops it now.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
