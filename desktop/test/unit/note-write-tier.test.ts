// M7-04a: a bot's note is changed only through its write-tier server part. The core's note requests (`notes.write`,
// `notes.importAsset`, `notes.localizeImages`, `notes.mode` with a mode) are answered only for a plugin that ships with Botling
// and says `ccb.owns: ["note"]` (core/plugins/plugin-owns.ts); another plugin with the `files` permission still reads the note
// but is refused every write with a clear error. The bots' own `app_note_*` tools use the core's note store and never come
// through here (note-tools.test.ts, unedited). Over the wire the Note's frame sends `plugins.call{name:"botling.note"}` with `via`:
// a forged one naming the Note from another plugin is refused `grant` at the owner (M5-15, server/slots/grant-check.ts, unchanged).
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until, desktop } from "../helpers";
import type { Command } from "../../src/contract";
import type { PluginRow } from "../../src/protocol/table-rows";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { grantAllows } from "../../src/server/slots/grant-check";

const WHO = /is only for the plugin that owns the notes/;

function plugin(root: string, name: string, ccb: Record<string, unknown>, version = "1.0.0") {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: name, version, engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", ...ccb } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

/** `build` makes the plugins of `<dir>/builtin` (shipped) and `<dir>/plugins` (library); `ask` is what the plugin host's `ask` reaches. */
async function setup(build: (dir: string) => void) {
  const dir = tempDir("note-write-tier");
  build(dir);
  const note = join(dir, "project", ".bot", "note.md");
  const world = {
    bots: () => [{ id: "main", name: "Main bot", role: "main", awake: true }],
    notice: () => {}, openPanel: () => {}, appSettings: () => ({}), shortcutOverrides: () => ({}),
    botNote: (botId: string) => (botId === "main" ? note : null),
    imageUrl: (_path: string, type: string) => `botling-card://image/${type}`,
    changed: () => {}, broken: () => {}, log: () => {},
  } as unknown as PluginWorld;
  let handlers!: HostHandlers;
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      queueMicrotask(() => handlers.data(JSON.stringify({ method: "ready", params: {} }) + "\n"));
      return {
        pid: 4245,
        write: (text) => {
          const message = JSON.parse(text);
          if (message.method === "load") handlers.data(JSON.stringify({ id: message.id, result: { loaded: message.params.plugins.map((spec: { name: string }) => spec.name), failed: [] } }) + "\n");
          if (message.method === "shutdown") handlers.data(JSON.stringify({ id: message.id, result: null }) + "\n");
        },
        terminate: async () => {},
      };
    },
  };
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key"), builtIns: join(dir, "builtin") });
  running.push(plugins);
  await plugins.start();
  await until(() => plugins.host.running);
  const ask = (method: string, params: unknown): Promise<any> => plugins["requested"](method, params);
  return { dir, note, ask };
}

const FILES = { permissions: ["files"] };
const OWNS_NOTE = { permissions: ["files"], owns: ["note"] };
const withoutIds = (text: string) => text.replace(/^<!-- cell: [A-Za-z0-9_-]+ -->\n/, "").replace(/^<!-- cell: [A-Za-z0-9_-]+ -->$/gm, "<!-- cell -->");

/** Every request that changes a bot's note, as a plugin asks it. */
const WRITES: [string, Record<string, unknown>][] = [
  ["notes.write", { bot: "main", text: "# mine\n" }],
  ["notes.importAsset", { bot: "main", data: Buffer.from("pasted").toString("base64"), name: "image.png" }],
  ["notes.localizeImages", { bot: "main" }],
  ["notes.mode", { bot: "main", mode: "file" }],
];

