// shell.hash covers the non-JS files the web-v3 build ships (fix-shell-hash-assets; follow-up of the M7-10c review, "Minor"): a shell CSS-only
// change moves it, a plugin-only change still does not, and the asset list the hash uses is the one web-v3/build.mjs copies from
// (desktop/web-v3/page-assets.mjs), with a test that fails when the build reads a file the hash does not know about.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fsTree, gitTree, shellAssetPaths, shellHash, shellInputs } from "../../fe-shell-manifest.mjs";
import { PAGE_ASSETS, PAGE_BUILD_FILES } from "../../web-v3/page-assets.mjs";
import { checkChange } from "../../scripts/check-shell-version.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repos: string[] = [];
afterEach(() => { while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true }); });

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

// A repository with the web-v3 entry, a shell file, the page's assets (a few of them, CSS with @imports), a plugin's CSS and a plugin source.
const FILES: Record<string, string> = {
  "desktop/web-v3/shell/main.tsx": 'import "../../src/renderer/shell/main";\nexport const page = 1;\n',
  "desktop/src/renderer/shell/main.tsx": "export const shell = 1;\n",
  "desktop/web-v3/shell/shell.css": ".shell { color: red; }\n",
  "desktop/web-v3/index.html": "<!doctype html><title>page</title>\n",
  "desktop/web-v3/build.mjs": "// build\n",
  "desktop/mobile/web.css": ".web { margin: 0; }\n",
  "desktop/mobile/icon.svg": "<svg/>\n",
  "Web/src/tokens.css": ":root { --a: 1; }\n",
  "Web/src/chat.css": '@import "./tokens.css";\n@import "./chat/01-page.css";\n',
  "Web/src/chat/01-page.css": ".msg { padding: 1px; }\n",
  "desktop/src/renderer/styles.css": '@import "../../../Web/src/tokens.css";\n@import "./styles/01-chrome.css";\n',
  "desktop/src/renderer/styles/01-chrome.css": ".chrome { top: 0; }\n",
  "desktop/src/renderer/ModelPicker.css": ".picker { left: 0; }\n",
  "desktop/src/renderer/chat-frame/chat.html": "<!doctype html><title>chat</title>\n",
  "desktop/builtin-plugins/botling.board/src/board.css": ".board { gap: 1px; }\n",
  "desktop/builtin-plugins/botling.board/src/web.ts": "export const board = 1;\n",
  "docs/notes.md": "# notes\n",
};

function makeRepo() {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "botling-shell-assets-")));
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
  const base = commit(FILES, "base");
  return { repo, commit, base, hashAt: (ref: string) => shellHash(gitTree(repo, ref), shellInputs(repo)) };
}

describe("the shell hash covers the assets the page ships", () => {
  it("lists the assets, their @imported partials and the build files, but not plugin files or docs", () => {
    const { repo } = makeRepo();
    const files = shellInputs(repo);
    for (const path of ["desktop/web-v3/shell/shell.css", "desktop/web-v3/index.html", "desktop/web-v3/build.mjs", "desktop/mobile/web.css", "desktop/mobile/icon.svg",
      "Web/src/tokens.css", "Web/src/chat.css", "Web/src/chat/01-page.css", "desktop/src/renderer/styles.css", "desktop/src/renderer/styles/01-chrome.css",
      "desktop/src/renderer/ModelPicker.css", "desktop/src/renderer/chat-frame/chat.html", "desktop/web-v3/shell/main.tsx", "desktop/src/renderer/shell/main.tsx"]) expect(files, path).toContain(path);
    for (const path of ["desktop/builtin-plugins/botling.board/src/board.css", "desktop/builtin-plugins/botling.board/src/web.ts", "docs/notes.md"]) expect(files, path).not.toContain(path);
    expect(shellAssetPaths(repo)).toEqual(files.filter((path) => !/\.tsx?$/.test(path)));
  });

  it("is moved by a shell CSS-only change, by an @imported partial, by a page or a build file", () => {
    const { repo, commit, base, hashAt } = makeRepo();
    const first = hashAt(base);
    const seen = new Set([first]);
    for (const change of <Record<string, string>[]>[
      { "desktop/web-v3/shell/shell.css": ".shell { color: blue; }\n" },
      { "Web/src/tokens.css": ":root { --a: 2; }\n" },
      { "Web/src/chat/01-page.css": ".msg { padding: 2px; }\n" }, // reached only through `@import` in chat.css
      { "desktop/src/renderer/styles/01-chrome.css": ".chrome { top: 1px; }\n" },
      { "desktop/src/renderer/ModelPicker.css": ".picker { left: 1px; }\n" }, // appended to styles.css by the build
      { "desktop/mobile/web.css": ".web { margin: 1px; }\n" },
      { "desktop/web-v3/index.html": "<!doctype html><title>page 2</title>\n" },
      { "desktop/src/renderer/chat-frame/chat.html": "<!doctype html><title>chat 2</title>\n" },
      { "desktop/mobile/icon.svg": "<svg width=\"1\"/>\n" },
      { "desktop/web-v3/build.mjs": "// build 2\n" },
    ]) {
      const [path] = Object.keys(change);
      const hash = hashAt(commit(change, path));
      expect(hash, path).not.toBe(first);
      expect(seen.has(hash), path).toBe(false); // each change gives a hash of its own
      seen.add(hash);
      commit({ [path]: FILES[path] }, `revert ${path}`); // content-based: the original bytes give the original hash
      expect(hashAt("HEAD"), `revert ${path}`).toBe(first);
    }
  });

  it("is not moved by a plugin-only change (plugin CSS, plugin source, tests, docs), and the plugin-only check passes it", () => {
    const { repo, commit, base, hashAt } = makeRepo();
    const plugin = commit({ "desktop/builtin-plugins/botling.board/src/board.css": ".board { gap: 9px; }\n", "desktop/builtin-plugins/botling.board/src/web.ts": "export const board = 2;\n",
      "desktop/test/unit/x.test.ts": "x\n", "docs/notes.md": "more\n" });
    expect(hashAt(plugin)).toBe(hashAt(base));
    const verdict = checkChange(repo, base, plugin, ["desktop/builtin-plugins/botling.board/src/board.css", "desktop/builtin-plugins/botling.board/src/web.ts"]);
    expect(verdict).toEqual({ kind: "plugin-only", problems: [] });
  });

  it("fails the plugin-only check for a commit that touches a plugin file and a shell stylesheet", () => {
    const { repo, commit, base } = makeRepo();
    const mixed = commit({ "desktop/builtin-plugins/botling.board/src/board.css": ".board { gap: 9px; }\n", "desktop/web-v3/shell/shell.css": ".shell { color: green; }\n" });
    // Classified "other" (it touches a shell file), so it may move the hash; but a "plugin-only" claim over the same files must fail the hash rule.
    const claim = checkChange(repo, base, mixed, ["desktop/builtin-plugins/botling.board/src/board.css"]);
    expect(claim.kind).toBe("plugin-only");
    expect(claim.problems.join("\n")).toMatch(/shell hash changed/);
  });
});

