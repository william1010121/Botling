// The one-click plugin Update (core/plugin-store.ts `direct`, maintainer.ts `installNow`, plugins/registry.ts `revisions`,
// plugins/asks-growth.ts, renderer/plugin-stamp.ts). Real folders in a temp dir, the core's registry, store and desk, and
// the server's row reconcile on an in-memory server.db; the catalog is a fake fetch serving real (crafted) tarballs. No app,
// no network, no git (BOTLING_GIT_PATH points nowhere, as plugin-catalog.test.ts).
//
// What it shows: a newer catalog version is an update offer for an installed and for a built-in plugin; the Update button
// (direct) swaps the code in the library with no install card and keeps the grant when the new version asks for no more;
// asking more (a permission, a program part) still goes to the card, which names what is new; a built-in's update keeps the
// built-in's rights only while its files are what the catalog check verified; Remove puts the built-in back.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../helpers";
import { folderHash, OFFICIAL_INDEX_URL, type Fetch } from "../../src/core/plugins/catalog";
import { askFactsOf, askGrowth } from "../../src/core/plugins/asks-growth";
import { PluginStore } from "../../src/core/plugin-store";
import { MaintainerDesk } from "../../src/core/maintainer";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { ComponentLibrary } from "../../src/core/components/library";
import { PluginRow, type PluginGrant } from "../../src/protocol/table-rows";
import { mayRunPluginServerPart } from "../../src/server/botlingd";
import { installedFromRegistry, reconcilePluginRows } from "../../src/server/replica/plugin-rows";
import { ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import { frameNeedsReload, pluginStamp } from "../../src/renderer/plugin-stamp";
import { memoryStore } from "./server-slots-harness";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------
// A small tar writer (ustar, as git archive writes them; names stay under 100 bytes) and the catalog's folder hash, written out again.

function header(name: string, size: number, type: string, mode = 0o644): Buffer {
  const block = Buffer.alloc(512);
  const put = (text: string, at: number, length: number) => block.write(text.slice(0, length), at, length, "utf8");
  put(name, 0, 100);
  put(mode.toString(8).padStart(7, "0"), 100, 8);
  put("0000000", 108, 8); put("0000000", 116, 8);
  put(size.toString(8).padStart(11, "0"), 124, 12);
  put("00000000000", 136, 12);
  block.fill(0x20, 148, 156);
  put(type, 156, 1);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(sum.toString(8).padStart(6, "0") + "\u0000 ", 148, 8);
  return block;
}
function tarballOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [header("botling-plugins-abc/", 0, "5", 0o755)];
  const folders = new Set<string>(["demo"]);
  for (const path of Object.keys(files)) for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) folders.add(`demo/${path.slice(0, at)}`);
  for (const folder of [...folders].sort()) parts.push(header(`botling-plugins-abc/${folder}/`, 0, "5", 0o755));
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    parts.push(header(`botling-plugins-abc/demo/${path}`, data.length, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
function expectedHash(files: Record<string, string>): string {
  const sha = (data: string) => createHash("sha256").update(data).digest("hex");
  return sha(Object.keys(files).sort().map((path) => `${path}\0${sha(files[path]!)}\n`).join(""));
}

interface Spec { permissions: string[]; host: boolean; claude?: boolean }

/** The demo plugin's folder at `version`: a web part, and (with `host`) a program part whose code says the version. */
function demoFiles(version: string, spec: Spec): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "demo", displayName: "Demo", version, description: "A demo.", license: "MIT", engines: { ccb: "^2.0.0" },
      ccb: { permissions: spec.permissions, web: "dist/web.js", ...(spec.host ? { host: "dist/host.mjs" } : {}), ...(spec.claude ? { claude: "claude" } : {}) },
    }, null, 2),
    "dist/web.js": `export const version = "${version}";\n`,
    ...(spec.host ? { "dist/host.mjs": `export function activate() { return "${version}"; }\n` } : {}),
    ...(spec.claude ? { "claude/.claude-plugin/plugin.json": JSON.stringify({ name: "demo" }) } : {}),
  };
}
function entryOf(version: string, files: Record<string, string>, commit: string, spec: Spec): Record<string, unknown> {
  return {
    name: "demo", displayName: "Demo", description: "A demo.", version, license: "MIT", permissions: spec.permissions, engines: { ccb: "^2.0.0" },
    minAppVersion: "2.0.0", parts: [], path: "demo", files: Object.keys(files).length, size: 0, sha256: expectedHash(files), commit,
  };
}
function writeFolder(folder: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
}
function fakeFetch(routes: Record<string, string | Buffer>): Fetch {
  return (async (url: string) => {
    const route = routes[url];
    return route === undefined ? new Response("not found", { status: 404 }) : new Response(typeof route === "string" ? route : new Uint8Array(route), { status: 200 });
  }) as unknown as Fetch;
}

