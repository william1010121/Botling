// M7-09a: the `plugin:<name>` row names the plugin's web bundle by one content reference (`files.web`, Q-M7-C3).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { contentUrlPath, type DeviceScope } from "../../src/protocol";
import { PluginRow, TABLE_ROW_CHARS, TableRow } from "../../src/protocol/table-rows";
import { PLUGIN_BUNDLE_MAX_BYTES, isPluginWebRef, pluginWebRef, readWebBundle } from "../../src/server/content/plugin-bundle";
import { RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { PluginHashCache, installedFromRegistry, reconcilePluginRows } from "../../src/server/replica/plugin-rows";
import { ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import { tempDir } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
}

const sha = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function writePlugin(root: string, name: string, web: string | null, permissions: string[] = ["messages"]): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name, version: "1.0.0", engines: { ccb: "^2.0.0" },
    ccb: { permissions, ...(web === null ? {} : { web: "dist/web.js" }) },
  }));
  if (web !== null) writeFileSync(join(folder, "dist", "web.js"), web);
  return folder;
}

function setup(plugins: Record<string, string | null>) {
  const dir = scratch("plugin-web-ref");
  const builtIns = join(dir, "builtins");
  const library = join(dir, "plugins");
  mkdirSync(builtIns, { recursive: true });
  mkdirSync(library, { recursive: true });
  const folders: Record<string, string> = {};
  for (const [name, web] of Object.entries(plugins)) folders[name] = writePlugin(builtIns, name, web);
  const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), builtIns);
  const bundlesDir = join(dir, "plugin-bundles");
  const cache = new PluginHashCache({ bundlesDir });
  const { db, writer } = memoryStore();
  const stream = ownTableStream(db);
  const sync = async (now = 1_000) => writer.submit((tx) => reconcilePluginRows(tx, stream, cache.read(registry.plugins), now));
  const row = (name: string) => readRowBody(db, stream, `plugin:${name}`) as PluginRow | null;
  return { dir, folders, registry, bundlesDir, cache, db, writer, stream, sync, row };
}

describe("M7-09a: the plugin row names its web bundle by content reference", () => {
  it("carries files.web whose bytes hash to the ref, and the bytes are the web part", async () => {
    const code = "export function activate() { return 'alpha ✓'; }\n";
    const s = setup({ "botling.alpha": code });
    await s.sync();
    const row = s.row("botling.alpha")!;
    const ref = pluginWebRef(row.files)!;
    expect(ref).toBe(sha(code));
    expect(row.files).toEqual({ web: ref });
    const bytes = readWebBundle(s.bundlesDir, ref)!;
    expect(sha(bytes)).toBe(ref);
    expect(bytes.toString("utf8")).toBe(code);
    // The same through the import path's reader.
    expect(installedFromRegistry(s.registry.plugins, { bundlesDir: s.bundlesDir })[0]!.files).toEqual({ web: ref });
    await s.writer.close();
  });

  it("is accepted by a 3.0-era reader (today's PluginRow and TableRow parse) and stays far under TABLE_ROW_CHARS", async () => {
    // The largest bundle (5 MB) makes the row no larger: it holds one reference, never the bytes.
    const big = "x".repeat(PLUGIN_BUNDLE_MAX_BYTES);
    const s = setup({ "botling.big": big, "botling.small": "export {};\n" });
    await s.sync();
    for (const name of ["botling.big", "botling.small"]) {
      const row = s.row(name)!;
      expect(row.files).toBeDefined();
      expect(PluginRow.safeParse(row).success).toBe(true);
      expect(TableRow.safeParse({ key: `plugin:${name}`, rev: 1, body: row }).success).toBe(true);
      expect(JSON.stringify(row).length).toBeLessThan(TABLE_ROW_CHARS / 8);
    }
    await s.writer.close();
  });

  it("writes no files for a plugin without a web part, or with a bundle over the cap", async () => {
    const s = setup({ "botling.none": null, "botling.huge": "y".repeat(PLUGIN_BUNDLE_MAX_BYTES + 1) });
    await s.sync();
    expect(s.row("botling.none")).not.toBeNull();
    expect(Object.hasOwn(s.row("botling.none")!, "files")).toBe(false);
    expect(Object.hasOwn(s.row("botling.huge")!, "files")).toBe(false);
    expect(readdirSync(s.bundlesDir).filter((name) => !name.endsWith(".tmp"))).toEqual([]);
    await s.writer.close();
  });

  it("never reads a web part outside the plugin folder", () => {
    const s = setup({ "botling.link": "export {};\n" });
    const outside = join(s.dir, "outside.js");
    writeFileSync(outside, "secret();\n");
    rmSync(join(s.folders["botling.link"]!, "dist", "web.js"));
    // A link out of the folder is skipped (checked on the real path).
    symlinkSync(outside, join(s.folders["botling.link"]!, "dist", "web.js"));
    s.registry.rescan();
    const inputs = s.cache.read(s.registry.plugins);
    expect(inputs.find((input) => input.name === "botling.link")?.files).toBeUndefined();
  });

  it("an edit of the web part changes the ref, rewrites the row once and drops the old bundle", async () => {
    const s = setup({ "botling.edit": "export const v = 1;\n" });
    await s.sync(1_000);
    const first = pluginWebRef(s.row("botling.edit")!.files)!;
    const again = await s.sync(2_000);
    expect(again.written).toBe(0);
    writeFileSync(join(s.folders["botling.edit"]!, "dist", "web.js"), "export const v = 2;\n");
    s.registry.rescan();
    const second = await s.sync(3_000);
    expect(second.written).toBe(1);
    const next = pluginWebRef(s.row("botling.edit")!.files)!;
    expect(next).toBe(sha("export const v = 2;\n"));
    expect(next).not.toBe(first);
    expect(existsSync(join(s.bundlesDir, first.slice(7)))).toBe(false);
    expect(readWebBundle(s.bundlesDir, next)).not.toBeNull();
    await s.writer.close();
  });

  it("pluginWebRef takes only { web: 'sha256:<64 hex>' }", () => {
    const ref = sha("a");
    expect(pluginWebRef({ web: ref })).toBe(ref);
    for (const bad of [undefined, null, "x", [], {}, { web: 1 }, { web: "sha256:abc" }, { web: ref.toUpperCase() }, JSON.parse('{"__proto__":{"web":"' + ref + '"}}')]) {
      expect(pluginWebRef(bad)).toBeNull();
    }
  });
});

