// `minFeVersion` names the shell only (M7-10b; plan-change §4.3 check 4, D55, N8): the manifest's shell part and the build check
// that fails a plugin-only commit which moves MIN_FE_VERSION or the shell hash. Every case runs on a throwaway git repository.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { feBuildManifest, feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { findMinFeVersion, fsTree, gitTree, isNeutralPath, isPluginSourcePath, parseShellBaseline, SHELL_BASELINE_FILE, shellBaselineText, shellHash, shellInputs, shellManifest } from "../../fe-shell-manifest.mjs";
import { checkBaseline, checkChange, checkRange, classifyChange } from "../../scripts/check-shell-version.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(desktop, "scripts/check-shell-version.mjs");
const repos: string[] = [];
afterEach(() => { while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true }); });

const CONSTANT_FILE = "desktop/src/server/botlingd.ts";
const constant = (value: string) => `export const MIN_FE_VERSION = "${value}";\nexport const OTHER = 1;\n`;
// The web-v3 build's entry in the throwaway repositories: what it imports is the shell (a file the old folder list did not cover, a plugin source, a loose file).
const ENTRY = [
  'import "../../src/renderer/shell/main";', 'import "../../src/fe-link/link";', 'import "../../src/session/handshake";', 'import "../../../Web/src/plugin-kernel/kernel";',
  'import "../../src/renderer/plugins/settings/index";', 'import "../../builtin-plugins/botling.note/index.js";', "export const page = 1;", "",
].join("\n");
const SHELL_FILES = ["Web/src/plugin-kernel/kernel.ts", "desktop/src/fe-link/link.ts", "desktop/src/renderer/shell/main.tsx", "desktop/src/session/handshake.ts", "desktop/web-v3/shell/main.tsx"];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** A repository with the shell, a framed built-in, an in-page plugin and the constant; `commit(files, message)` adds a commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "botling-shell-version-"));
  repos.push(repo);
  git(repo, "init", "-q", "-b", "main");
  const commit = (files: Record<string, string | null>, message = "change"): string => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(repo, path), { force: true });
      else { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  const base = commit({
    [CONSTANT_FILE]: constant("3.0.0-m1"),
    "desktop/src/renderer/shell/main.tsx": "export const shell = 1;\n",
    "desktop/src/fe-link/link.ts": "export const link = 1;\n",
    "Web/src/plugin-kernel/kernel.ts": "export const kernel = 1;\n",
    "desktop/web-v3/shell/main.tsx": ENTRY,
    "desktop/src/session/handshake.ts": "export const handshake = 1;\n",
    "desktop/src/renderer/shell/unused.ts": "export const unused = 1;\n", // under an old shell folder, but no entry imports it
    "desktop/builtin-plugins/botling.note/index.js": "module.exports = 1;\n",
    "desktop/src/renderer/plugins/settings/index.ts": "export const activate = () => {};\n",
    "docs/notes.md": "# notes\n",
  }, "base");
  // The committed baseline (MIN_FE_VERSION only; what `--update` writes).
  const baseline = commit({ [SHELL_BASELINE_FILE]: shellBaselineText(findMinFeVersion(fsTree(repo))!) }, "baseline");
  return { repo, commit, base: baseline };
}

describe("which paths are a plugin source, or neutral", () => {
  it("splits them as the card says", () => {
    for (const path of ["desktop/src/renderer/shell/main.tsx", "desktop/src/fe-link/link.ts", "desktop/src/session/handshake.ts", "desktop/web-v3/shell/connection.ts", "Web/src/plugin-kernel/kernel.ts", "Web/host/src/api.ts"]) {
      expect(isPluginSourcePath(path), path).toBe(false);
      expect(isNeutralPath(path), path).toBe(false);
    }
    for (const path of ["desktop/builtin-plugins/botling.note/index.js", "desktop/src/renderer/plugins/settings/index.ts"]) expect(isPluginSourcePath(path), path).toBe(true);
    for (const path of ["desktop/test/unit/x.test.ts", "desktop/src/renderer/shell/x.test.ts", "docs/a.md", ".bot/artifacts/x.md", "desktop/web-v3/dist/web.js", "Web/test/a.ts"]) expect(isNeutralPath(path), path).toBe(true);
    expect(isPluginSourcePath("desktop/builtin-plugins-extra/a.js")).toBe(false);
  });

  it("calls a change plugin-only when plugin sources are all it touches (tests and docs aside)", () => {
    expect(classifyChange(["desktop/builtin-plugins/botling.note/index.js"])).toBe("plugin-only");
    expect(classifyChange(["desktop/builtin-plugins/botling.note/index.js", "desktop/src/renderer/plugins/x/index.ts", "desktop/test/unit/note.test.ts", "docs/a.md"])).toBe("plugin-only");
    expect(classifyChange(["desktop/builtin-plugins/botling.note/index.js", "desktop/src/renderer/shell/main.tsx"])).toBe("other");
    expect(classifyChange(["desktop/builtin-plugins/botling.note/index.js", "desktop/src/server/botlingd.ts"])).toBe("other");
    expect(classifyChange(["docs/a.md", "desktop/test/unit/x.test.ts"])).toBe("none");
    expect(classifyChange([])).toBe("none");
    // A plugin's own test is still a plugin source.
    expect(classifyChange(["desktop/builtin-plugins/botling.note/test/a.test.ts"])).toBe("plugin-only");
  });
});