const C1 = "1".repeat(40), C2 = "2".repeat(40);
const tarball = (commit: string) => `https://codeload.github.com/william1010121/botling-plugins/tar.gz/${commit}`;
const WRITE: Omit<PluginGrant, "at" | "grantedBy"> = { tier: "write", reads: [], requests: [] };

/** The core's registry, store and desk over a temp folder; `builtIn` v1 (when given) ships with the app, else nothing does. */
function setup(from: Spec, to: Spec, options: { builtIn?: boolean } = {}) {
  const root = tempDir("plugin-update");
  dirs.push(root);
  mkdirSync(join(root, "plugins"), { recursive: true });
  const v1 = demoFiles("1.0.0", from), v2 = demoFiles("1.1.0", to);
  let builtIns: string | null = null;
  if (options.builtIn) {
    builtIns = join(root, "app-plugins");
    writeFolder(join(builtIns, "demo"), v1);
  }
  const notices: { text: string; choices?: { label: string }[]; answer?: (index: number) => void }[] = [];
  const main = { id: "MAIN", profile: { name: "Main bot" }, appNotice(text: string, choices?: { label: string }[], answer?: (index: number) => void) { notices.push({ text, choices, answer }); return "n"; } };
  const registry = new PluginRegistry(join(root, "plugins"), join(root, "plugins.json"), new MemorySecretStore(), builtIns);
  const desk = new MaintainerDesk({ root, maintainer: () => null, mainBot: () => main as never, bots: () => [], library: new ComponentLibrary(() => []), plugins: () => ({ registry }) as never, log: () => {} });
  const routes: Record<string, string | Buffer> = {
    [OFFICIAL_INDEX_URL]: JSON.stringify({ schema: 1, plugins: [entryOf("1.0.0", v1, C1, from)] }),
    [tarball(C1)]: tarballOf(v1),
    [tarball(C2)]: tarballOf(v2),
  };
  const store = new PluginStore({ root, desk, registry: () => registry, indexOverride: () => null, appVersion: "2.7.0", fetcher: fakeFetch(routes), changed: () => {}, log: () => {} });
  const entry = (view = store.view()) => view.entries.find((candidate) => candidate.name === "demo")!;
  /** The catalog moves on to 1.1.0. */
  const offer = async () => { routes[OFFICIAL_INDEX_URL] = JSON.stringify({ schema: 1, plugins: [entryOf("1.1.0", v2, C2, to)] }); return store.refresh(); };
  /** The usual path: install 1.0.0 on the install card. */
  const installV1 = async () => { await store.refresh(); await store.install("demo"); notices.at(-1)!.answer!(0); };
  const dataRoot = join(root, "plugin-data");
  const library = join(root, "plugins", "demo");

  // The server's rows (plugin-rows.ts) for what the registry runs, in memory.
  const { db, writer } = memoryStore();
  const stream = ownTableStream(db);
  const reconcile = (now: number) => writer.submit((tx) => reconcilePluginRows(tx, stream, installedFromRegistry(registry.plugins), now, { log: () => {} }));
  const row = () => PluginRow.parse(readRowBody(db, stream, "plugin:demo"));
  const grantAt = async (hash: string, grant: Omit<PluginGrant, "at" | "grantedBy">) => {
    await writer.submit((tx) => putRow(tx, stream, "plugin:demo", { ...row(), grants: { ...row().grants, [hash]: { grantedBy: "user", ...grant, at: 2_000 } } }));
  };
  const cards = () => notices.filter((notice) => notice.choices);
  return { root, registry, desk, store, routes, notices, entry, offer, installV1, dataRoot, library, v1, v2, db, stream, reconcile, row, grantAt, cards };
}