describe("who may write a bot's note (M7-04a)", () => {
  it("the built-in Note (ships with Botling, owns the note) saves it; a stale base is still refused", async () => {
    const { ask, note } = await setup((dir) => plugin(join(dir, "builtin"), "botling.note", OWNS_NOTE));
    const first = await ask("notes.read", { plugin: "botling.note", bot: "main" });
    const saved = await ask("notes.write", { plugin: "botling.note", bot: "main", text: "# Ideas\n", base: first.mtime });
    expect(saved).toEqual({ saved: true, mtime: expect.any(Number) });
    expect(withoutIds(readFileSync(note, "utf8"))).toBe("# Ideas\n");
    expect(await ask("notes.write", { plugin: "botling.note", bot: "main", text: "late", base: first.mtime - 1000 })).toMatchObject({ saved: false });
    expect(await ask("notes.importAsset", { plugin: "botling.note", bot: "main", data: Buffer.from("pasted").toString("base64"), name: "image.png" })).toMatchObject({ ref: expect.stringMatching(/^note-assets\//) });
    expect(await ask("notes.localizeImages", { plugin: "botling.note", bot: "main" })).toMatchObject({ saved: true });
    expect(await ask("notes.mode", { plugin: "botling.note", bot: "main", mode: "file" })).toMatchObject({ mode: "file" });
  });

  it("the shipped botling.note package.json says it owns the note, and that is what lets it write", async () => {
    const real = JSON.parse(readFileSync(join(desktop, "builtin-plugins", "botling.note", "package.json"), "utf8"));
    expect(real.ccb.owns).toEqual(["note"]);
    expect(real.ccb.permissions).toContain("files");
    const { ask } = await setup((dir) => {
      const folder = join(dir, "builtin", "botling.note");
      mkdirSync(join(folder, "dist"), { recursive: true });
      cpSync(join(desktop, "builtin-plugins", "botling.note", "package.json"), join(folder, "package.json"));
      cpSync(join(desktop, "builtin-plugins", "botling.note", "skills"), join(folder, "skills"), { recursive: true });
      writeFileSync(join(folder, "dist", "host.js"), "export function activate() {}");
      writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
    });
    expect(await ask("notes.write", { plugin: "botling.note", bot: "main", text: "from the real manifest\n" })).toMatchObject({ saved: true });
  });

  it("a plugin with the files permission is refused every note write with a clear error, and the note stays untouched", async () => {
    const { ask, note } = await setup((dir) => {
      plugin(join(dir, "plugins"), "nosy", FILES);
      plugin(join(dir, "builtin"), "botling.other", FILES);
    });
    for (const name of ["nosy", "botling.other"]) {
      for (const [method, params] of WRITES) await expect(ask(method, { plugin: name, ...params }), `${name} ${method}`).rejects.toThrow(WHO);
    }
    await expect(ask("notes.write", { plugin: "nosy", bot: "main", text: "x" })).rejects.toThrow('"nosy" does not');
    expect(existsSync(note)).toBe(false);
  });

  it("owns is honoured only for a plugin shipped with Botling: a library plugin that names it, or a library copy that replaces the Note, owns nothing", async () => {
    const { ask, note } = await setup((dir) => {
      plugin(join(dir, "plugins"), "pretender", OWNS_NOTE);
      plugin(join(dir, "builtin"), "botling.note", OWNS_NOTE, "1.0.0");
      // A newer library copy of the Note takes its place (registry.ts) and is a library plugin: its `owns` counts for nothing.
      plugin(join(dir, "plugins"), "botling.note", OWNS_NOTE, "2.0.0");
    });
    await expect(ask("notes.write", { plugin: "pretender", bot: "main", text: "x" })).rejects.toThrow(WHO);
    await expect(ask("notes.write", { plugin: "botling.note", bot: "main", text: "x" })).rejects.toThrow(WHO);
    expect(existsSync(note)).toBe(false);
  });

  it("a shipped plugin owns only what its package.json names: another name, a wrong type or a bad entry is no ownership of the note", async () => {
    const { ask } = await setup((dir) => {
      plugin(join(dir, "builtin"), "botling.board", { permissions: ["files"], owns: ["board"] });
      plugin(join(dir, "builtin"), "botling.str", { permissions: ["files"], owns: "note" });
      plugin(join(dir, "builtin"), "botling.bad", { permissions: ["files"], owns: [7, "", "no way", null] });
    });
    for (const name of ["botling.board", "botling.str", "botling.bad"]) await expect(ask("notes.write", { plugin: name, bot: "main", text: "x" }), name).rejects.toThrow(WHO);
  });

  it("the owner still needs the files permission first; reads are open to any plugin with it (the gate is on writes only)", async () => {
    const { ask, note } = await setup((dir) => {
      plugin(join(dir, "builtin"), "botling.noperm", { permissions: [], owns: ["note"] });
      plugin(join(dir, "plugins"), "reader", FILES);
    });
    await expect(ask("notes.write", { plugin: "botling.noperm", bot: "main", text: "x" })).rejects.toThrow('Changing a bot\'s note needs the "files" permission');
    expect(await ask("notes.read", { plugin: "reader", bot: "main" })).toEqual({ path: note, text: "", mtime: expect.any(Number) });
    expect(await ask("notes.mode", { plugin: "reader", bot: "main" })).toMatchObject({ mode: expect.any(String) });
    expect(await ask("notes.outline", { plugin: "reader", bot: "main" })).toMatchObject({ cells: expect.any(Array) });
    expect(await ask("notes.parse", { plugin: "reader", text: "hello\n" })).toMatchObject({ cells: expect.any(Array) });
    expect(await ask("notes.assetUrls", { plugin: "reader", bot: "main", refs: [] })).toEqual({});
  });
});

describe("a forged call naming the Note (M5-15 at the owner, unchanged)", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);
  const row = (codeHash: string): PluginRow => ({
    codeHash,
    manifest: { tier: "write", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
    author: "user",
    grants: { [codeHash]: { tier: "write", reads: [], requests: [], grantedBy: "user", at: 1 } },
  } as PluginRow);
  const call = (name: string): Command => ({ type: "plugins.call", name, method: "write", params: { text: "x" }, from: "frame" } as Command);

  it("a write-tier plugin's `plugins.call` naming botling.note is refused; the Note's own call, under its grant, passes", () => {
    const forged = grantAllows(row(H1), { plugin: "evil", codeHash: H1 }, call("botling.note"), "box", ["evil", "botling.note"]);
    expect(forged).toEqual({ ok: false, detail: "plugin evil may not do this on box" });
    const builtinNote: PluginRow = { ...row(H2), author: "builtin", grants: { [H2]: { tier: "write", reads: [], requests: [], grantedBy: "builtin", at: 1 } } };
    expect(grantAllows(builtinNote, { plugin: "botling.note", codeHash: H2 }, call("botling.note"), "box", ["evil", "botling.note"])).toEqual({ ok: true });
    // The same row under another plugin's via, or the Note's name under the Note's old hash: no grant.
    expect(grantAllows(builtinNote, { plugin: "botling.note", codeHash: H1 }, call("botling.note"), "box", ["botling.note"]).ok).toBe(false);
    expect(grantAllows(builtinNote, { plugin: "botling.note", codeHash: H2 }, call("evil"), "box", ["evil", "botling.note"]).ok).toBe(false);
  });
});
