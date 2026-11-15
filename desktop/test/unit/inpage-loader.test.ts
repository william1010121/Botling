// The FE build's manifest and the shell's in-page loader (M7-10a; plan-change D56, C14, check 7): code runs in the page
// only when its name and folder hash are in fe-build-manifest.json; anything else (an unlisted plugin, a built-in a bot
// edited) is refused, logged, never evaluated, and offered to the frame host.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FE_MANIFEST_FILE, feBuildManifest, feBuildManifestFile, folderHash, inpagePluginFolders } from "../../fe-build-manifest.mjs";
import { folderHash as catalogFolderHash } from "../../src/core/plugins/catalog";
import { EMPTY_FE_MANIFEST, fetchFeManifest, InPageLoader, parseFeManifest, type InPageModule } from "../../src/renderer/shell/inpage-loader";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

/** A fake build root with src/renderer/plugins/<folder>/... files. */
function fakeRoot(plugins: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "botling-fe-manifest-"));
  roots.push(root);
  for (const [folder, files] of Object.entries(plugins)) {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, "src/renderer/plugins", folder, file, ".."), { recursive: true });
      writeFileSync(join(root, "src/renderer/plugins", folder, file), text);
    }
  }
  return root;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function loader(entries: { name: string; codeHash: string }[], modules: Record<string, InPageModule> = {}) {
  const logs: string[] = [];
  const offered: [string, string][] = [];
  const source = vi.fn(async (name: string) => (Object.hasOwn(modules, name) ? modules[name] : undefined));
  const made = new InPageLoader({ manifest: { plugins: entries }, source, offerToFrame: (name, hash) => { offered.push([name, hash]); }, log: (line) => logs.push(line), api: "the-api" });
  return { made, logs, offered, source };
}

describe("the manifest the build writes", () => {
  it("is built from the folders of src/renderer/plugins, sorted, with each whole folder's hash", () => {
    const root = fakeRoot({
      settings: { "index.ts": "export const activate = () => {};\n", "pages/general.ts": "export const g = 1;\n" },
      chat: { "index.ts": "export const activate = () => {};\n" },
      "not-a-plugin": { "notes.txt": "no index.ts here" },
    });
    const manifest = feBuildManifest(root);
    expect(manifest.version).toBe(1);
    expect(manifest.plugins.map((plugin) => plugin.name)).toEqual(["botling.chat", "botling.settings"]);
    for (const { name, codeHash } of manifest.plugins) expect(codeHash).toMatch(/^[0-9a-f]{64}$/), expect(name).toMatch(/^botling\./);
    const folders = inpagePluginFolders(root);
    expect(folders.map((f) => f.name)).toEqual(["botling.chat", "botling.settings"]);
    // The catalog's rule: the same folder hashes to the same value there (C14), nested files included.
    expect(manifest.plugins[1]!.codeHash).toBe(catalogFolderHash(folders[1]!.folder));
    expect(manifest.plugins[1]!.codeHash).toBe(folderHash(folders[1]!.folder));
  });

  it("gains a plugin by adding its folder only, and loses it by removing the folder", () => {
    const root = fakeRoot({ chat: { "index.ts": "a" } });
    expect(feBuildManifest(root).plugins.map((p) => p.name)).toEqual(["botling.chat"]);
    mkdirSync(join(root, "src/renderer/plugins/sidebar"), { recursive: true });
    writeFileSync(join(root, "src/renderer/plugins/sidebar/index.ts"), "b");
    expect(feBuildManifest(root).plugins.map((p) => p.name)).toEqual(["botling.chat", "botling.sidebar"]);
    rmSync(join(root, "src/renderer/plugins/chat"), { recursive: true });
    expect(feBuildManifest(root).plugins.map((p) => p.name)).toEqual(["botling.sidebar"]);
  });

  it("is empty with no plugin folder, and one byte in any file of a folder changes that folder's hash only", () => {
    expect(feBuildManifest(mkdtempSync(join(tmpdir(), "botling-fe-empty-"))).plugins).toEqual([]);
    const root = fakeRoot({ settings: { "index.ts": "same", "deep/more.ts": "one" }, chat: { "index.ts": "other" } });
    const before = feBuildManifest(root).plugins;
    writeFileSync(join(root, "src/renderer/plugins/settings/deep/more.ts"), "onf");
    const after = feBuildManifest(root).plugins;
    expect(after.find((p) => p.name === "botling.settings")!.codeHash).not.toBe(before.find((p) => p.name === "botling.settings")!.codeHash);
    expect(after.find((p) => p.name === "botling.chat")!.codeHash).toBe(before.find((p) => p.name === "botling.chat")!.codeHash);
    // The fake root has no shell files (M7-10b adds the `shell` part; test/unit/shell-version-check.test.ts covers it): its repo root is the fake root itself.
    expect(JSON.parse(feBuildManifestFile(root, root).toString())).toEqual({ version: 1, shell: { minFeVersion: null, hash: expect.stringMatching(/^[0-9a-f]{64}$/) }, plugins: after });
  });

  it("is written by the renderer build next to the page (and the loader reads what the build wrote)", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "botling-fe-build-"));
    roots.push(outdir);
    const { buildRenderer } = await import(join(__dirname, "../../build-renderer.mjs"));
    await buildRenderer({ outdir, development: true });
    const written = JSON.parse(readFileSync(join(outdir, FE_MANIFEST_FILE), "utf8"));
    expect(parseFeManifest(written)).toEqual({ plugins: written.plugins });
    expect(Array.isArray(written.plugins)).toBe(true);
  }, 120_000);
});