beforeEach(() => { vi.stubEnv("BOTLING_GIT_PATH", "/nonexistent/git"); });
afterEach(() => { vi.unstubAllEnvs(); });

const SAME: Spec = { permissions: ["files", "bots"], host: true };

describe("a newer catalog version is an update offer", () => {
  it("installed: the entry says update and the count says 1; built in: the same", async () => {
    const installed = setup(SAME, SAME);
    await installed.installV1();
    expect(installed.entry()).toMatchObject({ state: "installed", installedVersion: "1.0.0" });
    const view = await installed.offer();
    expect(installed.entry(view)).toMatchObject({ state: "update", installedVersion: "1.0.0", version: "1.1.0" });
    expect(view.updates).toBe(1);

    const builtIn = setup(SAME, SAME, { builtIn: true });
    await builtIn.store.refresh();
    expect(builtIn.entry()).toMatchObject({ state: "builtIn", installedVersion: "1.0.0" });
    const builtView = await builtIn.offer();
    expect(builtIn.entry(builtView)).toMatchObject({ state: "update", installedVersion: "1.0.0" });
    expect(builtView.updates).toBe(1);
  });

  it("direct is only for an update: a plugin that is not installed still asks on the install card", async () => {
    const t = setup(SAME, SAME);
    await t.store.refresh();
    await t.store.install("demo", { direct: true });
    expect(t.cards().at(-1)!.choices!.map((choice) => choice.label)).toEqual(["Install", "Don't install"]);
    expect(t.registry.plugin("demo")).toBeUndefined();
    expect(t.entry().status).toEqual({ kind: "asking", message: null });
  });
});

