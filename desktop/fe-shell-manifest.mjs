// The shell half of the FE build's manifest (M7-10b; plan-change §4.3 check 4, D55, N8): `minFeVersion` names the shell only.
//
// fe-build-manifest.json gets `shell: { minFeVersion, hash }`:
//   - minFeVersion: the value of `MIN_FE_VERSION`, found BY NAME in desktop/src (a card may move the constant to another file);
//   - hash: a hash of every file the shell is made of: the files the web-v3 build reads (`shellInputs`), minus plugin sources (M7-10c;
//     it was a list of folders, which missed 23 files such as desktop/src/session/*).
// A plugin-only change (builtin-plugins/** or src/renderer/plugins/**) is not part of the shell, so it can never move either
// value. scripts/check-shell-version.mjs fails a commit that touches only plugin sources and moves one anyway.
//
// A "tree" is a read-only view of the files of the repository: `fsTree(repoRoot)` (the working tree) or `gitTree(repoRoot, ref)`
// (a commit, nothing checked out). Both name a file by its git blob id, so the two give the same hash for the same files.
//
// esbuild is NOT imported here, and not loaded in this process either: its module checks `new TextEncoder().encode("") instanceof Uint8Array`
// while loading and throws under jsdom (a vitest `@vitest-environment jsdom` file that imports fe-build-manifest.mjs, then calls
// feBuildManifestFile). `shellInputs` runs the build in a child node process (`ESBUILD_INPUTS_SCRIPT`); this file only resolves the
// path of the package (no load), so importing it has no esbuild side effect and `shellInputs` works in any test environment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** The entries of the web-v3 build (web-v3/build.mjs): the phone/browser page's shell, chat page, PDF viewer and service worker. */
export const WEB_V3_ENTRIES = ["desktop/web-v3/shell/main.tsx", "desktop/web-v3/chat-entry.ts", "desktop/web-v3/pdf-viewer/viewer.ts", "desktop/web-v3/sw.ts"];
/** Where `MIN_FE_VERSION` is looked for (by name). */
export const MIN_FE_VERSION_ROOT = "desktop/src";
export const MIN_FE_VERSION_NAME = "MIN_FE_VERSION";
/** Repo-relative folders of plugin sources: the framed built-ins and the in-page plugins of the FE build. */
export const PLUGIN_SOURCE_ROOTS = ["desktop/builtin-plugins/", "desktop/src/renderer/plugins/"];

const inside = (path, roots) => roots.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));
const NOT_CODE_DIR = /(?:^|\/)(?:node_modules|dist|test|tests|__tests__|fixtures)\//;
const NOT_CODE_FILE = /(?:\.(?:test|spec)\.[a-z]+|\.md|\.DS_Store|dist\.inputs\.json)$/;

export const isPluginSourcePath = (path) => inside(path, PLUGIN_SOURCE_ROOTS);
/** A test, a doc or a note: changes that cannot make a plugin-only commit into a shell commit. */
export const isNeutralPath = (path) => NOT_CODE_DIR.test(path) || NOT_CODE_FILE.test(path) || /^(?:docs|\.bot)\//.test(path);

/** The child process of `shellInputs`: reads { esbuild, options } as JSON from stdin, builds, prints the metafile's input paths as JSON. */
const ESBUILD_INPUTS_SCRIPT = `const { esbuild, options } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const { metafile } = require(esbuild).buildSync(options);
process.stdout.write(JSON.stringify(Object.keys(metafile.inputs)));`;

