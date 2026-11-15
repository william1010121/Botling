// M5-17: content tickets bound to the plugin (§9A.7, D54, plan-change N9, §4.1 check 7).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ContentTicketGrant,
  ContentTicketReq,
  contentUrlPath,
  parseContentUrl,
  type ContentUrl,
  type DeviceScope,
  type EntryRef,
  type StreamId,
} from "../../src/protocol";
import type { PluginRow, Tier } from "../../src/protocol/table-rows";
import { ContentService } from "../../src/server/content";
import { RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { ensureStream } from "../../src/server/log";
import { LoopbackListener } from "../../src/server/net";
import { deleteRow, ownTableStream, putRow } from "../../src/server/replica/tables";
import { openServerStore, type ServerStore } from "../../src/server/store";

const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
const BOT = "b1";
const STREAM = `bot:${BOT}` as StreamId;
const HASH_1 = "sha256:" + "1".repeat(64);
const HASH_2 = "sha256:" + "2".repeat(64);

function makePluginRow(codeHash: string, grantedHash: string | null, tier: Tier = "read"): PluginRow {
  return {
    codeHash,
    manifest: {
      tier,
      reads: [],
      requests: [],
      owns: [],
      provides: [],
      requires: [],
      uses: [],
      clients: [],
      needsShell: [],
    },
    author: "user",
    grants: grantedHash
      ? {
          [grantedHash]: {
            tier,
            reads: [],
            requests: [],
            grantedBy: "user",
            at: 1_763_100_000_000,
          },
        }
      : {},
  };
}

let scratch: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "botling-ticket-plugin-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

async function listen(content: RemoteContent): Promise<string> {
  const listener = await LoopbackListener.start({
    port: 0,
    remote: { accept: () => { throw new Error("no sessions here"); } },
    pageDir: null,
    origins: () => [],
    log: () => undefined,
    content,
  });
  cleanups.push(() => listener.close());
  return `http://127.0.0.1:${listener.port}`;
}

async function setupServer() {
  const dataDir = join(scratch, "data");
  const mediaDir = join(scratch, "media");
  rmSync(mediaDir, { recursive: true, force: true });
  const store: ServerStore = await openServerStore(dataDir);
  await store.submit((db) => {
    ensureStream(db, STREAM);
    ensureStream(db, ownTableStream(db));
  });
  const service = new ContentService({ store, dataDir, serverId: store.meta("serverId")! });
  cleanups.push(async () => {
    await service.close();
    await store.close();
  });

  const filePath = join(scratch, "sample.png");
  const payload = Buffer.from("png-bytes-for-m5-17-ticket-plugin-test");
  writeFileSync(filePath, payload);
  const posted = await service.appendLine(
    STREAM,
    BOT,
    { id: "m1", text: `![img](${pathToFileURL(filePath).href})`, attachments: [] },
    [{ kind: "message.added", body: { botId: BOT, message: { id: "m1", role: "bot", text: "img", time: "2026-11-15T00:00:00.000Z", state: "done" } } }],
  );
  await posted.ready;
  const located = service.locate({ botId: BOT, line: "m1", url: `file://${filePath}` })!;
  expect(located).not.toBeNull();

  const devices = new Map<string, DeviceScope[]>([
    [DEVICE_A, ["read", "reply"]],
    [DEVICE_B, ["read"]],
  ]);
  const roster = {
    device: (member: string) => {
      const scope = devices.get(member);
      return scope ? { keys: { sign: "s", dh: "d" }, scope } : null;
    },
  };
  const tickets = new ContentTickets();
  const reader = store.openReader();
  cleanups.push(() => reader.close());
  const remote = new RemoteContent({
    service,
    tickets,
    roster,
    reader: () => reader,
  });
  const origin = await listen(remote);

  return {
    store,
    service,
    tickets,
    devices,
    remote,
    origin,
    owner: service.serverId,
    id: located.id,
    entry: located.entry,
    payload,
  };
}

describe("protocol: content ticket and URL plugin binding", () => {
  it("accepts optional plugin on content.ticket and ContentTicketGrant, and round-trips p=<plugin>", () => {
    const entry: EntryRef = { stream: STREAM, seq: 1 };
    const reqWithPlugin = ContentTicketReq.safeParse({
      t: "content.ticket",
      req: "r1",
      owner: "server-own",
      id: "sha256:" + "a".repeat(64),
      entry,
      plugin: "plugin-a",
    });
    expect(reqWithPlugin.success).toBe(true);
    expect(
      ContentTicketReq.safeParse({
        t: "content.ticket",
        req: "r2",
        owner: "server-own",
        id: "sha256:" + "a".repeat(64),
        entry,
        plugin: "Bad Plugin",
      }).success,
    ).toBe(false);

    const grantWithPlugin = ContentTicketGrant.safeParse({
      ticket: "A".repeat(43),
      deviceId: DEVICE_A,
      owner: "server-own",
      id: "sha256:" + "a".repeat(64),
      entry,
      expiresAt: 1_763_100_600_000,
      plugin: "plugin-a",
    });
    expect(grantWithPlugin.success).toBe(true);

    const url: ContentUrl = {
      owner: "server-own",
      id: "sha256:" + "a".repeat(64),
      variant: "original",
      entry,
      ticket: "A".repeat(43),
      plugin: "plugin-a",
    };
    const path = contentUrlPath(url);
    expect(path).toContain("&p=plugin-a");
    expect(parseContentUrl(path)).toEqual(url);
    expect(parseContentUrl(`${path}&p=plugin-b`)).toBeNull();
    expect(parseContentUrl(path.replace("p=plugin-a", "p=Bad%20Plugin"))).toBeNull();
  });

  it("keeps distinct tickets per plugin and without plugin in ContentTickets", () => {
    const tickets = new ContentTickets();
    const entry: EntryRef = { stream: STREAM, seq: 1 };
    const base = { deviceId: DEVICE_A, owner: "server-own", id: "sha256:" + "a".repeat(64), entry };
    const tShell = tickets.issue(base);
    const tA = tickets.issue({ ...base, plugin: "plugin-a" });
    const tB = tickets.issue({ ...base, plugin: "plugin-b" });

    expect(new Set([tShell.ticket, tA.ticket, tB.ticket]).size).toBe(3);
    expect(tickets.issue({ ...base, plugin: "plugin-a" }).ticket).toBe(tA.ticket);
    expect(tickets.check(tShell.ticket)?.plugin).toBeUndefined();
    expect(tickets.check(tA.ticket)?.plugin).toBe("plugin-a");
    expect(tickets.check(tB.ticket)?.plugin).toBe("plugin-b");
  });
});

describe("M5-17: /v3/c/ plugin ticket enforcement", () => {
  it("1. ticket for plugin A serves A; with p=B -> 403; without p -> 403; revoked/other device -> 403", async () => {
    const s = await setupServer();
    await s.store.submit((tx) => {
      const stream = ownTableStream(tx);
      putRow(tx, stream, "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "read"));
      putRow(tx, stream, "plugin:plugin-b", makePluginRow(HASH_1, HASH_1, "read"));
    });

    const grantedA = await s.remote.ticket(DEVICE_A, {
      t: "content.ticket",
      req: "t1",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    });
    expect(grantedA.t).toBe("content.granted");
    if (grantedA.t !== "content.granted") throw new Error("expected granted");

    // Serves plugin A
    const ok = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: grantedA.ticket, plugin: "plugin-a" }),
    );
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(s.payload);

    // Refuses p=B -> 403
    const wrongPlugin = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: grantedA.ticket, plugin: "plugin-b" }),
    );
    expect(wrongPlugin.status).toBe(403);
    expect(wrongPlugin.headers.get("x-botling-content")).toBe("refused; reason=binding");

    // Refuses missing p -> 403
    const bareUrl = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: grantedA.ticket }),
    );
    expect(bareUrl.status).toBe(403);
    expect(bareUrl.headers.get("x-botling-content")).toBe("refused; reason=binding");

    // Another device gets its own distinct ticket; revoking device-a stops device-a's ticket (403) while device-b still serves
    const grantedBDev = await s.remote.ticket(DEVICE_B, {
      t: "content.ticket",
      req: "t2",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    });
    expect(grantedBDev.t).toBe("content.granted");
    if (grantedBDev.t !== "content.granted") throw new Error("expected granted for device-b");
    expect(grantedBDev.ticket).not.toBe(grantedA.ticket);

    s.devices.delete(DEVICE_A);
    const revokedDevA = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: grantedA.ticket, plugin: "plugin-a" }),
    );
    expect(revokedDevA.status).toBe(403);
    expect(revokedDevA.headers.get("x-botling-content")).toBe("refused; reason=device");

    const okDevB = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: grantedBDev.ticket, plugin: "plugin-a" }),
    );
    expect(okDevB.status).toBe(200);

    // Another device with no read scope cannot get a ticket and its ticket returns 403
    s.devices.set(DEVICE_B, ["reply"]);
    const deniedDevB = await s.remote.ticket(DEVICE_B, {
      t: "content.ticket",
      req: "t3",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    });
    expect(deniedDevB).toMatchObject({ t: "content.gone", reason: "denied" });
    const refusedDevB = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: grantedBDev.ticket, plugin: "plugin-a" }),
    );
    expect(refusedDevB.status).toBe(403);
  });

  it("2. ticket without a plugin (the shell's own) works as before and cannot be widened with p=", async () => {
    const s = await setupServer();
    const granted = await s.remote.ticket(DEVICE_A, {
      t: "content.ticket",
      req: "t1",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
    });
    expect(granted.t).toBe("content.granted");
    if (granted.t !== "content.granted") throw new Error("expected granted");

    // Works even with no plugin rows in srv:
    const ok = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: granted.ticket }),
    );
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(s.payload);

    // Cannot be used with p=plugin-a
    const widened = await fetch(
      s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: granted.ticket, plugin: "plugin-a" }),
    );
    expect(widened.status).toBe(403);
    expect(widened.headers.get("x-botling-content")).toBe("refused; reason=binding");
  });

  it("3. plugin A's row removed, ungranted, or hash-bumped without grant -> stops serving (403)", async () => {
    const s = await setupServer();
    await s.store.submit((tx) => {
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "request"));
    });

    const granted = await s.remote.ticket(DEVICE_A, {
      t: "content.ticket",
      req: "t1",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    });
    expect(granted.t).toBe("content.granted");
    if (granted.t !== "content.granted") throw new Error("expected granted");

    const url = s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: granted.ticket, plugin: "plugin-a" });
    expect((await fetch(url)).status).toBe(200);

    // Hash changed without a grant at the new current hash -> 403
    await s.store.submit((tx) => {
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_2, HASH_1, "read"));
    });
    const hashMismatch = await fetch(url);
    expect(hashMismatch.status).toBe(403);
    expect(hashMismatch.headers.get("x-botling-content")).toBe("refused; reason=plugin");

    // Grant added at new hash -> serves again
    await s.store.submit((tx) => {
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_2, HASH_2, "write"));
    });
    expect((await fetch(url)).status).toBe(200);

    // Plugin A's row removed (tombstoned) -> stops serving (403) and new ticket request denied
    await s.store.submit((tx) => {
      deleteRow(tx, ownTableStream(tx), "plugin:plugin-a", Date.now());
    });
    const afterDelete = await fetch(url);
    expect(afterDelete.status).toBe(403);
    expect(afterDelete.headers.get("x-botling-content")).toBe("refused; reason=plugin");

    const newTicketAfterDelete = await s.remote.ticket(DEVICE_A, {
      t: "content.ticket",
      req: "t2",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    });
    expect(newTicketAfterDelete).toMatchObject({ t: "content.gone", reason: "denied" });
  });

  it("checks the plugin row on the content owner (peer srv:<owner> copy) and fails closed without a reader", async () => {
    const s = await setupServer();
    const PEER_OWNER = "peer-b";
    await s.store.submit((tx) => {
      ensureStream(tx, `srv:${PEER_OWNER}` as StreamId);
      putRow(tx, `srv:${PEER_OWNER}`, "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "read"));
      // M5-17 follow-up (M1): the running code is this server's own copy, at the hash the owner granted.
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "read"));
    });

    const reader = s.store.openReader();
    cleanups.push(() => reader.close());
    const peerTickets = new ContentTickets();
    const peerStub = {
      ownerOfBot: () => null,
      locate: async () => null,
      check: async () => "ok" as const,
      respond: async () => new Response("peer-bytes", { status: 200 }),
    };
    const remoteWithPeer = new RemoteContent({
      service: s.service,
      tickets: peerTickets,
      roster: { device: (m) => (m === DEVICE_A ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null) },
      reader: () => reader,
      peer: peerStub,
    });
    const peerOrigin = await listen(remoteWithPeer);

    const granted = await remoteWithPeer.ticket(DEVICE_A, {
      t: "content.ticket",
      req: "p1",
      owner: PEER_OWNER,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    });
    expect(granted.t).toBe("content.granted");
    if (granted.t !== "content.granted") throw new Error("expected granted");

    const peerUrl = peerOrigin + contentUrlPath({ owner: PEER_OWNER, id: s.id, variant: "original", entry: s.entry, ticket: granted.ticket, plugin: "plugin-a" });
    expect((await fetch(peerUrl)).status).toBe(200);

    await s.store.submit((tx) => {
      deleteRow(tx, `srv:${PEER_OWNER}`, "plugin:plugin-a", Date.now());
    });
    expect((await fetch(peerUrl)).status).toBe(403);

    // Without a reader: plugin ticket refuses (fail-closed), shell ticket still serves
    const noReaderTickets = new ContentTickets();
    const remoteNoReader = new RemoteContent({
      service: s.service,
      tickets: noReaderTickets,
      roster: { device: (m) => (m === DEVICE_A ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null) },
    });
    const noReaderOrigin = await listen(remoteNoReader);
    expect(await remoteNoReader.ticket(DEVICE_A, {
      t: "content.ticket",
      req: "nr1",
      owner: s.owner,
      id: s.id,
      entry: s.entry,
      plugin: "plugin-a",
    })).toMatchObject({ t: "content.gone", reason: "denied" });

    const manualPluginTicket = noReaderTickets.issue({ deviceId: DEVICE_A, owner: s.owner, id: s.id, entry: s.entry, plugin: "plugin-a" }).ticket;
    expect((await fetch(noReaderOrigin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: manualPluginTicket, plugin: "plugin-a" }))).status).toBe(403);

    const shellTicket = noReaderTickets.issue({ deviceId: DEVICE_A, owner: s.owner, id: s.id, entry: s.entry }).ticket;
    expect((await fetch(noReaderOrigin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: shellTicket }))).status).toBe(200);
  });

  async function peerSetup(s: Awaited<ReturnType<typeof setupServer>>, peerOwner: string) {
    const reader = s.store.openReader();
    cleanups.push(() => reader.close());
    const remote = new RemoteContent({
      service: s.service,
      tickets: new ContentTickets(),
      roster: { device: (m) => (m === DEVICE_A ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null) },
      reader: () => reader,
      peer: {
        ownerOfBot: () => null,
        locate: async () => null,
        check: async () => "ok" as const,
        respond: async () => new Response("peer-bytes", { status: 200 }),
      },
    });
    const origin = await listen(remote);
    const ask = (req: string) => remote.ticket(DEVICE_A, { t: "content.ticket", req, owner: peerOwner, id: s.id, entry: s.entry, plugin: "plugin-a" });
    const urlFor = (ticket: string) => origin + contentUrlPath({ owner: peerOwner, id: s.id, variant: "original", entry: s.entry, ticket, plugin: "plugin-a" });
    return { ask, urlFor };
  }

  it("M1: peer-owned content needs the owner's grant for the RUNNING hash (this server's own row), not the owner's own hash", async () => {
    const s = await setupServer();
    const PEER_OWNER = "peer-b";
    await s.store.submit((tx) => {
      ensureStream(tx, `srv:${PEER_OWNER}` as StreamId);
      putRow(tx, `srv:${PEER_OWNER}`, "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "read"));
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "read"));
    });
    const { ask, urlFor } = await peerSetup(s, PEER_OWNER);
    const granted = await ask("m1a");
    expect(granted.t).toBe("content.granted");
    if (granted.t !== "content.granted") throw new Error("expected granted");
    expect((await fetch(urlFor(granted.ticket))).status).toBe(200);

    // A bot rewrites plugin A on this server: new running hash, no grant. The peer still holds the old granted hash.
    await s.store.submit((tx) => {
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_2, null));
    });
    const refused = await fetch(urlFor(granted.ticket));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-botling-content")).toBe("refused; reason=plugin");
    expect(await ask("m1b")).toMatchObject({ t: "content.gone", reason: "denied" });

    // This server's own content is refused as well (the two paths agree).
    expect(await s.remote.ticket(DEVICE_A, { t: "content.ticket", req: "m1c", owner: s.owner, id: s.id, entry: s.entry, plugin: "plugin-a" }))
      .toMatchObject({ t: "content.gone", reason: "denied" });

    // The owner grants the new running hash too: serves again.
    await s.store.submit((tx) => {
      putRow(tx, `srv:${PEER_OWNER}`, "plugin:plugin-a", { ...makePluginRow(HASH_1, HASH_1, "read"), grants: { ...makePluginRow(HASH_1, HASH_1).grants, ...makePluginRow(HASH_2, HASH_2).grants } });
    });
    expect((await fetch(urlFor(granted.ticket))).status).toBe(200);

    // No own row at all (plugin not installed here): refused.
    await s.store.submit((tx) => { deleteRow(tx, ownTableStream(tx), "plugin:plugin-a", Date.now()); });
    expect((await fetch(urlFor(granted.ticket))).status).toBe(403);
  });

  it("L1: a corrupt or unreadable plugin row answers denied / 403, not offline / 500", async () => {
    const s = await setupServer();
    await s.store.submit((tx) => {
      putRow(tx, ownTableStream(tx), "plugin:plugin-a", makePluginRow(HASH_1, HASH_1, "read"));
    });
    const granted = await s.remote.ticket(DEVICE_A, { t: "content.ticket", req: "l1a", owner: s.owner, id: s.id, entry: s.entry, plugin: "plugin-a" });
    expect(granted.t).toBe("content.granted");
    if (granted.t !== "content.granted") throw new Error("expected granted");
    const url = s.origin + contentUrlPath({ owner: s.owner, id: s.id, variant: "original", entry: s.entry, ticket: granted.ticket, plugin: "plugin-a" });
    expect((await fetch(url)).status).toBe(200);

    // The stored body is not JSON.
    await s.store.submit((tx) => {
      tx.prepare("UPDATE rows SET body = ? WHERE stream = ? AND key = ?").run("{", ownTableStream(tx), "plugin:plugin-a");
    });
    const res = await fetch(url);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-botling-content")).toBe("refused; reason=plugin");
    await expect(s.remote.ticket(DEVICE_A, { t: "content.ticket", req: "l1b", owner: s.owner, id: s.id, entry: s.entry, plugin: "plugin-a" }))
      .resolves.toMatchObject({ t: "content.gone", reason: "denied" });

    // The reader itself throws.
    const throwing = new RemoteContent({
      service: s.service,
      tickets: new ContentTickets(),
      roster: { device: (m) => (m === DEVICE_A ? { keys: { sign: "s", dh: "d" }, scope: ["read"] } : null) },
      reader: () => { throw new Error("db closed"); },
    });
    await expect(throwing.ticket(DEVICE_A, { t: "content.ticket", req: "l1c", owner: s.owner, id: s.id, entry: s.entry, plugin: "plugin-a" }))
      .resolves.toMatchObject({ t: "content.gone", reason: "denied" });
  });
});