describe("the shell part of the manifest", () => {
  it("names MIN_FE_VERSION found by name, and a hash of the shell's files only", () => {
    const { repo, commit, base } = makeRepo();
    const files = shellInputs(repo);
    expect(files).toEqual(SHELL_FILES); // plugin sources (imported by the entry too) and the file nothing imports are not in it
    const first = shellManifest(gitTree(repo, base), files);
    expect(first.minFeVersion).toBe("3.0.0-m1");
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    // A plugin source, a test and a doc do not move it; a shell file does; so does the constant.
    const plugin = commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 2;\n", "desktop/src/renderer/plugins/settings/index.ts": "export const activate = () => 1;\n", "desktop/test/unit/a.test.ts": "x\n", "docs/notes.md": "more\n" });
    expect(shellManifest(gitTree(repo, plugin), files)).toEqual(first);
    const shell = commit({ "desktop/src/renderer/shell/main.tsx": "export const shell = 2;\n" });
    expect(shellHash(gitTree(repo, shell), files)).not.toBe(first.hash);
    const bumped = commit({ [CONSTANT_FILE]: constant("3.0.0-m2") });
    expect(shellManifest(gitTree(repo, bumped), files).minFeVersion).toBe("3.0.0-m2");
  });

  it("takes its files from the web-v3 build's inputs, not from a folder list", () => {
    const { repo, commit, base } = makeRepo();
    const files = shellInputs(repo);
    const hashAt = (ref: string) => shellHash(gitTree(repo, ref), files);
    // desktop/src/session/* is no old shell folder, yet the phone page reads it: a change there moves the hash.
    const session = commit({ "desktop/src/session/handshake.ts": "export const handshake = 2;\n" });
    expect(hashAt(session)).not.toBe(hashAt(base));
    // A file under an old shell folder that no entry imports, and one outside every folder, do not.
    const loose = commit({ "desktop/src/renderer/shell/unused.ts": "export const unused = 2;\n", "desktop/src/server/other.ts": "export const other = 1;\n" });
    expect(hashAt(loose)).toBe(hashAt(session));
    // A file the entry starts to import is in the next list.
    const grown = commit({ "desktop/src/session/lanes.ts": "export const lanes = 1;\n", "desktop/src/session/handshake.ts": 'import "./lanes";\nexport const handshake = 2;\n' });
    expect(shellInputs(repo)).toEqual([...SHELL_FILES, "desktop/src/session/lanes.ts"].sort());
    const more = commit({ "desktop/src/session/lanes.ts": "export const lanes = 2;\n" });
    expect(shellHash(gitTree(repo, more), shellInputs(repo))).not.toBe(shellHash(gitTree(repo, grown), shellInputs(repo)));
  });

  it("lists the real build's inputs: the phone page's session files are in it, plugin sources and node_modules are not", () => {
    const files = shellInputs(resolve(desktop, ".."));
    for (const path of ["desktop/src/session/handshake.ts", "desktop/src/session/index.ts", "desktop/web-v3/shell/main.tsx"]) expect(files, path).toContain(path);
    expect(files.filter((path) => isPluginSourcePath(path) || /node_modules|^\.\.|^\//.test(path))).toEqual([]);
    expect(files).toEqual([...files].sort());
  });

  it("reads the same hash from a commit and from the working tree", () => {
    const { repo, base } = makeRepo();
    const files = shellInputs(repo);
    expect(shellManifest(fsTree(repo), files)).toEqual(shellManifest(gitTree(repo, base), files));
  });

  it("finds the constant after it moved to another file or got a type, and gives null for none or two", () => {
    const { repo, commit } = makeRepo();
    const moved = commit({ [CONSTANT_FILE]: "export const OTHER = 1;\n", "desktop/src/server/botlingd-version.ts": "export const MIN_FE_VERSION: string = 'v9';\n" });
    expect(findMinFeVersion(gitTree(repo, moved))).toBe("v9");
    const split = commit({ "desktop/src/server/botlingd-version.ts": "export const MIN_FE_VERSION =\n  \"v10\";\n" });
    expect(findMinFeVersion(gitTree(repo, split))).toBe("v10");
    const twice = commit({ "desktop/src/server/again.ts": "const MIN_FE_VERSION = \"v11\";\n" });
    expect(findMinFeVersion(gitTree(repo, twice))).toBeNull();
    const none = commit({ "desktop/src/server/again.ts": null, "desktop/src/server/botlingd-version.ts": "export const OTHER = 1; // MIN_FE_VERSION is gone\n" });
    expect(findMinFeVersion(gitTree(repo, none))).toBeNull();
    // A mention in a test or a re-export is not a definition.
    const noise = commit({ "desktop/src/server/botlingd-version.ts": "export { MIN_FE_VERSION } from './elsewhere';\n", "desktop/src/server/a.test.ts": "const MIN_FE_VERSION = \"zzz\";\n" });
    expect(findMinFeVersion(gitTree(repo, noise))).toBeNull();
  });

  it("is written into fe-build-manifest.json by the build's manifest function, and the real repository has a value and a hash", () => {
    const manifest = feBuildManifest(desktop);
    expect(manifest.version).toBe(1);
    expect(manifest.shell.hash).toMatch(/^[0-9a-f]{64}$/);
    // The value in the manifest is the one the server source defines (found by name, not by line).
    // The constant has moved between server files before (botlingd.ts -> botlingd-start.ts), so look in every one.
    const server = join(desktop, "src/server");
    const declared = readdirSync(server).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .flatMap((name) => /const MIN_FE_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(join(server, name), "utf8"))?.[1] ?? []);
    expect(declared).toHaveLength(1);
    expect(manifest.shell.minFeVersion).toBe(declared[0]);
    expect(Object.keys(manifest)).toEqual(["version", "shell", "plugins"]);
    // The hash is the one of the web-v3 build's inputs.
    expect(manifest.shell.hash).toBe(shellHash(fsTree(resolve(desktop, "..")), shellInputs(resolve(desktop, ".."))));
  });

  it("fails a real build when MIN_FE_VERSION cannot be found (the manifest would carry null)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "botling-shell-version-"));
    repos.push(repo);
    const root = join(repo, "desktop");
    mkdirSync(join(root, "src/server"), { recursive: true });
    writeFileSync(join(root, "src/server/a.ts"), "export const OTHER = 1;\n");
    // A plain call still gives null (a scratch root of a test has no constant); a build asks for the value.
    expect(feBuildManifest(root, repo).shell.minFeVersion).toBeNull();
    expect(() => feBuildManifest(root, repo, { requireMinFeVersion: true })).toThrow(/MIN_FE_VERSION is not defined exactly once/);
    expect(() => feBuildManifestFile(root, repo, { requireMinFeVersion: true })).toThrow(/MIN_FE_VERSION/);
    writeFileSync(join(root, "src/server/a.ts"), constant("3.0.0-m1"));
    expect(feBuildManifest(root, repo, { requireMinFeVersion: true }).shell.minFeVersion).toBe("3.0.0-m1");
    // The desktop renderer build refuses before it writes anything.
    writeFileSync(join(root, "src/server/a.ts"), "export const OTHER = 1;\n");
    const outdir = join(repo, "out");
    const { buildRenderer } = await import(join(desktop, "build-renderer.mjs"));
    await expect(buildRenderer({ root, outdir })).rejects.toThrow(/MIN_FE_VERSION/);
    expect(readdirSync(repo)).not.toContain("out");
    // Both real builds ask for it (web-v3/build.mjs has a fixed root: its source is what is checked).
    for (const file of ["build-renderer.mjs", "web-v3/build.mjs"]) expect(readFileSync(join(desktop, file), "utf8"), file).toMatch(/feBuildManifestFile\(root, undefined, \{ requireMinFeVersion: true \}\)/);
  });
});