describe("parsing the manifest (fails closed)", () => {
  it("lists nothing for anything that is not a manifest, and drops malformed entries", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { plugins: "x" }, { plugins: { name: "botling.chat" } }]) expect(parseFeManifest(bad)).toEqual(EMPTY_FE_MANIFEST);
    const parsed = parseFeManifest({ plugins: [
      { name: "botling.chat", codeHash: HASH_A },
      { name: "botling.short", codeHash: "abc" },
      { name: "Bad Name", codeHash: HASH_A },
      { name: 4, codeHash: HASH_A },
      { name: "botling.upper", codeHash: "A".repeat(64) },
      null, 7,
    ] });
    expect(parsed.plugins).toEqual([{ name: "botling.chat", codeHash: HASH_A }]);
  });

  it("gives the empty manifest when it cannot be fetched, read or parsed", async () => {
    expect(await fetchFeManifest("x", (async () => { throw new Error("offline"); }) as typeof fetch)).toEqual(EMPTY_FE_MANIFEST);
    expect(await fetchFeManifest("x", (async () => new Response(JSON.stringify({ plugins: [{ name: "botling.chat", codeHash: HASH_A }] }), { status: 404 })) as typeof fetch)).toEqual(EMPTY_FE_MANIFEST);
    expect(await fetchFeManifest("x", (async () => new Response("{not json")) as typeof fetch)).toEqual(EMPTY_FE_MANIFEST);
    const ok = await fetchFeManifest("x", (async () => new Response(JSON.stringify({ version: 1, plugins: [{ name: "botling.chat", codeHash: HASH_A }] }))) as typeof fetch);
    expect(ok.plugins).toEqual([{ name: "botling.chat", codeHash: HASH_A }]);
  });
});