/** The input paths of esbuild's metafile for `options`, built in a child node process (see the top of this file). Synchronous; a build error throws. */
function buildInputs(options) {
  const esbuild = createRequire(import.meta.url).resolve("esbuild"); // resolves the path only: nothing is loaded here
  try {
    const out = execFileSync(process.execPath, ["-e", ESBUILD_INPUTS_SCRIPT], { input: JSON.stringify({ esbuild, options }), encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    return JSON.parse(out);
  } catch (error) {
    throw new Error(`shellInputs: the esbuild build failed: ${error?.stderr || error?.message || error}`);
  }
}

/**
 * The files the shell is made of: what the web-v3 build reads (esbuild's metafile inputs for WEB_V3_ENTRIES, the options of
 * web-v3/build.mjs), as sorted repo-relative paths, without plugin sources, node_modules and anything outside the repository.
 * Read from the working tree under `repoRoot`; an entry that is not there is skipped (a scratch root has none), a build error throws.
 */
export function shellInputs(repoRoot) {
  const cwd = realpathSync.native(repoRoot); // esbuild names files by real path: relative to a typed /var/... they would be "../../private/var/..."
  const entryPoints = WEB_V3_ENTRIES.map((entry) => join(cwd, entry)).filter((entry) => existsSync(entry));
  if (entryPoints.length === 0) return [];
  const inputs = buildInputs({ entryPoints, absWorkingDir: cwd, outdir: join(cwd, "unused-output"), write: false, metafile: true, bundle: true, format: "iife",
    jsx: "automatic", target: ["chrome130", "safari17"], nodePaths: [join(cwd, "desktop/node_modules")], logLevel: "silent", logOverride: { "empty-glob": "silent" } });
  const paths = inputs.filter((path) => !path.startsWith("<")).map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("../") && !path.includes("node_modules/") && !isPluginSourcePath(path));
  return [...new Set(paths)].sort();
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** The git blob id of some bytes (what `git hash-object` prints). */
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function walk(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}/${entry.name}`, out);
    else if (entry.isFile()) out.push(`${prefix}/${entry.name}`);
  }
}

/** The working tree under `repoRoot`. `ids(paths)`: [{ path, id }] for those repo-relative files that exist; `read(path)`: text. */
export function fsTree(repoRoot) {
  return {
    ids: (paths) => paths.filter((path) => existsSync(join(repoRoot, path))).map((path) => ({ path, id: blobId(readFileSync(join(repoRoot, path))) })),
    read: (path) => readFileSync(join(repoRoot, path), "utf8"),
    /** The paths under `root` whose text contains `needle`. */
    grep(root, needle) {
      const paths = [];
      if (existsSync(join(repoRoot, root))) walk(join(repoRoot, root), root, paths);
      return paths.filter((path) => readFileSync(join(repoRoot, path)).includes(needle));
    },
  };
}

/** The files of commit `ref` in the repository at `repoRoot` (read with git, nothing checked out). */
export function gitTree(repoRoot, ref) {
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return {
    ids(paths) {
      if (paths.length === 0) return [];
      const out = git("ls-tree", "-r", "-z", "--full-tree", ref, "--", ...paths);
      return out.split("\0").filter(Boolean).flatMap((row) => {
        const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(row);
        return match ? [{ path: match[2], id: match[1] }] : [];
      });
    },
    read: (path) => git("show", `${ref}:${path}`),
    grep(root, needle) {
      try {
        return git("grep", "-l", "-z", "-I", "-F", "-e", needle, ref, "--", root).split("\0").filter(Boolean).map((row) => row.slice(ref.length + 1));
      } catch (error) { if (error?.status === 1) return []; throw error; } // git grep exits 1 when nothing matches; anything else is an error
    },
  };
}

/** The hash of the shell's `files` (`shellInputs`) in `tree`: sha256 of "<path>\0<blob id>\n" per file that exists there, sorted by path. */
export function shellHash(tree, files) {
  const rows = tree.ids(files).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(rows.map(({ path, id }) => `${path}\0${id}\n`).join(""));
}

const DEFINITION = new RegExp(`(?:^|[\\s;])const\\s+${MIN_FE_VERSION_NAME}\\s*(?::\\s*string\\s*)?=\\s*(["'])([^"'\\r\\n]*)\\1`);

/** The value of the `const MIN_FE_VERSION = "…"` found under desktop/src by name (non-test code only), or null when there is not exactly one. */
export function findMinFeVersion(tree) {
  const values = [];
  for (const path of tree.grep(MIN_FE_VERSION_ROOT, MIN_FE_VERSION_NAME)) {
    if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(path) || isNeutralPath(path)) continue;
    const match = DEFINITION.exec(tree.read(path));
    if (match) values.push(match[2]);
  }
  return values.length === 1 ? values[0] : null;
}

/** `{ minFeVersion, hash }` for the tree: the manifest's shell part (`files`: `shellInputs` of the same checkout). */
export const shellManifest = (tree, files) => ({ minFeVersion: findMinFeVersion(tree), hash: shellHash(tree, files) });

/** The committed baseline: only `minFeVersion`, as of the last bump (the build's manifest is not committed, so the check compares with this).
 * The shell hash is NOT in it on purpose: many branches edit the shell at once and would all conflict on it; the hash rule is per commit
 * (scripts/check-shell-version.mjs). It lives outside SHELL_ROOTS. */
export const SHELL_BASELINE_FILE = "desktop/fe-shell-baseline.json";
export const shellBaselineText = (minFeVersion) => `${JSON.stringify({ version: 1, shell: { minFeVersion } }, null, 2)}\n`;
/** The `minFeVersion` a baseline file's text names; null when it is not a well-formed baseline (fails closed). */
export function parseShellBaseline(text) {
  try {
    const value = JSON.parse(text)?.shell?.minFeVersion;
    return typeof value === "string" && value !== "" ? value : null;
  } catch { return null; }
}