describe("check-shell-version: a plugin-only change never moves the shell part", () => {
  it("passes plugin-only commits, with a plugin folder added, a test and a doc beside them", () => {
    const { repo, commit, base } = makeRepo();
    commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 2;\n" }, "edit a framed built-in");
    commit({ "desktop/src/renderer/plugins/chat/index.ts": "export const activate = () => {};\n", "desktop/test/unit/chat.test.ts": "t\n", "docs/notes.md": "d\n" }, "add an in-page plugin");
    const results = checkRange(repo, base, "HEAD");
    expect(results.map((r) => [r.subject, r.kind, r.problems])).toEqual([["edit a framed built-in", "plugin-only", []], ["add an in-page plugin", "plugin-only", []]]);
  });

  it("lets a shell commit or a mixed commit move the constant and the hash", () => {
    const { repo, commit, base } = makeRepo();
    commit({ "desktop/src/renderer/shell/main.tsx": "export const shell = 2;\n", [CONSTANT_FILE]: constant("3.0.0-m2") }, "shell and version");
    commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 3;\n", [CONSTANT_FILE]: constant("3.0.0-m3") }, "plugin with a server edit");
    commit({ "docs/notes.md": "only a doc\n" }, "doc");
    const results = checkRange(repo, base, "HEAD");
    expect(results.map((r) => [r.kind, r.problems])).toEqual([["other", []], ["other", []], ["none", []]]);
  });

  it("fails a plugin-only commit that changes MIN_FE_VERSION (here the constant sits in a plugin folder)", () => {
    const { repo, commit } = makeRepo();
    // The constant is moved to a plugin source (a card's mistake); the commit that moves it is not plugin-only (it edits botlingd.ts) ...
    const moved = commit({ [CONSTANT_FILE]: "export const OTHER = 1;\n", "desktop/src/renderer/plugins/settings/version.ts": constant("3.0.0-m1") }, "move the constant");
    expect(checkRange(repo, moved + "~1", moved)[0]!.problems).toEqual([]);
    // ... and a later plugin-only commit that bumps it is caught.
    const bump = commit({ "desktop/src/renderer/plugins/settings/version.ts": constant("3.0.0-m2") }, "plugin edit");
    const [result] = checkRange(repo, moved, bump);
    expect(result!.kind).toBe("plugin-only");
    expect(result!.problems).toEqual([expect.stringContaining("MIN_FE_VERSION changed")]);
  });

  it("fails a plugin-only commit that moves the shell hash (a shell definition that wrongly covers plugin sources)", () => {
    const { repo, commit, base } = makeRepo();
    const edit = commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 9;\n" }, "plugin edit");
    const paths = ["desktop/builtin-plugins/botling.note/index.js"];
    expect(checkChange(repo, base, edit, paths).problems).toEqual([]);
    // A wrong definition (the plugin folder counted as shell) moves the hash on the same commit: the check is what notices.
    const wrong = (tree: ReturnType<typeof gitTree>) => shellHash(tree, [...SHELL_FILES, "desktop/builtin-plugins/botling.note/index.js"]);
    expect(checkChange(repo, base, edit, paths, { hash: wrong }).problems).toEqual([expect.stringContaining("the shell hash changed")]);
    expect(checkRange(repo, base, edit, { hash: wrong })[0]!.problems).toEqual([expect.stringContaining("the shell hash changed")]);
    // A shell commit with the same wrong definition is not held to it.
    const shell = commit({ "desktop/src/renderer/shell/main.tsx": "export const shell = 3;\n" }, "shell edit");
    expect(checkRange(repo, edit, shell, { hash: wrong })[0]).toMatchObject({ kind: "other", problems: [] });
  });

  it("fails closed when the constant cannot be found in a plugin-only commit", () => {
    const { repo, commit, base } = makeRepo();
    commit({ [CONSTANT_FILE]: "export const OTHER = 1;\n" }, "lose the constant");
    const edit = commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 4;\n" }, "plugin edit");
    const results = checkRange(repo, base, edit);
    expect(results[1]!.problems).toEqual([expect.stringContaining("MIN_FE_VERSION is not defined exactly once")]);
  });

  it("skips merge commits and compares each side's commit with its own first parent (--no-merges)", () => {
    const { repo, commit, base } = makeRepo();
    git(repo, "checkout", "-q", "-b", "side");
    commit({ "desktop/src/renderer/shell/main.tsx": "export const shell = 7;\n" }, "side: shell edit");
    commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 7;\n" }, "side: plugin edit");
    git(repo, "checkout", "-q", "main");
    commit({ "desktop/builtin-plugins/botling.note/more.js": "module.exports = 8;\n" }, "main: plugin edit");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    expect(git(repo, "rev-list", "--merges", `${base}..HEAD`).split("\n").filter(Boolean)).toHaveLength(1); // the history does hold a merge commit
    const results = checkRange(repo, base, "HEAD");
    expect(results.map((r) => r.subject).sort()).toEqual(["main: plugin edit", "side: plugin edit", "side: shell edit"]);
    expect(results.map((r) => [r.subject, r.kind, r.problems]).sort()).toEqual([["main: plugin edit", "plugin-only", []], ["side: plugin edit", "plugin-only", []], ["side: shell edit", "other", []]]);
  });

  it("checks base → head as one change with --whole", () => {
    const { repo, commit, base } = makeRepo();
    commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 5;\n" });
    commit({ "desktop/builtin-plugins/botling.note/more.js": "module.exports = 6;\n" });
    const [whole] = checkRange(repo, base, "HEAD", { whole: true });
    expect(whole).toMatchObject({ kind: "plugin-only", problems: [] });
    commit({ [CONSTANT_FILE]: constant("3.0.0-m2") });
    expect(checkRange(repo, base, "HEAD", { whole: true })[0]).toMatchObject({ kind: "other", problems: [] });
  });
});

