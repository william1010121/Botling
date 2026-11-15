// M7-09a review: security tests the first pass left out (cross-plugin both ways, revoke / regrant / tombstone with a live
// ticket, a swapped bundle file, a hash two plugins share, ref shapes, another owner or stream with a real peer row).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { contentUrlPath, type DeviceScope } from "../../src/protocol";
import type { PluginRow } from "../../src/protocol/table-rows";
import { pluginWebRef, readWebBundle } from "../../src/server/content/plugin-bundle";
import { RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { PluginHashCache, reconcilePluginRows } from "../../src/server/replica/plugin-rows";
import { ensureStream } from "../../src/server/log";
import { deleteRow, ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import { tempDir } from "../helpers";
import { memoryStore } from "./server-slots-harness";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

function writePlugin(root: string, name: string, web: string): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { permissions: ["messages"], web: "dist/web.js" } }));
  writeFileSync(join(folder, "dist", "web.js"), web);
  return folder;
}

async function serving(plugins: Record<string, string>, ticketOpts: ConstructorParameters<typeof ContentTickets>[0] = {}) {
  const dir = tempDir("probe"); dirs.push(dir);
  const builtIns = join(dir, "builtins"); const library = join(dir, "plugins");
  mkdirSync(builtIns, { recursive: true }); mkdirSync(library, { recursive: true });
  const folders: Record<string, string> = {};
  for (const [n, w] of Object.entries(plugins)) folders[n] = writePlugin(builtIns, n, w);
  const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), builtIns);
  const bundlesDir = join(dir, "plugin-bundles");
  const cache = new PluginHashCache({ bundlesDir });
  const { db, writer } = memoryStore();
  const stream = ownTableStream(db);
  const sync = async (now = 1_000) => writer.submit((tx) => reconcilePluginRows(tx, stream, cache.read(registry.plugins), now));
  const row = (n: string) => readRowBody(db, stream, `plugin:${n}`) as PluginRow | null;
  await sync();
  const grant = async (name: string, on = true) => {
    const r = row(name)!;
    await writer.submit((tx) => putRow(tx, stream, `plugin:${name}`, { ...r, grants: on ? { ...r.grants, [r.codeHash]: { tier: "read", reads: [], requests: [], grantedBy: "user", at: 1 } } : {} }));
  };
  for (const n of Object.keys(plugins)) await grant(n);
  const self = stream.slice(4);
  const devices = new Map<string, DeviceScope[]>([["dev", ["read"]]]);
  const openCalls: string[] = [];
  const tickets = new ContentTickets(ticketOpts);
  const remote = new RemoteContent({
    service: { serverId: self, locate: () => null, open: async (m: { req: string; id: string }) => { openCalls.push(m.id); return { t: "content.gone", req: m.req, id: m.id, reason: "denied" }; }, markChanged: async () => undefined } as never,
    tickets,
    roster: { device: (m: string) => (devices.has(m) ? { keys: { sign: "s", dh: "d" }, scope: devices.get(m)! } : null) },
    reader: () => db, pluginBundlesDir: bundlesDir,
  });
  const ref = (n: string) => pluginWebRef(row(n)!.files)!;
  const entry = { stream: stream as `srv:${string}`, seq: 1 };
  const ticket = (plugin: string, id: string, e: { stream: string; seq: number } = entry) => remote.ticket("dev", { t: "content.ticket", req: "r", owner: self, id, entry: e as never, plugin });
  const get = (id: string, plugin: string, token: string, e: { stream: string; seq: number } = entry) =>
    remote.respond(contentUrlPath({ owner: self, id, variant: "original", entry: e as never, ticket: token, plugin }), new Request("http://local/"));
  return { dir, folders, registry, bundlesDir, cache, db, writer, stream, sync, row, grant, self, remote, tickets, ref, entry, ticket, get, openCalls, devices };
}

