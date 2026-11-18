// A built-in plugin updated in the running app (src/core/plugins/overrides.ts, registry.ts `rescan`, scripts/push-builtin-plugin.mjs):
// a newer built copy pushed into <core data>/builtin-overrides runs in place of the shipped one, with the shipped one's rights, and is
// dropped when it is not what the app was told to trust (no stamp, changed files, a link, an old build, a broken manifest).
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { folderHash } from "../../src/core/plugins/catalog";
import { frameNeedsReload, pluginStamp } from "../../src/renderer/plugin-stamp";
import { CORE_FIXED_PLUGINS as FIXED_IN_CORE, PushedCopies } from "../../src/core/plugins/overrides";
import { CORE_FIXED_PLUGINS, contentHash, placeOverride, pushBuiltinPlugin, removeOverride } from "../../scripts/push-builtin-plugin.mjs";

/** A plugin folder with a web part, at `version`; `marker` ends up in the web file. */
function plugin(root: string, name: string, version: string, marker = "") {
  mkdirSync(join(root, name, "dist"), { recursive: true });
  writeFileSync(join(root, name, "package.json"), JSON.stringify({ name, version, engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js" } }));
  writeFileSync(join(root, name, "dist", "web.js"), `export function activate() {} // ${version} ${marker}`);
  return join(root, name);
}

function setup(shippedVersion = "1.2.0", developerMode: () => boolean = () => true) {
  const dir = tempDir("builtin-overrides");
  const shipped = join(dir, "builtin"), lib = join(dir, "plugins"), overrides = join(dir, "builtin-overrides");
  plugin(shipped, "botling.catchup", shippedVersion, "shipped");
  mkdirSync(lib, { recursive: true });
  const registry = () => new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped, overrides, developerMode);
  /** A newer build of the plugin pushed the way the script does (built into a scratch folder first). */
  const push = (version = "1.2.0", marker = "pushed", now = Date.now() + 2_000) => {
    const built = plugin(join(dir, `built-${marker}`), "botling.catchup", version, marker);
    return placeOverride({ built, name: "botling.catchup", root: overrides, now });
  };
  const stamp = () => join(overrides, "botling.catchup.push.json");
  return { dir, shipped, lib, overrides, registry, push, stamp };
}

describe("the registry with a pushed copy of a built-in plugin", () => {
  it("no push: the shipped copy runs", () => {
    const { registry, shipped } = setup();
    const running = registry().plugin("botling.catchup")!;
    expect(running.folder).toBe(join(shipped, "botling.catchup"));
    expect(running.pushed).toBeUndefined();
  });

  it("a pushed copy runs in place of the shipped one and keeps its built-in rights", () => {
    const { registry, push, overrides } = setup();
    const result = push();
    const running = registry().plugin("botling.catchup")!;
    expect(running.folder).toBe(join(overrides, result.dir));
    expect(running.builtIn).toBe(true);
    expect(running.enabled).toBe(true);
    expect(running.manifest.version).toMatch(/^1\.2\.0\+push\.[0-9a-f]{8}$/);
    expect(running.pushed).toMatchObject({ shippedVersion: "1.2.0" });
    expect(running.replacesBuiltIn).toBeUndefined();
  });

  it("a push while the app runs is taken on the next scan: the web part, the version and the fingerprint move, once", () => {
    const { registry, push, overrides } = setup();
    const plugins = registry();
    const before = plugins.webSpecs()[0]!;
    const updated: string[] = [];
    plugins.onUpdated = (running, from) => updated.push(`${from} -> ${running.manifest.version}`);
    let changes = 0;
    plugins.onChanged = () => { changes++; };
    push();
    expect(plugins.rescan()).toBe(true);
    const after = plugins.webSpecs()[0]!;
    expect(after.source).toContain("pushed");
    expect(after.source).not.toBe(before.source);
    expect(after.version).not.toBe(before.version);
    expect(after.builtIn).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatch(/^1\.2\.0 -> 1\.2\.0\+push\./);
    expect(changes).toBe(1);
    // nothing changed: nothing is told again
    expect(plugins.rescan()).toBe(false);
    // a second push replaces the first without a scan ever seeing the shipped copy (no flash back)
    const seen: string[] = [];
    plugins.onChanged = () => seen.push(plugins.plugin("botling.catchup")!.folder);
    const second = push("1.2.0", "second");
    expect(plugins.rescan()).toBe(true);
    expect(seen).toEqual([join(overrides, second.dir)]);
    expect(plugins.webSpecs()[0]!.source).toContain("second");
  });

  it("an open frame built from the old copy reloads, because the version it carries moved", () => {
    const { registry, push } = setup();
    const plugins = registry();
    const old = pluginStamp({ version: plugins.plugin("botling.catchup")!.manifest.version, builtIn: true });
    push();
    plugins.rescan();
    const now = plugins.plugin("botling.catchup")!;
    expect(frameNeedsReload(old, [{ name: "botling.catchup", version: now.manifest.version, builtIn: true }], "botling.catchup")).toBe(true);
  });

  it("a build newer than the push drops it (the stale folder and its stamp are removed)", () => {
    const { registry, push, overrides, shipped, stamp } = setup();
    // pushed a minute before the shipped copy was laid down
    push("1.2.0", "stale", Date.now() - 60_000);
    const running = registry().plugin("botling.catchup")!;
    expect(running.folder).toBe(join(shipped, "botling.catchup"));
    expect(running.pushed).toBeUndefined();
    expect(existsSync(stamp())).toBe(false);
    expect(readdirSync(overrides).filter((entry) => entry.startsWith("botling.catchup@"))).toEqual([]);
  });

  it("a push made after the build is not stale even when the build was laid down a moment earlier", () => {
    const { registry, push, shipped } = setup();
    const when = Date.now();
    utimesSync(join(shipped, "botling.catchup"), new Date(when - 5_000), new Date(when - 5_000));
    utimesSync(join(shipped, "botling.catchup", "package.json"), new Date(when - 5_000), new Date(when - 5_000));
    push("1.2.0", "fresh", when);
    expect(registry().plugin("botling.catchup")!.pushed).toBeDefined();
  });

  it("a push with no stamp, or a stamp for another plugin, is ignored and left alone", () => {
    const { registry, push, overrides, shipped, stamp } = setup();
    const made = push();
    const text = readFileSync(stamp(), "utf8");
    rmSync(stamp());
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
    writeFileSync(stamp(), text.replace("botling.catchup", "botling.note"));
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
    expect(existsSync(join(overrides, made.dir))).toBe(true);
  });

  it("says why a stale push was dropped, also when the first scan found it (told as soon as a listener is set)", () => {
    const { registry, push } = setup();
    push("1.2.0", "stale", Date.now() - 60_000);
    const plugins = registry();
    const said: string[] = [];
    plugins.onPushedNote = (text) => said.push(text);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("older than this build");
  });

  it("says once why a pushed copy is ignored, not at every scan", () => {
    const { registry, push, overrides } = setup();
    const made = push();
    const plugins = registry();
    const said: string[] = [];
    plugins.onPushedNote = (text) => said.push(text);
    writeFileSync(join(overrides, made.dir, "dist", "web.js"), "changed");
    for (let scan = 0; scan < 3; scan++) plugins.rescan(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("not the ones that were pushed");
  });

  it("a file changed after the push (the stamp's hash no longer matches) is ignored", () => {
    const { registry, push, overrides, shipped } = setup();
    const made = push();
    writeFileSync(join(overrides, made.dir, "dist", "web.js"), "export function activate() { evil(); }");
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a file changed after the copy was taken (the same scan state kept) is noticed at the next scan, also when its size did not change", async () => {
    const { registry, push, overrides, shipped } = setup();
    const made = push();
    const plugins = registry();
    expect(plugins.plugin("botling.catchup")!.pushed).toBeDefined();
    const file = join(overrides, made.dir, "dist", "web.js");
    const same = readFileSync(file, "utf8");
    // file times of a fast disk move in steps of a few ms: wait so the change shows in the stat signature, as a real edit would
    await new Promise((done) => setTimeout(done, 50));
    writeFileSync(file, same.replace("pushed", "tamper"));
    expect(same.length).toBe(readFileSync(file, "utf8").length);
    plugins.rescan(true);
    expect(plugins.plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
    // put the text back: it is the pushed one again, and runs again
    await new Promise((done) => setTimeout(done, 50));
    writeFileSync(file, same);
    plugins.rescan(true);
    expect(plugins.plugin("botling.catchup")!.pushed).toBeDefined();
  });

  it("a file added after the push is ignored too", () => {
    const { registry, push, overrides, shipped } = setup();
    const made = push();
    writeFileSync(join(overrides, made.dir, "dist", "extra.js"), "x");
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a link anywhere in the pushed folder is ignored", () => {
    const { registry, push, overrides, shipped, dir } = setup();
    const made = push();
    writeFileSync(join(dir, "outside.txt"), "x");
    symlinkSync(join(dir, "outside.txt"), join(overrides, made.dir, "dist", "link.txt"));
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a stamp that is a link is ignored", () => {
    const { registry, push, shipped, stamp, dir } = setup();
    push();
    const text = readFileSync(stamp(), "utf8");
    rmSync(stamp());
    writeFileSync(join(dir, "elsewhere.json"), text);
    symlinkSync(join(dir, "elsewhere.json"), stamp());
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a stamp whose folder is not one of this plugin's content folders is ignored", () => {
    const { registry, push, shipped, stamp, dir } = setup();
    push();
    const body = JSON.parse(readFileSync(stamp(), "utf8")) as Record<string, unknown>;
    for (const bad of ["../builtin/botling.catchup", "/tmp", "botling.note@0123456789ab", "botling.catchup@../x", "botling.catchup"]) {
      writeFileSync(stamp(), JSON.stringify({ ...body, dir: bad }));
      expect(registry().plugin("botling.catchup")!.folder, bad).toBe(join(shipped, "botling.catchup"));
    }
    expect(existsSync(dir)).toBe(true);
  });

  it("a stamp that points outside the overrides folder is ignored even when the folder it names hashes as the stamp says", () => {
    const { registry, push, shipped, stamp } = setup();
    push();
    const body = JSON.parse(readFileSync(stamp(), "utf8")) as Record<string, unknown>;
    // the build's own folder is a plain plugin folder of this user: only the stamp's folder rule keeps it from being "the pushed copy"
    const own = join(shipped, "botling.catchup");
    writeFileSync(stamp(), JSON.stringify({ ...body, dir: "../builtin/botling.catchup", folderHash: folderHash(own) }));
    expect(registry().plugin("botling.catchup")!.pushed).toBeUndefined();
  });

  it("a stamp that is too big, or of another version, or with a wrong field, is ignored", () => {
    const { registry, push, shipped, stamp } = setup();
    push();
    const body = JSON.parse(readFileSync(stamp(), "utf8")) as Record<string, unknown>;
    const bad: Record<string, unknown>[] = [
      { ...body, v: 2 }, { ...body, pushedAt: "1" }, { ...body, pushedAt: null }, { ...body, folderHash: "abc" }, { ...body, folderHash: 5 }, { ...body, plugin: "botling.note" },
      { ...body, pad: "x".repeat(5000) },
    ];
    for (const one of bad) {
      writeFileSync(stamp(), JSON.stringify(one));
      expect(registry().plugin("botling.catchup")!.folder, JSON.stringify(one).slice(0, 60)).toBe(join(shipped, "botling.catchup"));
    }
    writeFileSync(stamp(), JSON.stringify(body));
    expect(registry().plugin("botling.catchup")!.pushed).toBeDefined();
  });

  it("a pushed folder or stamp anyone but the owner may write to is ignored", () => {
    const { registry, push, overrides, shipped, stamp } = setup();
    const made = push();
    chmodSync(join(overrides, made.dir), 0o777);
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
    chmodSync(join(overrides, made.dir), 0o755);
    expect(registry().plugin("botling.catchup")!.pushed).toBeDefined();
    chmodSync(stamp(), 0o666);
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a push whose manifest fails the plugin check is ignored, and the shipped copy keeps running", () => {
    const { registry, dir, overrides, shipped } = setup();
    const built = plugin(join(dir, "built-bad"), "botling.catchup", "1.2.0", "bad");
    writeFileSync(join(built, "package.json"), JSON.stringify({ name: "botling.catchup", version: "1.2.0", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/missing.js" } }));
    placeOverride({ built, name: "botling.catchup", root: overrides, now: Date.now() + 2_000 });
    const plugins = registry();
    expect(plugins.plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
    expect(plugins.plugin("botling.catchup")!.enabled).toBe(true);
  });

  it("a push of a plugin that names another plugin is ignored", () => {
    const { registry, dir, overrides, shipped } = setup();
    const built = plugin(join(dir, "built-other"), "botling.other", "1.2.0");
    // the folder is named for the plugin it replaces, but its manifest is for another one
    mkdirSync(overrides, { recursive: true });
    const placed = placeOverride({ built, name: "botling.catchup", root: overrides, now: Date.now() + 2_000 });
    expect(placed.dir).toMatch(/^botling\.catchup@/);
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a pushed copy older than the shipped one (a semver) is ignored", () => {
    const { registry, push, shipped } = setup("1.3.0");
    push("1.2.0");
    expect(registry().plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("only a shipped plugin can be replaced: a pushed folder for a name Botling does not ship, or a library plugin, is never used", () => {
    const { registry, dir, overrides, lib } = setup();
    plugin(lib, "my-plugin", "1.0.0", "library");
    const built = plugin(join(dir, "built-mine"), "my-plugin", "9.9.9", "pushed");
    placeOverride({ built, name: "my-plugin", root: overrides, now: Date.now() + 2_000 });
    const plugins = registry();
    expect(plugins.plugin("my-plugin")!.folder).toBe(join(lib, "my-plugin"));
    expect(plugins.plugin("my-plugin")!.builtIn).toBe(false);
    expect(plugins.plugin("my-plugin")!.pushed).toBeUndefined();
  });

  it("a plugin the core reads from the shipped folder (the orchestration rules) is never replaced, whatever is pushed", () => {
    const { dir, shipped, lib, overrides } = setup();
    plugin(shipped, "botling.orchestration", "1.0.0", "shipped");
    const built = plugin(join(dir, "built-rules"), "botling.orchestration", "1.0.0", "pushed");
    placeOverride({ built, name: "botling.orchestration", root: overrides, now: Date.now() + 2_000 });
    const plugins = new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped, overrides, () => true);
    expect(plugins.plugin("botling.orchestration")!.folder).toBe(join(shipped, "botling.orchestration"));
    expect(plugins.plugin("botling.orchestration")!.pushed).toBeUndefined();
  });

  it("the script and the core name the same plugins as fixed in the core", () => {
    expect([...CORE_FIXED_PLUGINS].sort()).toEqual([...FIXED_IN_CORE].sort());
    expect(FIXED_IN_CORE).toContain("botling.orchestration");
  });

  it("no overrides folder given (a core with none): nothing is looked at", () => {
    const { dir, shipped, lib, push } = setup();
    push();
    const plain = new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped, null, () => true);
    expect(plain.plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("a library copy still wins over a pushed one when its version is newer, as over the shipped one", () => {
    const { registry, push, lib } = setup();
    push();
    plugin(lib, "botling.catchup", "1.9.0", "library");
    const running = registry().plugin("botling.catchup")!;
    expect(running.folder).toBe(join(lib, "botling.catchup"));
    expect(running.replacesBuiltIn).toMatch(/^1\.2\.0\+push\./);
  });

  it("removing the push brings the shipped copy back on the next scan", () => {
    const { registry, push, overrides, shipped } = setup();
    push();
    const plugins = registry();
    expect(plugins.plugin("botling.catchup")!.pushed).toBeDefined();
    removeOverride({ name: "botling.catchup", root: overrides });
    expect(plugins.rescan()).toBe(true);
    expect(plugins.plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("the pushed copy's files hash as the stamp says (the script and the core agree on the hash)", () => {
    const { push, overrides, stamp } = setup();
    const made = push();
    const body = JSON.parse(readFileSync(stamp(), "utf8")) as { folderHash: string; dir: string; plugin: string; v: number; pushedAt: number };
    expect(body.folderHash).toBe(folderHash(join(overrides, made.dir)));
    expect(body.folderHash).toBe(contentHash(join(overrides, made.dir)));
    expect(made.dir).toBe(`botling.catchup@${body.folderHash.slice(0, 12)}`);
    expect(body.pushedAt).toBeGreaterThan(0);
    expect(body).toMatchObject({ v: 1, plugin: "botling.catchup" });
  });
});

describe("the real botling.catchup, built by the build script and pushed", () => {
  it("is accepted by the registry in place of the build's own copy: same files hash, plugin check, built-in rights, a new version", async () => {
    const desktop = join(__dirname, "..", "..");
    const { buildBuiltinPlugins } = await import(join(desktop, "build-builtin-plugins.mjs"));
    const shipped = tempDir("real-shipped");
    await buildBuiltinPlugins({ root: desktop, outdir: shipped, only: ["botling.catchup"] });
    const built = tempDir("real-built");
    await buildBuiltinPlugins({ root: desktop, outdir: built, only: ["botling.catchup"] });
    const data = tempDir("real-data");
    mkdirSync(join(data, "plugins"), { recursive: true });
    const placed = placeOverride({ built: join(built, "botling.catchup"), name: "botling.catchup", root: join(data, "builtin-overrides") });
    const registry = new PluginRegistry(join(data, "plugins"), join(data, "plugins.json"), new MemorySecretStore(), shipped, join(data, "builtin-overrides"), () => true);
    const running = registry.plugin("botling.catchup")!;
    expect(running.folder).toBe(join(data, "builtin-overrides", placed.dir));
    expect(running.builtIn).toBe(true);
    expect(running.pushed).toBeDefined();
    expect(running.manifest.ccb?.host).toBeTruthy();
    expect(existsSync(join(running.folder, running.manifest.ccb!.host!))).toBe(true);
    expect(registry.hostSpecs(join(data, "plugin-data"))[0]!.appDataDir).toBeDefined();
  }, 60_000);
});

describe("push-builtin-plugin", () => {
  const sources = () => {
    const desktop = tempDir("push-desktop");
    plugin(join(desktop, "builtin-plugins"), "botling.catchup", "1.2.0", "source");
    const dataDir = tempDir("push-data");
    return { desktop, dataDir, root: join(dataDir, "builtin-overrides") };
  };
  const stubBuild = (marker: string) => async (name: string) => plugin(tempDir(`push-built-${marker}`), name, "1.2.0", marker);
  const quiet = () => {};

  it("builds the plugin, checks it and puts it in the overrides folder with a stamp; the registry takes it", async () => {
    const { desktop, dataDir, root } = sources();
    const result = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("one"), check: () => [], log: quiet });
    expect(result.dir).toMatch(/^botling\.catchup@[0-9a-f]{12}$/);
    expect(existsSync(join(root, "botling.catchup.push.json"))).toBe(true);
    const shipped = tempDir("push-shipped");
    plugin(shipped, "botling.catchup", "1.2.0", "shipped");
    const registry = new PluginRegistry(join(dataDir, "plugins"), join(dataDir, "plugins.json"), new MemorySecretStore(), shipped, root, () => true);
    expect(registry.plugin("botling.catchup")!.pushed).toBeDefined();
    expect(registry.webSpecs()[0]!.source).toContain("one");
  });

  it("the pushed version carries the content hash, so the frames of the old copy reload", async () => {
    const { desktop, dataDir, root } = sources();
    const result = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("v"), check: () => [], log: quiet });
    const version = (JSON.parse(readFileSync(join(root, result.dir, "package.json"), "utf8")) as { version: string }).version;
    expect(version).toMatch(/^1\.2\.0\+push\.[0-9a-f]{8}$/);
    const other = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("w"), check: () => [], log: quiet });
    const next = (JSON.parse(readFileSync(join(root, other.dir, "package.json"), "utf8")) as { version: string }).version;
    expect(next).not.toBe(version);
    expect(next).toMatch(/^1\.2\.0\+push\.[0-9a-f]{8}$/);
  });

  it("a second push leaves the first in place until the stamp moves, and keeps only the current and previous folders", async () => {
    const { desktop, dataDir, root } = sources();
    const first = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("a"), check: () => [], log: quiet });
    const second = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("b"), check: () => [], log: quiet });
    const third = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("c"), check: () => [], log: quiet });
    const folders = readdirSync(root).filter((entry) => entry.startsWith("botling.catchup@")).sort();
    expect(folders).toEqual([second.dir, third.dir].sort());
    expect(folders).not.toContain(first.dir);
    expect((JSON.parse(readFileSync(join(root, "botling.catchup.push.json"), "utf8")) as { dir: string }).dir).toBe(third.dir);
  });

  it("a built folder that others may write to is closed when it is placed, so the core accepts it", () => {
    const { dir, shipped, lib, overrides } = setup();
    const built = plugin(join(dir, "built-open"), "botling.catchup", "1.2.0", "open");
    mkdirSync(join(built, "dist", "deep"), { recursive: true });
    writeFileSync(join(built, "dist", "deep", "more.js"), "x");
    chmodSync(join(built, "dist", "web.js"), 0o666);
    chmodSync(join(built, "dist", "deep", "more.js"), 0o666);
    chmodSync(join(built, "dist", "deep"), 0o777);
    chmodSync(built, 0o777);
    const placed = placeOverride({ built, name: "botling.catchup", root: overrides, now: Date.now() + 2_000 });
    for (const path of [placed.folder, join(placed.folder, "dist"), join(placed.folder, "dist", "deep"), join(placed.folder, "dist", "web.js"), join(placed.folder, "dist", "deep", "more.js"), join(placed.folder, "package.json")]) {
      expect(lstatSync(path).mode & 0o022, path).toBe(0);
    }
    const registry = new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped, overrides, () => true);
    expect(registry.plugin("botling.catchup")!.pushed).toBeDefined();
  });

  it("placing or removing under a name that is not a plugin name touches nothing", () => {
    const { dir, overrides } = setup();
    const built = plugin(join(dir, "built-name"), "botling.catchup", "1.2.0", "name");
    for (const name of ["../x", "a/b", "", "BOTLING", ".hidden", "constructor@1"]) {
      expect(() => placeOverride({ built, name, root: overrides }), name).toThrow();
      expect(() => removeOverride({ name, root: overrides }), name).toThrow();
    }
    expect(existsSync(overrides)).toBe(false);
  });

  it("pushing the same build twice changes nothing", async () => {
    const { desktop, dataDir, root } = sources();
    const first = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("same"), check: () => [], log: quiet });
    const again = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("same"), check: () => [], log: quiet });
    expect(again.dir).toBe(first.dir);
    expect(readdirSync(root).filter((entry) => entry.startsWith("botling.catchup@"))).toEqual([first.dir]);
  });

  it("a check that finds problems puts nothing in place, and an earlier push stays as it was", async () => {
    const { desktop, dataDir, root } = sources();
    const first = await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("keep"), check: () => [], log: quiet });
    const before = readFileSync(join(root, "botling.catchup.push.json"), "utf8");
    await expect(pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("bad"), check: () => ["web points to dist/x.js, which does not exist."], log: quiet })).rejects.toThrow(/dist\/x\.js/);
    expect(readFileSync(join(root, "botling.catchup.push.json"), "utf8")).toBe(before);
    expect(readdirSync(root).filter((entry) => entry.startsWith("botling.catchup@"))).toEqual([first.dir]);
    expect(readdirSync(root).filter((entry) => entry.startsWith("."))).toEqual([]);
  });

  it("a build that throws leaves nothing behind", async () => {
    const { desktop, dataDir, root } = sources();
    await expect(pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: async () => { throw new Error("esbuild failed"); }, check: () => [], log: quiet })).rejects.toThrow("esbuild failed");
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });

  it("refuses a name the app does not ship, or one that is not a plain plugin name", async () => {
    const { desktop, dataDir, root } = sources();
    for (const name of ["botling.nothere", "../x", "botling.catchup/../..", "", "BOTLING.CATCHUP", "a b", ".hidden", "constructor", "__proto__"]) {
      await expect(pushBuiltinPlugin({ name, desktopDir: desktop, dataDir, build: stubBuild("x"), check: () => [], log: quiet }), name).rejects.toThrow();
    }
    expect(existsSync(root)).toBe(false);
  });

  it("refuses a plugin that cannot be replaced while the app is running: the orchestration rules, read by the core from the shipped folder", async () => {
    const { desktop, dataDir } = sources();
    plugin(join(desktop, "builtin-plugins"), "botling.orchestration", "1.0.0", "rules");
    await expect(pushBuiltinPlugin({ name: "botling.orchestration", desktopDir: desktop, dataDir, build: stubBuild("o"), check: () => [], log: quiet })).rejects.toThrow(/core/);
  });

  it("the built folder is checked with the plugin check, and a built folder with a link in it is refused", async () => {
    const { desktop, dataDir } = sources();
    const build = async (name: string) => {
      const folder = plugin(tempDir("push-built-link"), name, "1.2.0", "link");
      symlinkSync("/etc/hosts", join(folder, "dist", "hosts"));
      return folder;
    };
    await expect(pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build, check: () => [], log: quiet })).rejects.toThrow(/link/);
  });

  it("--remove puts the shipped copy back: the stamp and the folders go", async () => {
    const { desktop, dataDir, root } = sources();
    await pushBuiltinPlugin({ name: "botling.catchup", desktopDir: desktop, dataDir, build: stubBuild("r"), check: () => [], log: quiet });
    removeOverride({ name: "botling.catchup", root });
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("a pushed copy runs only while the app's developer mode is on", () => {
  it("developer mode off (or not given, or failing to answer): the shipped copy runs, the push is left in place, the log says so once", () => {
    for (const mode of [() => false, undefined, () => { throw new Error("settings unreadable"); }] as const) {
      const { dir, shipped, lib, overrides, push, stamp } = setup();
      const made = push();
      const registry = mode === undefined
        ? new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped, overrides)
        : new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped, overrides, mode);
      const said: string[] = [];
      registry.onPushedNote = (text) => said.push(text);
      for (let scan = 0; scan < 3; scan++) registry.rescan(true);
      const running = registry.plugin("botling.catchup")!;
      expect(running.folder).toBe(join(shipped, "botling.catchup"));
      expect(running.pushed).toBeUndefined();
      expect(running.manifest.version).toBe("1.2.0");
      expect(existsSync(stamp())).toBe(true);
      expect(existsSync(join(overrides, made.dir))).toBe(true);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("developer mode is off");
    }
  });

  it("turning the mode on takes the push on the next scan, off puts the shipped copy back, each as one change", () => {
    let on = false;
    const { registry, push, overrides, shipped } = setup("1.2.0", () => on);
    const made = push();
    const plugins = registry();
    expect(plugins.plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
    expect(plugins.rescan()).toBe(false);
    on = true;
    expect(plugins.rescan()).toBe(true);
    expect(plugins.plugin("botling.catchup")!.folder).toBe(join(overrides, made.dir));
    expect(plugins.rescan()).toBe(false);
    on = false;
    expect(plugins.rescan()).toBe(true);
    expect(plugins.plugin("botling.catchup")!.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("with the mode off a stale push is not dropped either (nothing of the push is touched)", () => {
    const { registry, push, overrides, stamp } = setup("1.2.0", () => false);
    push("1.2.0", "stale", Date.now() - 60_000);
    registry();
    expect(existsSync(stamp())).toBe(true);
    expect(readdirSync(overrides).filter((entry) => entry.startsWith("botling.catchup@"))).toHaveLength(1);
  });

  it("the mode is asked only when a stamp is there, and the shipped manifest only after it said yes", () => {
    const { overrides, push } = setup();
    let asked = 0, manifests = 0;
    const copies = new PushedCopies(overrides, () => {}, () => { asked++; return true; });
    expect(copies.find("botling.catchup", "/nowhere", () => { manifests++; return "1.2.0"; })).toBeNull();
    expect([asked, manifests]).toEqual([0, 0]);
    push();
    const off = new PushedCopies(overrides, () => {}, () => { asked++; return false; });
    off.find("botling.catchup", "/nowhere", () => { manifests++; return "1.2.0"; });
    expect([asked, manifests]).toEqual([1, 0]);
  });

  it("a shipped manifest that cannot be read leaves the shipped folder as it is (no pushed copy)", () => {
    const { overrides, push } = setup();
    push();
    expect(new PushedCopies(overrides, () => {}, () => true).find("botling.catchup", "/nowhere", () => null)).toBeNull();
  });
});

describe("when a push counts as older than the build (the shipped folder's time against the push time)", () => {
  /** The shipped copy laid down `at` (ms since epoch): both its folder's and its manifest's modification time. */
  const laidDownAt = (shipped: string, at: number) => {
    for (const path of [join(shipped, "botling.catchup"), join(shipped, "botling.catchup", "package.json")]) utimesSync(path, new Date(at), new Date(at));
  };

  it("a push up to a second before the shipped time still counts (clock and file-time rounding), more than that is older", () => {
    const { registry, push, shipped } = setup();
    const at = Date.now() + 3_600_000; // after the folder's own birth time, so its modification time decides
    laidDownAt(shipped, at);
    push("1.2.0", "near", at - 500);
    expect(registry().plugin("botling.catchup")!.pushed).toBeDefined();
    push("1.2.0", "far", at - 1_500);
    const running = registry().plugin("botling.catchup")!;
    expect(running.pushed).toBeUndefined();
    expect(running.folder).toBe(join(shipped, "botling.catchup"));
  });

  it("an in-place update of the build (its manifest rewritten after the push) drops the push", () => {
    const { registry, push, shipped, stamp } = setup();
    const pushedAt = Date.now() + 10_000;
    push("1.2.0", "mine", pushedAt);
    expect(registry().plugin("botling.catchup")!.pushed).toBeDefined();
    // only the manifest file is rewritten (same folder, same inode): the build's laid-down time is its modification time
    utimesSync(join(shipped, "botling.catchup", "package.json"), new Date(pushedAt + 60_000), new Date(pushedAt + 60_000));
    expect(registry().plugin("botling.catchup")!.pushed).toBeUndefined();
    expect(existsSync(stamp())).toBe(false);
  });
});

describe("push-builtin-plugin and a plugin with agent commands", () => {
  it("says that the app's own flags run the build's copy of those commands", async () => {
    const desktop = tempDir("push-agent-desktop");
    plugin(join(desktop, "builtin-plugins"), "botling.report", "1.0.0", "src");
    const dataDir = tempDir("push-agent-data");
    const lines: string[] = [];
    const build = async (name: string) => {
      const folder = plugin(tempDir("push-agent-built"), name, "1.0.0", "b");
      writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js", contributes: { agentCommands: [{ flag: "--render-report", script: "dist/web.js" }] } } }));
      return folder;
    };
    await pushBuiltinPlugin({ name: "botling.report", desktopDir: desktop, dataDir, build, check: () => [], log: (line) => lines.push(line) });
    expect(lines.some((line) => line.includes("agent commands"))).toBe(true);
    const quiet: string[] = [];
    await pushBuiltinPlugin({ name: "botling.report", desktopDir: desktop, dataDir, build: async (name) => plugin(tempDir("push-agent-plain"), name, "1.0.0", "p"), check: () => [], log: (line) => quiet.push(line) });
    expect(quiet.some((line) => line.includes("agent commands"))).toBe(false);
  });
});
