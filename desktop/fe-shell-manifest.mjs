// The shell half of the FE build's manifest (M7-10b; plan-change §4.3 check 4, D55, N8): `minFeVersion` names the shell only.
//
// fe-build-manifest.json gets `shell: { minFeVersion, hash }`:
//   - minFeVersion: the value of `MIN_FE_VERSION`, found BY NAME in desktop/src (a card may move the constant to another file);
//   - hash: a hash of every file the shell is made of (SHELL_ROOTS, minus plugin sources, tests and docs).
// A plugin-only change (builtin-plugins/** or src/renderer/plugins/**) is not part of the shell, so it can never move either
// value. scripts/check-shell-version.mjs fails a commit that touches only plugin sources and moves one anyway.
//
// A "tree" is a read-only view of the files of the repository: `fsTree(repoRoot)` (the working tree) or `gitTree(repoRoot, ref)`
// (a commit, nothing checked out). Both name a file by its git blob id, so the two give the same hash for the same files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative folders the shell is made of (the FE build's own code: renderer, phone page, link, protocol, chat page, kit). */
export const SHELL_ROOTS = [
  "desktop/src/renderer", "desktop/web-v3", "desktop/mobile", "desktop/src/fe-link", "desktop/src/protocol", "desktop/src/contract",
  "Web/src", "Web/kit", "Web/host",
];
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
/** True for a file the shell hash covers. */
export const isShellPath = (path, roots = SHELL_ROOTS) => inside(path, roots) && !isPluginSourcePath(path) && !isNeutralPath(path);

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

/** The working tree under `repoRoot`. `files(roots)`: [{ path, id }] under those repo-relative folders; `read(path)`: text. */
export function fsTree(repoRoot) {
  return {
    files(roots) {
      const paths = [];
      for (const root of roots) if (existsSync(join(repoRoot, root))) walk(join(repoRoot, root), root, paths);
      return paths.map((path) => ({ path, id: blobId(readFileSync(join(repoRoot, path))) }));
    },
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
    files(roots) {
      const out = git("ls-tree", "-r", "-z", "--full-tree", ref, "--", ...roots);
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

/** The hash of the shell's files: sha256 of "<path>\0<blob id>\n" per file, sorted by path. */
export function shellHash(tree, roots = SHELL_ROOTS, accept = isShellPath) {
  const rows = tree.files(roots).filter(({ path }) => accept(path, roots)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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

/** `{ minFeVersion, hash }` for the tree: the manifest's shell part. */
export const shellManifest = (tree, roots = SHELL_ROOTS) => ({ minFeVersion: findMinFeVersion(tree), hash: shellHash(tree, roots) });

/** The committed baseline: the shell part as of the last shell change (the build's manifest is not committed, so the check compares with this).
 * It lives beside the manifest code and outside SHELL_ROOTS, so writing it never moves the hash. */
export const SHELL_BASELINE_FILE = "desktop/fe-shell-baseline.json";
export const shellBaselineText = (shell) => `${JSON.stringify({ version: 1, shell: { minFeVersion: shell.minFeVersion, hash: shell.hash } }, null, 2)}\n`;
/** The shell part named by a baseline file's text; null when it is not a well-formed baseline (fails closed). */
export function parseShellBaseline(text) {
  try {
    const shell = JSON.parse(text)?.shell;
    return shell && typeof shell.minFeVersion === "string" && /^[0-9a-f]{64}$/.test(shell.hash) ? { minFeVersion: shell.minFeVersion, hash: shell.hash } : null;
  } catch { return null; }
}