describe("M7-09a: tickets for a bundle are bound to the plugin", () => {
  const DEVICE = "device-a";
  async function serving() {
    const s = setup({ "plugin-a": "export const who = 'A';\n", "plugin-b": "export const who = 'B';\n" });
    await s.sync();
    // Grants (the running hash granted read) so the plugin check of the ticket path passes for both.
    for (const name of ["plugin-a", "plugin-b"]) {
      const row = s.row(name)!;
      await s.writer.submit((tx) => putRow(tx, s.stream, `plugin:${name}`, {
        ...row, grants: { ...row.grants, [row.codeHash]: { tier: "read", reads: [], requests: [], grantedBy: "user", at: 1 } },
      }));
    }
    const self = s.stream.slice(4);
    const devices = new Map<string, DeviceScope[]>([[DEVICE, ["read"]]]);
    const remote = new RemoteContent({
      service: { serverId: self, locate: () => null, open: async (m: { req: string; id: string }) => ({ t: "content.gone", req: m.req, id: m.id, reason: "denied" }), markChanged: async () => undefined } as never,
      tickets: new ContentTickets(),
      roster: { device: (member: string) => (devices.has(member) ? { keys: { sign: "s", dh: "d" }, scope: devices.get(member)! } : null) },
      reader: () => s.db,
      pluginBundlesDir: s.bundlesDir,
    });
    const ref = (name: string) => pluginWebRef(s.row(name)!.files)!;
    const entry = { stream: s.stream as `srv:${string}`, seq: 1 };
    const ticket = (plugin: string, id: string) => remote.ticket(DEVICE, { t: "content.ticket", req: "r", owner: self, id, entry, plugin });
    const get = (id: string, plugin: string, token: string) =>
      remote.respond(contentUrlPath({ owner: self, id, variant: "original", entry, ticket: token, plugin }), new Request("http://local/"));
    return { s, self, remote, ref, entry, ticket, get, devices };
  }

  it("a ticket for A's ref serves A's bytes (hash-checked), as JavaScript", async () => {
    const t = await serving();
    const granted = await t.ticket("plugin-a", t.ref("plugin-a"));
    expect(granted.t).toBe("content.granted");
    const res = await t.get(t.ref("plugin-a"), "plugin-a", (granted as { ticket: string }).ticket);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(t.ref("plugin-a"));
    await t.s.writer.close();
  });

  it("a ticket for A's ref does not serve B's frame: not as B's claim, not for B's ref, not by asking B for A's ref", async () => {
    const t = await serving();
    const grantedA = (await t.ticket("plugin-a", t.ref("plugin-a"))) as { ticket: string };
    // B's claim with A's ticket: the ticket is bound to plugin A.
    expect((await t.get(t.ref("plugin-a"), "plugin-b", grantedA.ticket)).status).toBe(403);
    // A's ticket for B's ref: the ticket is bound to A's ref.
    expect((await t.get(t.ref("plugin-b"), "plugin-a", grantedA.ticket)).status).toBe(403);
    // B cannot be given a ticket for A's ref, and A not for B's.
    expect((await t.ticket("plugin-b", t.ref("plugin-a"))).t).toBe("content.gone");
    expect((await t.ticket("plugin-a", t.ref("plugin-b"))).t).toBe("content.gone");
    await t.s.writer.close();
  });

  it("re-checks the row at every request: an updated row, a removed grant or a tombstoned row refuses the old ticket", async () => {
    const t = await serving();
    const granted = (await t.ticket("plugin-a", t.ref("plugin-a"))) as { ticket: string };
    const oldRef = t.ref("plugin-a");
    // The row now names another bundle (an update): the old ref is no longer this plugin's.
    const row = t.s.row("plugin-a")!;
    await t.s.writer.submit((tx) => putRow(tx, t.s.stream, "plugin:plugin-a", { ...row, files: { web: sha("newer") } }));
    expect((await t.get(oldRef, "plugin-a", granted.ticket)).status).toBe(404);
    expect(isPluginWebRef(t.s.db, t.self, "plugin-a", oldRef)).toBe(false);
    await t.s.writer.close();
  });

  it("refuses when the bytes no longer hash to the ref, when the file is gone, and for another variant", async () => {
    const t = await serving();
    const ref = t.ref("plugin-a");
    const granted = (await t.ticket("plugin-a", ref)) as { ticket: string };
    const file = join(t.s.bundlesDir, ref.slice(7));
    writeFileSync(file, "tampered();\n");
    expect((await t.get(ref, "plugin-a", granted.ticket)).status).toBe(410);
    expect((await t.ticket("plugin-a", ref)).t).toBe("content.gone");
    rmSync(file);
    expect((await t.get(ref, "plugin-a", granted.ticket)).status).toBe(410);
    const variantUrl = contentUrlPath({ owner: t.self, id: ref, variant: "poster", entry: t.entry, ticket: granted.ticket, plugin: "plugin-a" });
    expect((await t.remote.respond(variantUrl, new Request("http://local/"))).status).toBe(404);
    await t.s.writer.close();
  });

  it("serves nothing for another owner, another stream, no plugin claim or a server without a bundles folder", async () => {
    const t = await serving();
    const ref = t.ref("plugin-a");
    const msg = { t: "content.ticket" as const, req: "r", id: ref, entry: t.entry, plugin: "plugin-a" };
    expect((await t.remote.ticket(DEVICE, { ...msg, owner: "someone-else" })).t).toBe("content.gone");
    expect((await t.remote.ticket(DEVICE, { ...msg, owner: t.self, entry: { stream: "srv:someone-else", seq: 1 } })).t).toBe("content.gone");
    const bare = new RemoteContent({
      service: { serverId: t.self, locate: () => null, open: async (m: { req: string; id: string }) => ({ t: "content.gone", req: m.req, id: m.id, reason: "denied" }), markChanged: async () => undefined } as never,
      tickets: new ContentTickets(),
      roster: { device: () => ({ keys: { sign: "s", dh: "d" }, scope: ["read" as DeviceScope] }) },
      reader: () => t.s.db,
    });
    expect((await bare.ticket(DEVICE, { ...msg, owner: t.self })).t).toBe("content.gone");
    // A device without the read scope gets no ticket.
    t.devices.set(DEVICE, ["reply"]);
    expect((await t.ticket("plugin-a", ref)).t).toBe("content.gone");
    await t.s.writer.close();
  });
});

describe("M7-09a: the row file stays a plain read of the bundle", () => {
  it("readWebBundle refuses a reference that is not sha256:<64 hex> (never a path from other text)", () => {
    const dir = scratch("plugin-bundle-ref");
    writeFileSync(join(dir, "secret"), "x");
    for (const ref of ["../secret", "sha256:../secret", "secret", `sha256:${"a".repeat(63)}`, `sha256:${"A".repeat(64)}`]) {
      expect(readWebBundle(dir, ref)).toBeNull();
    }
    expect(readFileSync(join(dir, "secret"), "utf8")).toBe("x");
  });
});
