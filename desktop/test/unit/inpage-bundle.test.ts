// What the FE build bundles for the in-page loader (M7-10a fix): the manifest is written INTO the bundle (the desktop
// window's CSP is connect-src 'none', so it cannot fetch the file); the bundled-module map reaches exactly the folders the
// manifest lists; and web-v3/build.mjs writes the manifest too.
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FE_MANIFEST_FILE, feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { shellAssetPaths, shellInputs } from "../../fe-shell-manifest.mjs";
import { feManifestDefine } from "../../fe-manifest-define.mjs";
import { bundledInPagePlugin } from "../../src/renderer/shell/inpage-bundled";
import { embeddedFeManifest, parseFeManifest } from "../../src/renderer/shell/inpage-loader";

const desktop = join(__dirname, "../..");
// A fake root has no repo above it: M7-10b's `feBuildManifestFile(root, repoRoot)` needs the fake root as its repo root too (ignored before 10b).
const manifestOf = (root: string) => (feBuildManifestFile as (root: string, repoRoot?: string) => Buffer)(root, root);
const roots: string[] = [];
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir; };
afterEach(() => { delete (globalThis as { __evaluated?: string[] }).__evaluated; while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function put(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** A scratch build root: the real loader and bundled map, plus plugin folders that each record when they are evaluated. */
function scratch(folders: string[]) {
  const root = temp("botling-inpage-bundle-");
  mkdirSync(join(root, "src/renderer/plugins"), { recursive: true });
  for (const file of ["inpage-bundled.ts", "inpage-loader.ts"]) put(root, `src/renderer/shell/${file}`, readFileSync(join(desktop, "src/renderer/shell", file), "utf8"));
  for (const folder of folders) put(root, `src/renderer/plugins/${folder}`, `(globalThis as any).__evaluated = [...((globalThis as any).__evaluated ?? []), ${JSON.stringify(folder)}];\nexport const activate = () => {};\n`);
  put(root, "entry.ts", 'export { bundledInPagePlugin } from "./src/renderer/shell/inpage-bundled";\nexport { embeddedFeManifest } from "./src/renderer/shell/inpage-loader";\n');
  return root;
}

async function bundle(root: string, define: Record<string, string> = {}) {
  const outfile = join(root, "out.cjs");
  await build({ entryPoints: [join(root, "entry.ts")], outfile, bundle: true, platform: "node", format: "cjs", define, logLevel: "silent" });
  return createRequire(outfile)(outfile) as { bundledInPagePlugin(name: string): Promise<{ activate(): unknown } | undefined>; embeddedFeManifest(): ReturnType<typeof embeddedFeManifest> };
}

describe("the manifest inside the bundle", () => {
  it("is empty where it was not defined, and where the defined text is not a manifest", async () => {
    expect(embeddedFeManifest()).toEqual({ plugins: [] });
    const root = scratch([]);
    expect((await bundle(root)).embeddedFeManifest()).toEqual({ plugins: [] });
    expect((await bundle(root, { __FE_MANIFEST__: JSON.stringify("{not json") })).embeddedFeManifest()).toEqual({ plugins: [] });
  });

  it("is the list the manifest file holds: the build's define carries the file's bytes", async () => {
    const root = scratch(["chat/index.ts", "settings/index.ts", "settings/pages/general.ts"]);
    const file = manifestOf(root);
    const written = JSON.parse(file.toString("utf8"));
    expect(written.plugins.map((p: { name: string }) => p.name)).toEqual(["botling.chat", "botling.settings"]);
    const built = await bundle(root, feManifestDefine(file));
    expect(built.embeddedFeManifest()).toEqual(parseFeManifest(written));
    expect(built.embeddedFeManifest().plugins).toEqual(written.plugins);
  });

  it("is passed by both renderer builds, from the same bytes they write", () => {
    for (const file of ["build-renderer.mjs", "web-v3/build.mjs"]) {
      const text = readFileSync(join(desktop, file), "utf8");
      expect(text, file).toMatch(/feManifestDefine\(feManifest/);
      expect(text, file).toMatch(/FE_MANIFEST_FILE/);
    }
  });
});

describe("the bundled-module map", () => {
  it("has its plugins folder in the repo (esbuild's glob import fails when the folder is missing, only warns when it is empty)", async () => {
    expect(readFileSync(join(desktop, "src/renderer/plugins/README.md"), "utf8")).toContain("index.ts");
    // A scratch root WITHOUT the folder cannot be bundled: this is why the README is committed.
    const root = scratch([]);
    rmSync(join(root, "src/renderer/plugins"), { recursive: true });
    await expect(bundle(root)).rejects.toThrow(/Could not resolve/);
  });

  it("returns undefined for a bad name without importing anything", async () => {
    for (const name of ["botling.a/../b", "botling.Bad", "x", "botling.", "botling.a/b", "botling.a.b", "../botling.a", "botling.-x", "constructor", "", "botling.a\nb"]) {
      expect(await bundledInPagePlugin(name), JSON.stringify(name)).toBeUndefined();
    }
    const root = scratch(["a/index.ts"]);
    const built = await bundle(root);
    for (const name of ["botling.a/../b", "botling.Bad", "x", "botling.a/b", "botling.a.b", "botling.", "botling.A"]) expect(await built.bundledInPagePlugin(name)).toBeUndefined();
    expect((globalThis as { __evaluated?: string[] }).__evaluated ?? []).toEqual([]);
  });

  it("reaches exactly the folders the manifest lists, though the glob also bundles nested and upper-case ones", async () => {
    const root = scratch(["a/index.ts", "a/b/index.ts", "Bad/index.ts", "c/index.ts", "no-index/other.ts"]);
    const listed = JSON.parse(manifestOf(root).toString("utf8")).plugins.map((p: { name: string }) => p.name);
    expect(listed).toEqual(["botling.a", "botling.c"]);
    const built = await bundle(root);
    // The bundle does hold the nested and upper-case modules (esbuild's glob is wider)...
    expect(readFileSync(join(root, "out.cjs"), "utf8")).toMatch(/plugins\/Bad\/index\.ts/);
    expect(readFileSync(join(root, "out.cjs"), "utf8")).toMatch(/plugins\/a\/b\/index\.ts/);
    // ...but no name reaches them: the loader finds a module for a listed name and for nothing else, and nothing else is evaluated.
    const candidates = ["botling.a", "botling.c", "botling.Bad", "botling.bad", "botling.b", "botling.a/b", "botling.a/b/index", "botling.no-index", "botling.Bad/index.ts"];
    const reached: string[] = [];
    for (const name of candidates) { try { if (await built.bundledInPagePlugin(name)) reached.push(name); } catch { /* a bundled-less folder rejects: not reached */ } }
    expect(reached).toEqual(listed);
    expect((globalThis as { __evaluated?: string[] }).__evaluated ?? []).toEqual(["a/index.ts", "c/index.ts"]); // only the listed ones ran
  });
});

describe("web-v3/build.mjs", () => {
  it("writes fe-build-manifest.json (the file the shell bundle was built with) and lists the generator in sources", async () => {
    const out = join(temp("botling-v3-build-"), "dist");
    const { buildPage } = await import(join(desktop, "web-v3/build.mjs"));
    await buildPage({ out, development: true });
    const written = readFileSync(join(out, FE_MANIFEST_FILE), "utf8");
    expect(JSON.parse(written).plugins).toEqual(JSON.parse(feBuildManifestFile(desktop).toString("utf8")).plugins);
    const record = JSON.parse(readFileSync(`${out}.inputs.json`, "utf8")) as { sources: string[] };
    expect(record.sources).toContain(join(desktop, "fe-build-manifest.mjs"));
    // M7-10c: shell.hash covers the files the build itself read (its `inputs`, relative to the build's cwd), less plugin sources:
    // the entry list the hash is taken from cannot drift from the build's.
    const repo = realpathSync.native(join(desktop, ".."));
    const read = (JSON.parse(readFileSync(`${out}.inputs.json`, "utf8")) as { inputs: string[] }).inputs
      .filter((input) => !input.startsWith("<")).map((input) => relative(repo, realpathSync.native(resolve(input))).split(sep).join("/"))
      .filter((path) => !path.startsWith("..") && !path.includes("node_modules") && !/^desktop\/(?:builtin-plugins|src\/renderer\/plugins)\//.test(path)).sort();
    // The hash covers exactly the code the build read plus the non-code assets (their own list is checked by shell-hash-assets.test.ts):
    // a plugin source leaking in, or a code file dropped, fails here.
    expect(shellInputs(repo)).toEqual([...new Set([...read, ...shellAssetPaths(repo)])].sort());
  }, 120_000);
});