describe("the hash is deterministic", () => {
  it("lists sorted, unique repo-relative paths whatever the order the files were written in", () => {
    const one = makeRepo();
    const two = (() => {
      const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "botling-shell-assets-")));
      repos.push(repo);
      for (const [path, text] of Object.entries(FILES).reverse()) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
      return repo;
    })();
    const files = shellInputs(one.repo);
    expect(files).toEqual([...new Set(files)].sort());
    expect(files.filter((path) => path.startsWith("/") || path.startsWith("../") || path.includes("\\") || path.includes("node_modules"))).toEqual([]);
    expect(shellInputs(two)).toEqual(files);
    expect(shellAssetPaths(two)).toEqual(shellAssetPaths(one.repo));
    expect(shellHash(fsTree(two), shellInputs(two))).toBe(shellHash(fsTree(one.repo), files));
  });

  it("gives the same hash from a commit and from the working tree, and whatever the order of the list", () => {
    const { repo, base } = makeRepo();
    const files = shellInputs(repo);
    const fromGit = shellHash(gitTree(repo, base), files);
    expect(shellHash(fsTree(repo), files)).toBe(fromGit);
    expect(shellHash(fsTree(repo), [...files].reverse())).toBe(fromGit);
    expect(shellHash(gitTree(repo, base), [...files].reverse())).toBe(fromGit);
  });
});

describe("the asset list and what web-v3/build.mjs copies stay equal", () => {
  it("has every asset in the list under a published name, from a repo path, and no name twice", () => {
    const names = PAGE_ASSETS.map((asset: { to: string }) => asset.to);
    expect(new Set(names).size).toBe(names.length);
    for (const asset of PAGE_ASSETS as { from: string; to: string; append?: string }[]) {
      expect(asset.from, asset.to).toMatch(/^(?:desktop|Web)\//);
      expect(asset.from, asset.to).not.toMatch(/node_modules|builtin-plugins|\.\./);
    }
    for (const file of PAGE_BUILD_FILES as string[]) expect(file).toMatch(/^desktop\/(?:web-v3\/|fe-)/);
  });

  it("is every non-code file the real build read, less plugin sources and node_modules (a hand-written asset(...) in build.mjs fails this)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "botling-v3-assets-")), "dist");
    repos.push(dirname(out));
    const { buildPage } = await import(join(desktop, "web-v3/build.mjs"));
    await buildPage({ out, development: true });
    const repo = realpathSync.native(join(desktop, ".."));
    const record = JSON.parse(readFileSync(`${out}.inputs.json`, "utf8")) as { inputs: string[]; sources: string[] };
    const rel = (path: string) => relative(repo, realpathSync.native(resolve(path))).split(sep).join("/");
    const code = new Set(record.inputs.filter((input) => !input.startsWith("<")).map(rel)); // what esbuild bundled
    const read = record.sources.map((source) => relative(repo, source).split(sep).join("/"))
      .filter((path) => !path.startsWith("..") && !path.includes("node_modules") && !/^desktop\/(?:builtin-plugins|src\/renderer\/plugins)\//.test(path)).sort();
    // Everything the build read that the hash is made of: the JS esbuild bundled (its metafile) plus the asset list; nothing is left out, nothing is extra.
    expect(shellInputs(repo)).toEqual(read);
    // The part that is not code is exactly the asset list (the assets, the partials they @import, the build files).
    expect(shellAssetPaths(repo)).toEqual(read.filter((path) => !code.has(path)));
  }, 120_000);
});