describe("the committed baseline", () => {
  const cli = (repo: string, ...args: string[]) => spawnSync(process.execPath, [script, "--repo", repo, ...args], { encoding: "utf8" });

  it("holds MIN_FE_VERSION only (no shell hash), and agrees with a tree whose value is as it was, also after plugin-only commits", () => {
    const { repo, commit, base } = makeRepo();
    expect(checkBaseline(repo, base)).toEqual([]);
    const plugin = commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 2;\n", "docs/notes.md": "x\n" });
    expect(checkBaseline(repo, plugin)).toEqual([]);
    const text = readFileSync(join(repo, SHELL_BASELINE_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ version: 1, shell: { minFeVersion: "3.0.0-m1" } });
    expect(parseShellBaseline(text)).toBe("3.0.0-m1");
  });

  it("leaves a shell change alone (the hash is not in the baseline), names a MIN_FE_VERSION bump without a new baseline, and accepts it once --update is committed", () => {
    const { repo, commit, base } = makeRepo();
    const shell = commit({ "desktop/src/renderer/shell/main.tsx": "export const shell = 2;\n" });
    expect(checkBaseline(repo, shell)).toEqual([]);
    expect(cli(repo, base, shell).status).toBe(0);
    const bump = commit({ [CONSTANT_FILE]: constant("3.0.0-m2") });
    expect(checkBaseline(repo, bump)).toEqual([expect.stringContaining('MIN_FE_VERSION is "3.0.0-m2"'), expect.stringContaining("--update")]);
    const failing = cli(repo, shell, bump);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("MIN_FE_VERSION changed without a new baseline");
    expect(cli(repo, "--update").status).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, SHELL_BASELINE_FILE), "utf8"))).toEqual({ version: 1, shell: { minFeVersion: "3.0.0-m2" } });
    const fixed = commit({ [SHELL_BASELINE_FILE]: readFileSync(join(repo, SHELL_BASELINE_FILE), "utf8") }, "baseline");
    expect(checkBaseline(repo, fixed)).toEqual([]);
    expect(cli(repo, bump, fixed).status).toBe(0);
  });

  it("fails closed for a missing or malformed baseline", () => {
    const { repo, commit } = makeRepo();
    const garbled = commit({ [SHELL_BASELINE_FILE]: "{ not json" });
    expect(checkBaseline(repo, garbled)).toEqual([expect.stringContaining("not a valid baseline")]);
    const odd = commit({ [SHELL_BASELINE_FILE]: JSON.stringify({ version: 1, shell: { hash: "zz" } }) });
    expect(checkBaseline(repo, odd)).toEqual([expect.stringContaining("not a valid baseline")]);
    const gone = commit({ [SHELL_BASELINE_FILE]: null });
    expect(checkBaseline(repo, gone)).toEqual([expect.stringContaining("is missing")]);
    expect(cli(repo, gone, gone).status).toBe(1);
    expect(cli(repo, "--no-baseline", gone, gone).status).toBe(0);
  });

  it("refuses --update when MIN_FE_VERSION cannot be found (a baseline with a null value is never written)", () => {
    const { repo, commit } = makeRepo();
    commit({ [CONSTANT_FILE]: "export const OTHER = 1;\n" });
    const before = readFileSync(join(repo, SHELL_BASELINE_FILE), "utf8");
    expect(cli(repo, "--update").status).toBe(2);
    expect(readFileSync(join(repo, SHELL_BASELINE_FILE), "utf8")).toBe(before);
  });
});

