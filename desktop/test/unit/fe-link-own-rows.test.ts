// M5-14e: the attached server's own `plugin:` rows reach the page through `link.table(<own id>)` (the same read the
// grant sheet's `linkPluginSource` does for peers). The server sends them as `rows` frames of its own `srv:` stream after
// the front end's ordinary log `sub` of it; the link keeps them apart from the peers' tables, so the log path (cursors,
// `reset`, the outbox's "every table caught" rule) is untouched.
import { afterEach, describe, expect, it } from "vitest";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import type { FeLinkEvent } from "../../src/fe-link/link";
import { OwnRows } from "../../src/fe-link/own-rows";
import { PluginRow, type Rows } from "../../src/protocol/table-rows";
import { FakeClock, FakeServer, flush, SERVER_ID, SRV_STREAM } from "./fe-link-harness";

const links: FeLink[] = [];
afterEach(async () => { for (const link of links.splice(0)) await link.stop(); });

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

const EMPTY = { reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
/** A plugin row of `name` (its code hash differs per name, so no two rows are equal). */
const pluginRow = (name: string): unknown => PluginRow.parse({
  codeHash: `sha256:${name}`, manifest: { tier: "read", ...EMPTY }, author: "user", grants: {},
});

async function attach(server: FakeServer): Promise<{ link: FeLink; events: FeLinkEvent[] }> {
  const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "phone", feVersion: "3.0.0", clock: new FakeClock(), newEpoch: nextEpoch, local: true });
  links.push(link);
  const events: FeLinkEvent[] = [];
  link.on((event) => events.push(event));
  link.start();
  await flush();
  return { link, events };
}

const rowsOf = (stream: string, logId: string, after: number, to: number, rows: Array<Record<string, unknown>>, more = false) =>
  ({ t: "rows", stream, logId, after, to, rows, more });