describe("the in-page loader", () => {
  it("loads a listed name and hash in the page, with the api, and keeps its disposer", async () => {
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    const { made, offered, logs } = loader([{ name: "botling.settings", codeHash: HASH_A }], { "botling.settings": { activate } });
    expect(await made.load("botling.settings", HASH_A)).toEqual({ status: "loaded", name: "botling.settings", codeHash: HASH_A });
    expect(activate).toHaveBeenCalledWith("the-api");
    expect(made.loaded()).toEqual([{ name: "botling.settings", codeHash: HASH_A }]);
    expect(offered).toEqual([]);
    expect(logs).toEqual([]);
    expect(made.unload("botling.settings")).toBe(true);
    expect(made.unload("botling.settings")).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses an unlisted plugin: logged, its code never fetched or run, offered to the frame host", async () => {
    const activate = vi.fn();
    const { made, offered, logs, source } = loader([{ name: "botling.settings", codeHash: HASH_A }], { "botling.evil": { activate } });
    const result = await made.load("botling.evil", HASH_A);
    expect(result).toEqual({ status: "refused", name: "botling.evil", codeHash: HASH_A, reason: "not-in-manifest", offered: true });
    expect(source).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(offered).toEqual([["botling.evil", HASH_A]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"botling.evil"');
    expect(made.loaded()).toEqual([]);
  });

  it("refuses a built-in whose code changed by one byte and offers it to the frame host (check 7)", async () => {
    const root = fakeRoot({ settings: { "index.ts": "export const activate = () => {};\n", "page.ts": "const x = 1;\n" } });
    const shipped = feBuildManifest(root);
    const folder = inpagePluginFolders(root)[0]!.folder;
    writeFileSync(join(folder, "page.ts"), "const x = 2;\n"); // a bot edited one byte
    const editedHash = folderHash(folder);
    expect(editedHash).not.toBe(shipped.plugins[0]!.codeHash);
    const activate = vi.fn();
    const { made, offered } = loader(shipped.plugins, { "botling.settings": { activate } });
    expect(await made.load("botling.settings", editedHash)).toEqual({ status: "refused", name: "botling.settings", codeHash: editedHash, reason: "hash-changed", offered: true });
    expect(activate).not.toHaveBeenCalled();
    expect(offered).toEqual([["botling.settings", editedHash]]);
    // The shipped bytes still load.
    writeFileSync(join(folder, "page.ts"), "const x = 1;\n");
    expect((await made.load("botling.settings", folderHash(folder))).status).toBe("loaded");
  });

  it("refuses everything when the manifest is empty (a failed fetch lists nothing)", async () => {
    const activate = vi.fn();
    const { made, offered } = loader([], { "botling.chat": { activate } });
    expect((await made.load("botling.chat", HASH_A)).status).toBe("refused");
    expect(activate).not.toHaveBeenCalled();
    expect(offered).toEqual([["botling.chat", HASH_A]]);
  });

  it("matches the pair exactly: a listed hash under another name, and a listed name under another hash, are refused", async () => {
    const { made } = loader([{ name: "botling.chat", codeHash: HASH_A }, { name: "botling.settings", codeHash: HASH_B }], { "botling.chat": { activate: () => {} }, "botling.settings": { activate: () => {} } });
    expect((await made.load("botling.chat", HASH_B)).status).toBe("refused");
    expect((await made.load("botling.settings", HASH_A)).status).toBe("refused");
    expect((await made.load("botling.chat", HASH_A)).status).toBe("loaded");
  });

  it("re-checks on every load: a changed hash undoes the running copy and leaves it undone", async () => {
    const dispose = vi.fn();
    const { made, offered } = loader([{ name: "botling.chat", codeHash: HASH_A }], { "botling.chat": { activate: () => dispose } });
    expect((await made.load("botling.chat", HASH_A)).status).toBe("loaded");
    expect((await made.load("botling.chat", HASH_B)).status).toBe("refused");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(made.loaded()).toEqual([]);
    expect(offered).toEqual([["botling.chat", HASH_B]]);
    expect((await made.load("botling.chat", HASH_A)).status).toBe("loaded");
    expect(made.loaded()).toEqual([{ name: "botling.chat", codeHash: HASH_A }]);
  });

  it("runs two loads of one name one after the other (a double call never activates twice at once)", async () => {
    let active = 0, peak = 0;
    const activate = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return () => {}; });
    const { made } = loader([{ name: "botling.chat", codeHash: HASH_A }], { "botling.chat": { activate } });
    await Promise.all([made.load("botling.chat", HASH_A), made.load("botling.chat", HASH_A)]);
    expect(peak).toBe(1);
    expect(made.loaded()).toHaveLength(1);
  });

  it("contains a plugin that throws, or has no bundled module, and keeps the others", async () => {
    const { made, logs } = loader(
      [{ name: "botling.chat", codeHash: HASH_A }, { name: "botling.settings", codeHash: HASH_A }, { name: "botling.board", codeHash: HASH_A }],
      { "botling.chat": { activate: () => { throw new Error("boom\nsecond line"); } }, "botling.settings": { activate: () => {} } });
    expect((await made.load("botling.chat", HASH_A)).status).toBe("failed");
    expect((await made.load("botling.board", HASH_A)).status).toBe("failed");
    expect((await made.load("botling.settings", HASH_A)).status).toBe("loaded");
    expect(made.loaded().map((p) => p.name)).toEqual(["botling.settings"]);
    expect(logs).toHaveLength(2);
    for (const line of logs) expect(line).not.toContain("\n");
  });

  it("refuses malformed names and hashes without offering them", async () => {
    const { made, offered, source } = loader([{ name: "botling.chat", codeHash: HASH_A }]);
    for (const name of ["", "../x", "botling chat", "Bad", "a".repeat(65)]) expect((await made.load(name, HASH_A)).status).toBe("refused");
    for (const hash of ["not-a-hash", "A".repeat(64), "", HASH_A + "0"]) expect(await made.load("botling.chat", hash)).toMatchObject({ status: "refused", reason: "bad-request", offered: false });
    expect(offered).toEqual([]);
    expect(source).not.toHaveBeenCalled();
  });

  it("treats names that look like object keys as plain unlisted names (a Map, never obj[key])", async () => {
    const { made, offered, source } = loader([{ name: "botling.chat", codeHash: HASH_A }]);
    expect(await made.load("constructor", HASH_A)).toMatchObject({ status: "refused", reason: "not-in-manifest", offered: true });
    for (const name of ["__proto__", "toString", "hasOwnProperty"]) expect(await made.load(name, HASH_A)).toMatchObject({ status: "refused", reason: "bad-request" });
    expect(offered).toEqual([["constructor", HASH_A]]);
    expect(source).not.toHaveBeenCalled();
  });

  it("logs a hostile name as one escaped line", async () => {
    const { made, logs } = loader([]);
    await made.load("botling.x\u001b[31m\nINJECTED", HASH_A);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/[\u0000-\u001f]/);
  });

  it("still returns a refusal when the frame host throws", async () => {
    const logs: string[] = [];
    const made = new InPageLoader({ manifest: EMPTY_FE_MANIFEST, source: () => undefined, offerToFrame: () => { throw new Error("no host"); }, log: (l) => logs.push(l) });
    expect(await made.load("botling.chat", HASH_A)).toMatchObject({ status: "refused", offered: false });
    expect(logs).toHaveLength(2);
  });
});

describe("no eval", () => {
  it("the loader and the bundled-module map contain no eval, Function constructor or script injection", () => {
    for (const file of ["src/renderer/shell/inpage-loader.ts", "src/renderer/shell/inpage-bundled.ts"]) {
      const text = readFileSync(join(__dirname, "../..", file), "utf8").replace(/\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(|createElement\(\s*["']script|importScripts|blob:/);
    }
  });

  it("loads a listed plugin with eval and the Function constructor disabled", async () => {
    const realEval = globalThis.eval;
    const guard = vi.fn(() => { throw new Error("eval is off"); });
    (globalThis as { eval: unknown }).eval = guard;
    try {
      const { made } = loader([{ name: "botling.chat", codeHash: HASH_A }], { "botling.chat": { activate: () => {} } });
      expect((await made.load("botling.chat", HASH_A)).status).toBe("loaded");
      expect((await made.load("botling.other", HASH_A)).status).toBe("refused");
    } finally { (globalThis as { eval: unknown }).eval = realEval; }
    expect(guard).not.toHaveBeenCalled();
  });
});