describe("Update (direct) of an installed plugin", () => {
  it("asks for no more: no card, the new code is live in the library and the host spec, the grant is carried, the server part may run", async () => {
    const t = setup({ permissions: ["files", "bots"], host: true }, { permissions: ["files"], host: true });
    await t.installV1();
    await t.reconcile(1_000);
    const oldHash = folderHash(t.library);
    await t.grantAt(oldHash, WRITE);
    const before = t.registry.hostSpecs(t.dataRoot)[0]!;
    expect(before).toMatchObject({ name: "demo", version: "1.0.0", main: join(t.library, "dist", "host.mjs") });

    await t.offer();
    const cardsBefore = t.cards().length;
    const view = await t.store.install("demo", { direct: true });

    // No install card; done in one step.
    expect(t.cards().length).toBe(cardsBefore);
    expect(t.entry(view).status).toEqual({ kind: "installed", message: null });
    expect(t.entry(view)).toMatchObject({ state: "installed", installedVersion: "1.1.0" });
    expect(view.updates).toBe(0);
    expect(folderHash(t.library)).toBe(expectedHash(t.v2));
    expect(readdirSync(join(t.root, "install-staging"))).toEqual([]);
    // The program part the host loads is the new one (a new fingerprint makes the host reload just this plugin).
    const after = t.registry.hostSpecs(t.dataRoot)[0]!;
    expect(after).toMatchObject({ name: "demo", version: "1.1.0", main: before.main });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // The row follows, and the grant goes with it (fewer asks: lowered to what the new code asks for).
    await t.reconcile(3_000);
    const newHash = folderHash(t.library);
    expect(newHash).not.toBe(oldHash);
    expect(t.row().codeHash).toBe(newHash);
    expect(t.row().grants[newHash]).toMatchObject({ grantedBy: "user" });
    expect(mayRunPluginServerPart(() => t.db, t.stream, "demo", newHash)).toBe(true);
    // The old version is kept for Revert.
    expect(t.desk.previousOf("demo")).toMatchObject({ version: "1.0.0" });
  });

  it.each([
    ["a new permission", { permissions: ["files"], host: true }, { permissions: ["files", "exec"], host: true }, "permission exec"],
    ["a new program part", { permissions: ["files"], host: false }, { permissions: ["files"], host: true }, "part host"],
    ["a new bot tools folder", { permissions: ["files"], host: false }, { permissions: ["files"], host: false, claude: true }, "part claude"],
  ] as Array<[string, Spec, Spec, string]>)("asks for more (%s): the card names it, nothing changes until Install, and the server still wants Allow", async (_label, from, to, grew) => {
    const t = setup(from, to);
    await t.installV1();
    await t.reconcile(1_000);
    const oldHash = folderHash(t.library);
    await t.grantAt(oldHash, WRITE);
    await t.offer();

    const view = await t.store.install("demo", { direct: true });
    const card = t.cards().at(-1)!;
    expect(card.choices!.map((choice) => choice.label)).toEqual(["Install", "Don't install"]);
    expect(card.text).toContain('Update the plugin "Demo" from 1.0.0 to 1.1.0?');
    expect(card.text).toContain(`This update asks for more than the running version: ${grew}.`);
    expect(t.entry(view).status).toEqual({ kind: "asking", message: `This update asks for more than the running version: ${grew}.` });
    // Nothing moved.
    expect(t.registry.plugin("demo")!.manifest.version).toBe("1.0.0");
    expect(folderHash(t.library)).toBe(oldHash);

    // Don't install: still nothing, and it can be asked again.
    card.answer!(1);
    expect(t.entry().status).toEqual({ kind: "declined", message: null });
    expect(folderHash(t.library)).toBe(oldHash);
    await t.store.install("demo", { direct: true });
    t.cards().at(-1)!.answer!(0);
    expect(t.registry.plugin("demo")!.manifest.version).toBe("1.1.0");
    expect(t.entry().status).toEqual({ kind: "installed", message: null });

    // The server's carry refuses the grown asks: the new hash has no grant, the program part is held back until Allow.
    await t.reconcile(3_000);
    const newHash = folderHash(t.library);
    expect(Object.hasOwn(t.row().grants, newHash)).toBe(false);
    expect(mayRunPluginServerPart(() => t.db, t.stream, "demo", newHash)).toBe(false);
  });

  it("an update that is not direct (the Explore list's Install on an older copy) still asks, with no growth line when nothing grew", async () => {
    const t = setup(SAME, SAME);
    await t.installV1();
    await t.offer();
    await t.store.install("demo");
    const card = t.cards().at(-1)!;
    expect(card.text).toContain('Update the plugin "Demo" from 1.0.0 to 1.1.0?');
    expect(card.text).not.toContain("asks for more");
    expect(t.entry().status).toEqual({ kind: "asking", message: null });
  });

  it("a failed check refuses before anything changes (hash mismatch), direct or not", async () => {
    const t = setup(SAME, SAME);
    await t.installV1();
    await t.offer();
    t.routes[tarball(C2)] = tarballOf({ ...t.v2, "dist/web.js": "export const evil = 1;\n" });
    const view = await t.store.install("demo", { direct: true });
    expect(t.entry(view).status!.kind).toBe("failed");
    expect(t.entry(view).status!.message).toMatch(/does not match the index/);
    expect(t.registry.plugin("demo")!.manifest.version).toBe("1.0.0");
    expect(folderHash(t.library)).toBe(expectedHash(t.v1));
  });
});