describe("the command line", () => {
  const run = (repo: string, ...args: string[]) => spawnSync(process.execPath, [script, "--repo", repo, ...args], { encoding: "utf8" });

  it("exits 0 for a clean range and 1, naming the commit, when a plugin-only commit moves the constant", () => {
    const { repo, commit, base } = makeRepo();
    commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 2;\n" }, "plugin edit");
    const ok = run(repo, base, "HEAD");
    expect({ status: ok.status, out: ok.stdout.trim() }).toEqual({ status: 0, out: "check-shell-version: 1 change checked, 1 plugin-only, 0 failed, baseline ok" });
    // Move the constant into a plugin source, then bump it from a plugin-only commit.
    const moved = commit({ [CONSTANT_FILE]: "export const OTHER = 1;\n", "desktop/src/renderer/plugins/settings/version.ts": constant("3.0.0-m1") }, "move");
    commit({ "desktop/src/renderer/plugins/settings/version.ts": constant("3.0.0-m2") }, "bump from a plugin");
    const bad = run(repo, "--no-baseline", moved, "HEAD");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("\"bump from a plugin\"");
    expect(bad.stderr).toContain("MIN_FE_VERSION changed");
    expect(bad.stdout).toContain("1 failed");
  });

  it("falls back to main for a base that is all zeros or empty (a new branch's `before`), and exits 2 when there is no main either", () => {
    const { repo, commit } = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    commit({ "desktop/builtin-plugins/botling.note/index.js": "module.exports = 2;\n" }, "plugin edit");
    for (const zero of ["0".repeat(40), ""]) {
      const ok = run(repo, zero, "HEAD");
      expect({ zero, status: ok.status, out: ok.stdout.trim() }).toEqual({ zero, status: 0, out: "check-shell-version: 1 change checked, 1 plugin-only, 0 failed, baseline ok" });
    }
    // A plugin-only bump on the branch is seen through the fallback too (the range is main..HEAD, not empty).
    commit({ [CONSTANT_FILE]: "export const OTHER = 1;\n", "desktop/src/renderer/plugins/settings/version.ts": constant("3.0.0-m1") }, "move the constant");
    commit({ "desktop/src/renderer/plugins/settings/version.ts": constant("3.0.0-m2") }, "bump from a plugin");
    const bad = run(repo, "--no-baseline", "0".repeat(40), "HEAD");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("\"bump from a plugin\"");
    // No local main: origin/main is used; neither: unreadable, never a silent pass.
    git(repo, "update-ref", "refs/remotes/origin/main", "main");
    git(repo, "branch", "-m", "main", "trunk");
    expect(run(repo, "--no-baseline", "0".repeat(40), "HEAD").status).toBe(1);
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    const gone = run(repo, "--no-baseline", "0".repeat(40), "HEAD");
    expect(gone.status).toBe(2);
    expect(gone.stdout).not.toContain("0 failed");
  });

  it("is an npm script, run by the \"Electron 2 checks\" job with the pull request's base or the push's before", () => {
    expect(JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).scripts["check:shell-version"]).toBe("node scripts/check-shell-version.mjs");
    const ci = readFileSync(join(desktop, "../.github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("  desktop:\n"), ci.indexOf("\n  spec:\n"));
    expect(job).toContain("name: Electron 2 checks");
    expect(job).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}");
    expect(job).toContain('npm run check:shell-version -- "${BASE_SHA:-0}" HEAD');
    expect(job).toContain("fetch-depth: 0"); // the range base..HEAD needs the history
  });

  it("exits 2 on a ref it cannot read (never a silent pass)", () => {
    const { repo } = makeRepo();
    const result = run(repo, "no-such-ref", "HEAD");
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("0 failed");
  });
});