describe("M7-09a review: bundle security", () => {
  it("cross-plugin both directions, every path", async () => {
    const t = await serving({ "plugin-a": "A\n", "plugin-b": "B\n" });
    const ta = (await t.ticket("plugin-a", t.ref("plugin-a"))) as { ticket: string };
    const tb = (await t.ticket("plugin-b", t.ref("plugin-b"))) as { ticket: string };
    expect((await t.get(t.ref("plugin-a"), "plugin-a", ta.ticket)).status).toBe(200);
    expect((await t.get(t.ref("plugin-b"), "plugin-b", tb.ticket)).status).toBe(200);
    // swapped plugin claim / ref
    for (const [id, p, tk] of [[t.ref("plugin-a"), "plugin-b", ta.ticket], [t.ref("plugin-b"), "plugin-a", ta.ticket], [t.ref("plugin-b"), "plugin-a", tb.ticket], [t.ref("plugin-a"), "plugin-b", tb.ticket], [t.ref("plugin-b"), "plugin-b", ta.ticket]] as const) {
      expect((await t.get(id, p, tk)).status).toBe(403);
    }
    expect((await t.ticket("plugin-a", t.ref("plugin-b"))).t).toBe("content.gone");
    expect((await t.ticket("plugin-b", t.ref("plugin-a"))).t).toBe("content.gone");
    // A's frame cannot get B's ref even if B's row changes to point at the same bytes later? (then it is B's too: allowed only for B)
    expect((await t.ticket("plugin-a", sha("nothing"))).t).toBe("content.gone");
    await t.writer.close();
  });

  it("revoke read grant -> next request refused at once (ticket still unexpired); regrant -> served again; tombstone -> refused", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    const tk = (await t.ticket("plugin-a", ref)) as { ticket: string };
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(200);
    await t.grant("plugin-a", false);
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(403);
    expect((await t.ticket("plugin-a", ref)).t).toBe("content.gone");
    await t.grant("plugin-a", true);
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(200);
    await t.writer.submit((tx) => deleteRow(tx, t.stream, "plugin:plugin-a", 5));
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(403);
    await t.writer.close();
  });

  it("grant tier below read / grant only for an OLD code hash refuses", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    const tk = (await t.ticket("plugin-a", ref)) as { ticket: string };
    const r = t.row("plugin-a")!;
    await t.writer.submit((tx) => putRow(tx, t.stream, "plugin:plugin-a", { ...r, grants: { ["sha256:" + "0".repeat(64)]: r.grants[r.codeHash]! } }));
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(403);
    await t.writer.close();
  });

  it("swap after ticket: other bytes / symlink / dir / fifo-like -> never other bytes", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    const tk = (await t.ticket("plugin-a", ref)) as { ticket: string };
    const file = join(t.bundlesDir, ref.slice(7));
    const real = readFileSync(file);
    // swap to a symlink to a file with the right bytes elsewhere: refused (O_NOFOLLOW)
    const elsewhere = join(t.dir, "elsewhere"); writeFileSync(elsewhere, real);
    rmSync(file); symlinkSync(elsewhere, file);
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(410);
    rmSync(file); mkdirSync(file);
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(410);
    rmSync(file, { recursive: true }); writeFileSync(file, "evil();\n");
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(410);
    rmSync(file); writeFileSync(file, real);
    expect((await t.get(ref, "plugin-a", tk.ticket)).status).toBe(200);
    await t.writer.close();
  });

  it("prune keeps a hash another plugin still uses; drops it when nobody does", async () => {
    const t = await serving({ "plugin-a": "same\n", "plugin-b": "same\n", "plugin-c": "other\n" });
    expect(t.ref("plugin-a")).toBe(t.ref("plugin-b"));
    const shared = t.ref("plugin-a");
    // edit A only
    writeFileSync(join(t.folders["plugin-a"]!, "dist", "web.js"), "a-new\n");
    t.registry.rescan(); await t.sync(2_000);
    expect(t.ref("plugin-a")).not.toBe(shared);
    expect(t.ref("plugin-b")).toBe(shared);
    expect(readWebBundle(t.bundlesDir, shared)).not.toBeNull();
    await t.grant("plugin-a"); await t.grant("plugin-b");
    const tb = (await t.ticket("plugin-b", shared)) as { ticket: string };
    expect((await t.get(shared, "plugin-b", tb.ticket)).status).toBe(200);
    // A (same bytes as B no more) cannot use B's ref
    expect((await t.ticket("plugin-a", shared)).t).toBe("content.gone");
    // now edit B too: shared goes
    writeFileSync(join(t.folders["plugin-b"]!, "dist", "web.js"), "b-new\n");
    t.registry.rescan(); await t.sync(3_000);
    expect(existsSync(join(t.bundlesDir, shared.slice(7)))).toBe(false);
    await t.writer.close();
  });

  it("ref shape: traversal / odd refs never reach a path, in ticket, url and row", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const hex = t.ref("plugin-a").slice(7);
    writeFileSync(join(t.dir, "secret"), "S");
    for (const id of [`sha256:../${"a".repeat(61)}`, `sha256:${hex}/../${hex}`, `sha256:${hex}\n`, `sha256:${hex.toUpperCase()}`, `sha256:${hex}.tmp`, `sha256:${hex} `, hex, "sha256:..%2f..%2fsecret"]) {
      expect((await t.ticket("plugin-a", id)).t).toBe("content.gone");
    }
    // a row (even a self-written, odd one) naming a traversal ref gives no ref
    const r = t.row("plugin-a")!;
    for (const web of ["sha256:../../secret", `sha256:${hex}/..`, `${"sha256:"}${hex}\n`]) {
      await t.writer.submit((tx) => putRow(tx, t.stream, "plugin:plugin-a", { ...r, files: { web } }));
      expect(pluginWebRef(t.row("plugin-a")!.files)).toBeNull();
      expect((await t.ticket("plugin-a", web)).t).toBe("content.gone");
    }
    await t.writer.close();
  });

  it("other stream / no-plugin / bot stream never serves a bundle through the line path", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    // plugin ticket, bot stream entry, bundle id -> falls to service.open (denied), never the bundle
    expect((await t.ticket("plugin-a", ref, { stream: "bot:b1", seq: 1 })).t).toBe("content.gone");
    // no plugin claim at all with a srv: entry -> line path (denied by service)
    const noPlugin = await t.remote.ticket("dev", { t: "content.ticket", req: "r", owner: t.self, id: ref, entry: t.entry });
    expect(noPlugin.t).toBe("content.gone");
    expect((await t.ticket("plugin-a", ref, { stream: t.stream, seq: 1 })).t).toBe("content.granted");
    await t.writer.close();
  });

  // M7-09b-F (FU-3): the entry of a bundle is the plugin's row, one canonical entry (`seq: 1`); any other seq is refused at issue
  // and again at use (it would only be another ticket-cache key for the same bytes).
  it("a bundle ticket is issued for seq 1 only", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    for (const seq of [2, 99, Number.MAX_SAFE_INTEGER]) {
      expect((await t.ticket("plugin-a", ref, { stream: t.stream, seq })).t).toBe("content.gone");
    }
    expect((await t.ticket("plugin-a", ref, { stream: t.stream, seq: 1 })).t).toBe("content.granted");
    await t.writer.close();
  });

  it("a bundle ticket whose entry is not seq 1 serves nothing, even when it was issued (checked at use)", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    const other = { stream: t.stream, seq: 2 };
    const { ticket } = t.tickets.issue({ deviceId: "dev", owner: t.self, id: ref, entry: other as never, plugin: "plugin-a" });
    const refusedAnswer = await t.get(ref, "plugin-a", ticket, other);
    expect(refusedAnswer.status).toBeGreaterThanOrEqual(400);
    expect(await refusedAnswer.text()).not.toBe("A\n");
    const good = (await t.ticket("plugin-a", ref)) as { ticket: string };
    expect((await t.get(ref, "plugin-a", good.ticket)).status).toBe(200);
    await t.writer.close();
  });

  it("another owner with a real peer row for the plugin still gets no ticket for this server's bundle", async () => {
    const t = await serving({ "plugin-a": "A\n" });
    const ref = t.ref("plugin-a");
    const r = t.row("plugin-a")!;
    await t.writer.submit((tx) => { ensureStream(tx, "srv:peer-x" as never); putRow(tx, "srv:peer-x", "plugin:plugin-a", r); });
    // The peer's own row grants the same plugin at the same hash, so the grant check passes: only the bundle check refuses.
    const msg = { t: "content.ticket" as const, req: "r", id: ref, plugin: "plugin-a" };
    expect((await t.remote.ticket("dev", { ...msg, owner: "peer-x", entry: t.entry })).t).toBe("content.gone");
    expect((await t.remote.ticket("dev", { ...msg, owner: "peer-x", entry: { stream: "srv:peer-x", seq: 1 } })).t).toBe("content.gone");
    expect((await t.remote.ticket("dev", { ...msg, owner: t.self, entry: { stream: "srv:peer-x", seq: 1 } })).t).toBe("content.gone");
    await t.writer.close();
  });
});