describe("a built-in plugin can be updated the same way", () => {
  it("asks for no more: no card, the update runs in place of the built-in with the built-in's rights (row author, write grant, server part, appDataDir)", async () => {
    const t = setup(SAME, SAME, { builtIn: true });
    await t.store.refresh();
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, installedFrom: null });
    await t.reconcile(1_000);
    const shippedHash = t.row().codeHash;
    expect(t.row()).toMatchObject({ author: "builtin" });
    expect(t.row().grants[shippedHash]).toMatchObject({ tier: "write", grantedBy: "builtin" });
    await t.offer();
    expect(t.registry.hostSpecs(t.dataRoot)[0]!.version).toBe("1.0.0");

    const view = await t.store.install("demo", { direct: true });
    expect(t.cards()).toEqual([]);
    expect(t.entry(view).status).toEqual({ kind: "installed", message: null });
    // The registry: version 1.1.0 from the library, still built in, with the built-in version it replaced.
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, replacesBuiltIn: "1.0.0", folder: t.library, manifest: { version: "1.1.0" } });
    expect(t.registry.plugin("demo")!.installedFrom).toContain(C2);
    expect(t.registry.revisionOf("demo")).toBe(expectedHash(t.v2));
    const spec = t.registry.hostSpecs(t.dataRoot)[0]!;
    expect(spec).toMatchObject({ version: "1.1.0", main: join(t.library, "dist", "host.mjs") });
    expect(spec.appDataDir).toBeDefined();
    // The rows: still the built-in's, at the new hash, with its own write grant: the server part may run.
    await t.reconcile(3_000);
    const newHash = folderHash(t.library);
    expect(newHash).not.toBe(shippedHash);
    expect(t.row()).toMatchObject({ author: "builtin", codeHash: newHash });
    expect(t.row().grants[newHash]).toMatchObject({ tier: "write", grantedBy: "builtin" });
    expect(mayRunPluginServerPart(() => t.db, t.stream, "demo", newHash)).toBe(true);
    // The built-in's version is untouched in the app.
    expect(folderHash(join(t.root, "app-plugins", "demo"))).toBe(expectedHash(t.v1));
  });

  it("asks for more: the card names it and nothing is installed until Install", async () => {
    const t = setup({ permissions: ["files"], host: true }, { permissions: ["files", "exec"], host: true }, { builtIn: true });
    await t.store.refresh();
    await t.offer();
    await t.store.install("demo", { direct: true });
    const card = t.cards().at(-1)!;
    expect(card.text).toContain("This update asks for more than the running version: permission exec.");
    expect(existsSync(t.library)).toBe(false);
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, installedFrom: null, manifest: { version: "1.0.0" } });
    card.answer!(0);
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, replacesBuiltIn: "1.0.0", manifest: { version: "1.1.0" } });
  });

  it("the built-in's rights last only while the files are what the catalog check verified: one changed byte makes it an ordinary library copy", async () => {
    const t = setup(SAME, SAME, { builtIn: true });
    await t.store.refresh();
    await t.offer();
    await t.store.install("demo", { direct: true });
    expect(t.registry.plugin("demo")!.builtIn).toBe(true);
    await t.reconcile(3_000);
    const verifiedHash = folderHash(t.library);

    appendFileSync(join(t.library, "dist", "host.mjs"), "// edited by hand\n");
    t.registry.rescan(true);
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: false, replacesBuiltIn: "1.0.0", manifest: { version: "1.1.0" } });
    // Its row is a user's now: the built-in grant at the old hash does not run the edited code.
    await t.reconcile(4_000);
    const editedHash = folderHash(t.library);
    expect(editedHash).not.toBe(verifiedHash);
    expect(t.row().author).toBe("user");
    expect(mayRunPluginServerPart(() => t.db, t.stream, "demo", editedHash)).toBe(false);
  });

  it("the record is kept across a restart (plugins.json), and a library copy with no catalog record is not built in", async () => {
    const t = setup(SAME, SAME, { builtIn: true });
    await t.store.refresh();
    await t.offer();
    await t.store.install("demo", { direct: true });
    const again = new PluginRegistry(join(t.root, "plugins"), join(t.root, "plugins.json"), new MemorySecretStore(), join(t.root, "app-plugins"));
    again.rescan(true);
    expect(again.plugin("demo")).toMatchObject({ builtIn: true, replacesBuiltIn: "1.0.0" });

    // The same files noted without a catalog hash (any other source): an ordinary library plugin that happens to replace the built-in.
    again.noteInstalled("demo", "https://example.invalid/demo.git");
    expect(again.revisionOf("demo")).toBeNull();
    expect(again.plugin("demo")).toMatchObject({ builtIn: false, replacesBuiltIn: "1.0.0" });
  });

  it("a library copy older than the built-in version never gets the built-in's rights, record or not", async () => {
    const t = setup(SAME, SAME, { builtIn: true });
    await t.store.refresh();
    await t.offer();
    await t.store.install("demo", { direct: true });
    // The app now ships 1.2.0: the library's 1.1.0 is older and is ignored (versions.ts), whatever the record says.
    const shipped = join(t.root, "app-plugins", "demo");
    rmSync(shipped, { recursive: true, force: true });
    writeFolder(shipped, demoFiles("1.2.0", SAME));
    t.registry.rescan(true);
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, manifest: { version: "1.2.0" }, folder: shipped });
    expect(t.registry.plugin("demo")!.replacesBuiltIn).toBeUndefined();
    expect(t.registry.plugin("demo")!.ignoredLibraryCopy).toMatchObject({ version: "1.1.0" });
  });

  it("Remove puts the built-in version back (and drops the record)", async () => {
    const t = setup(SAME, SAME, { builtIn: true });
    await t.store.refresh();
    await t.offer();
    await t.store.install("demo", { direct: true });
    expect(t.desk.removePlugin("demo")).toBeNull();
    expect(existsSync(t.library)).toBe(false);
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, installedFrom: null, manifest: { version: "1.0.0" } });
    expect(t.registry.plugin("demo")!.replacesBuiltIn).toBeUndefined();
    expect(t.registry.revisionOf("demo")).toBeNull();
    expect(t.entry(await t.store.refresh())).toMatchObject({ state: "update" });
    // A plain built-in (nothing replacing it) still cannot be removed.
    expect(t.desk.removePlugin("demo")).toMatch(/not a plugin installed from outside/);
  });

  it("updating again after Remove records the verified hash again", async () => {
    const t = setup(SAME, SAME, { builtIn: true });
    await t.store.refresh();
    await t.offer();
    await t.store.install("demo", { direct: true });
    // Back to the shipped version by Remove, then the update again.
    expect(t.desk.removePlugin("demo")).toBeNull();
    await t.store.install("demo", { direct: true });
    expect(t.registry.plugin("demo")).toMatchObject({ builtIn: true, replacesBuiltIn: "1.0.0" });
    expect(t.registry.revisionOf("demo")).toBe(expectedHash(t.v2));
  });
});