describe("fe-link: the own server's rows (M5-14e)", () => {
  it("link.table(own) is null until the server sends rows, then holds the plugin rows by key", async () => {
    const server = new FakeServer();
    const { link, events } = await attach(server);
    // The own stream is followed by its log cursor, never as a peer table: one sub, with the log's cursor.
    expect(server.received.filter((m) => m.t === "sub" && m.stream === SRV_STREAM)).toHaveLength(1);
    expect(link.table(SERVER_ID)).toBeNull();
    expect(link.state).toBe("live");

    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 3, [
      { key: "plugin:alpha", rev: 2, body: pluginRow("alpha") },
      { key: "plugin:beta", rev: 3, body: pluginRow("beta") },
    ]));
    await flush();
    const table = link.table(SERVER_ID);
    expect(table).not.toBeNull();
    expect([...table!.rows.keys()].sort()).toEqual(["plugin:alpha", "plugin:beta"]);
    expect(table!.rev).toBe(3);
    expect(PluginRow.safeParse(table!.rows.get("plugin:alpha")).success).toBe(true);
    expect(events).toContainEqual({ type: "servers", table: { stream: SRV_STREAM, changed: ["plugin:alpha", "plugin:beta"], removed: [] } });
    expect(link.state).toBe("live");
  });

  it("a later batch adds, changes and removes rows (tombstone); a gap-free batch below the copy's rev is harmless", async () => {
    const server = new FakeServer();
    const { link, events } = await attach(server);
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 2, [{ key: "plugin:alpha", rev: 2, body: pluginRow("alpha") }]));
    await flush();
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 2, 4, [
      { key: "plugin:beta", rev: 3, body: pluginRow("beta") },
      { key: "plugin:alpha", rev: 4, deleted: true },
    ]));
    await flush();
    expect([...link.table(SERVER_ID)!.rows.keys()]).toEqual(["plugin:beta"]);
    expect(events.at(-1)).toEqual({ type: "servers", table: { stream: SRV_STREAM, changed: ["plugin:beta"], removed: ["plugin:alpha"] } });
    // Overlap (after below the copy's rev): each row is the key's latest change, so applying it again changes nothing.
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 1, 4, [{ key: "plugin:beta", rev: 3, body: pluginRow("beta") }]));
    await flush();
    expect(link.table(SERVER_ID)!.rev).toBe(4);
    expect([...link.table(SERVER_ID)!.rows.keys()]).toEqual(["plugin:beta"]);
  });

  it("the parts of one batch are applied together, once the last is in", async () => {
    const server = new FakeServer();
    const { link } = await attach(server);
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 3, [{ key: "plugin:alpha", rev: 2, body: pluginRow("alpha") }], true));
    await flush();
    expect(link.table(SERVER_ID)).toBeNull();
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 3, [{ key: "plugin:beta", rev: 3, body: pluginRow("beta") }], false));
    await flush();
    expect([...link.table(SERVER_ID)!.rows.keys()].sort()).toEqual(["plugin:alpha", "plugin:beta"]);
  });

  it("a whole table (after: 0) of a new logId replaces the copy: the server was restored", async () => {
    const server = new FakeServer();
    const { link } = await attach(server);
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 3, [
      { key: "plugin:alpha", rev: 2, body: pluginRow("alpha") },
      { key: "plugin:beta", rev: 3, body: pluginRow("beta") },
    ]));
    await flush();
    server.sendWire(rowsOf(SRV_STREAM, "incown02", 0, 1, [{ key: "plugin:gamma", rev: 1, body: pluginRow("gamma") }]));
    await flush();
    const table = link.table(SERVER_ID)!;
    expect(table.logId).toBe("incown02");
    expect([...table.rows.keys()]).toEqual(["plugin:gamma"]);
    expect(table.rev).toBe(1);
    // A delta of the old incarnation that arrives late is dropped.
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 3, 5, [{ key: "plugin:zzz", rev: 5, body: pluginRow("zzz") }]));
    await flush();
    expect([...link.table(SERVER_ID)!.rows.keys()]).toEqual(["plugin:gamma"]);
  });

  it("a delta that starts above the copy's rev is ignored (the next sub brings the whole table)", async () => {
    const server = new FakeServer();
    const { link } = await attach(server);
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 2, [{ key: "plugin:alpha", rev: 2, body: pluginRow("alpha") }]));
    await flush();
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 5, 6, [{ key: "plugin:beta", rev: 6, body: pluginRow("beta") }]));
    await flush();
    expect([...link.table(SERVER_ID)!.rows.keys()]).toEqual(["plugin:alpha"]);
    expect(link.table(SERVER_ID)!.rev).toBe(2);
  });

  it("the copy is not caught on a dropped connection; the rows stay until the next session replaces them", async () => {
    const server = new FakeServer();
    const { link } = await attach(server);
    server.sendWire(rowsOf(SRV_STREAM, "incown01", 0, 2, [{ key: "plugin:alpha", rev: 2, body: pluginRow("alpha") }]));
    await flush();
    expect(link.table(SERVER_ID)!.caught).toBe(true);
    server.kill();
    await flush();
    expect(link.table(SERVER_ID)!.caught).toBe(false);
    expect(link.table(SERVER_ID)!.rows.has("plugin:alpha")).toBe(true);
  });

  it("rows of a stream the link does not follow are still dropped, and a peer's table is not touched by the own one", async () => {
    const server = new FakeServer();
    const { link } = await attach(server);
    server.sendWire(rowsOf("srv:nobody", "incnob01", 0, 1, [{ key: "plugin:alpha", rev: 1, body: pluginRow("alpha") }]));
    await flush();
    expect(link.table("nobody")).toBeNull();
    expect(link.table(SERVER_ID)).toBeNull();
  });
});

describe("OwnRows", () => {
  const whole = (rows: Array<Record<string, unknown>>) => ({ t: "rows", stream: SRV_STREAM, logId: "incown01", after: 0, to: 2, rows, more: false }) as unknown as Rows;
  it("another server than the copy's drops it; the same server keeps it across a new session", () => {
    const own = new OwnRows();
    own.attach("srvA");
    expect(own.onRows(whole([{ key: "plugin:alpha", rev: 2, body: pluginRow("alpha") }]))).toEqual({ changed: ["plugin:alpha"], removed: [] });
    own.detach();
    own.attach("srvA");
    expect(own.view("srvA")?.rows.has("plugin:alpha")).toBe(true);
    expect(own.view("srvA")?.caught).toBe(false);
    own.attach("srvB");
    expect(own.view("srvA")).toBeNull();
    expect(own.view("srvB")).toBeNull();
  });
  it("a delta before any whole table is dropped", () => {
    const own = new OwnRows();
    own.attach("srvA");
    expect(own.onRows({ ...whole([{ key: "plugin:alpha", rev: 2, body: pluginRow("alpha") }]), after: 1 })).toBeNull();
    expect(own.view("srvA")).toBeNull();
  });
});