describe("what a new version asks for that the old one did not (asks-growth.ts)", () => {
  it("lists new permissions and parts, in the order of the new version; fewer or equal asks nothing", () => {
    const before = askFactsOf({ ccb: { permissions: ["files", "bots"], host: "dist/host.mjs" } });
    expect(askGrowth(before, askFactsOf({ ccb: { permissions: ["bots", "files"], host: "dist/host.mjs" } }))).toEqual([]);
    expect(askGrowth(before, askFactsOf({ ccb: { permissions: ["files"] } }))).toEqual([]);
    expect(askGrowth(before, askFactsOf({ ccb: { permissions: ["files", "bots", "network", "exec"], host: "x", claude: "claude" } }))).toEqual(["permission exec", "permission network", "part claude"]);
    expect(askGrowth(askFactsOf({}), askFactsOf({ ccb: { host: "h", claude: "c" } }))).toEqual(["part host", "part claude"]);
    expect(askGrowth(askFactsOf({}), askFactsOf({}))).toEqual([]);
  });

  it("a name from a manifest is one safe line, and the facts are capped", () => {
    expect(askGrowth(askFactsOf({}), askFactsOf({ ccb: { permissions: ["ok.name-1", "bad name\n\u0007"] } }))).toEqual(["permission \"bad name\\n\\u0007\"", "permission ok.name-1"]);
    const many = Array.from({ length: 30 }, (_, index) => `p${String(index).padStart(2, "0")}`);
    expect(askFactsOf({ ccb: { permissions: many } }).permissions).toHaveLength(20);
    expect(askFactsOf({ ccb: { permissions: ["x".repeat(100)] } }).permissions[0]).toHaveLength(40);
    expect(askFactsOf({ ccb: { permissions: ["a", "a"] } }).permissions).toEqual(["a"]);
  });
});

describe("an open frame knows when its plugin was updated (renderer/plugin-stamp.ts)", () => {
  const plugin = (version: string, more: { builtIn?: boolean; replacesBuiltIn?: string } = {}) => ({ name: "demo", version, ...more });
  it("a new version, or the plugin now running from another copy, reloads; the same, none, gone or an unknown start do not", () => {
    const loaded = pluginStamp(plugin("1.0.0"));
    expect(loaded).not.toBeNull();
    expect(frameNeedsReload(loaded, [plugin("1.0.0")], "demo")).toBe(false);
    expect(frameNeedsReload(loaded, [plugin("1.1.0")], "demo")).toBe(true);
    expect(frameNeedsReload(loaded, [plugin("1.0.0", { replacesBuiltIn: "0.9.0" })], "demo")).toBe(true);
    expect(frameNeedsReload(loaded, [plugin("1.0.0", { builtIn: true })], "demo")).toBe(true);
    expect(frameNeedsReload(loaded, [{ name: "other", version: "9.0.0" }], "demo")).toBe(false);
    expect(frameNeedsReload(null, [plugin("1.1.0")], "demo")).toBe(false);
    expect(pluginStamp(undefined)).toBeNull();
  });
});
