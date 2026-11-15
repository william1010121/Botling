// Botling 3 M4-14: servers advertise every path (loopback, tailnet, relay room) in their Profile, and peers parse
// all of them with forward compatibility (unknown kinds ignored) and strict validation (tailnet hostname only, never
// an IP; relay always carries a room and never the room key).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { relayRoomOf } from "../../src/session";
import { addressesForUrl, addressesValue, loopbackAddress, peerAddresses } from "../../src/server/peer";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { parseStored } from "../../src/server/roster";
import { openServerStore } from "../../src/server/store";
import { BotlingdProcess, testRoot } from "../botlingd-harness";
import { LocalRelay } from "../support/local-relay";
import { makeCluster, readServerKeys, strangerKeys, writeStatements } from "../support/peer-cluster";

const root = testRoot("peer-addresses");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

describe("M4-14: peerAddresses parsing and building", () => {
  it("parses all three kinds (loopback, tailnet, relay) and keeps loopbackAddress working", () => {
    const raw = JSON.stringify({
      loopback: "ws://127.0.0.1:8744/v3/ws",
      tailnet: "wss://peer-a.example.invalid/v3/ws",
      relay: { url: "wss://relay.example.invalid/ws", room: "room_ABC-123" },
    });
    expect(peerAddresses(raw)).toEqual({
      loopback: "ws://127.0.0.1:8744/v3/ws",
      tailnet: "wss://peer-a.example.invalid/v3/ws",
      relay: { url: "wss://relay.example.invalid/ws", room: "room_ABC-123" },
    });
    expect(loopbackAddress(raw)).toBe("ws://127.0.0.1:8744/v3/ws");

    // Tailnet with explicit port is also valid.
    const withPort = JSON.stringify({ tailnet: "wss://peer-a.example.invalid:8443/v3/ws" });
    expect(peerAddresses(withPort)).toEqual({ tailnet: "wss://peer-a.example.invalid:8443/v3/ws" });

    for (const empty of [null, "", "{", "[]", "42", '"text"']) {
      expect(peerAddresses(empty)).toEqual({});
    }
  });

  it("ignores unknown address kinds for forward compatibility", () => {
    const raw = JSON.stringify({
      loopback: "ws://127.0.0.1:8744/v3/ws",
      tailnet: "wss://peer-a.example.invalid/v3/ws",
      relay: { url: "ws://127.0.0.1:9000/ws", room: "room1" },
      futurePath: "quic://peer-a.example.invalid:9443",
      nestedFuture: { a: 1, b: [2, 3] },
    });
    expect(peerAddresses(raw)).toEqual({
      loopback: "ws://127.0.0.1:8744/v3/ws",
      tailnet: "wss://peer-a.example.invalid/v3/ws",
      relay: { url: "ws://127.0.0.1:9000/ws", room: "room1" },
    });
  });

  it("ignores a tailnet value with an IP or a path other than /v3/ws", () => {
    const badTailnets = [
      "wss://127.0.0.1/v3/ws",
      "wss://192.0.2.1/v3/ws",
      "wss://192.0.2.1:8443/v3/ws",
      "wss://[::1]/v3/ws",
      "wss://[2001:db8::1]/v3/ws",
      "wss://2130706433/v3/ws",
      "wss://0x7f000001/v3/ws",
      "wss://999.999.999.999/v3/ws",
      "wss://peer-a.example.invalid/",
      "wss://peer-a.example.invalid/ws",
      "wss://peer-a.example.invalid/v3/ws/extra",
      "wss://peer-a.example.invalid/v3/ws?x=1",
      "wss://peer-a.example.invalid/v3/ws#frag",
      "ws://peer-a.example.invalid/v3/ws",
      "https://peer-a.example.invalid/v3/ws",
      "wss://user@peer-a.example.invalid/v3/ws",
      "wss://peer-a.example.invalid:0/v3/ws",
    ];
    for (const tailnet of badTailnets) {
      const parsed = peerAddresses(JSON.stringify({ loopback: "ws://127.0.0.1:8744/v3/ws", tailnet }));
      expect(parsed, tailnet).toEqual({ loopback: "ws://127.0.0.1:8744/v3/ws" });
    }
  });

  it("ignores a relay value without a valid room or URL", () => {
    const badRelays: unknown[] = [
      { url: "wss://relay.example.invalid/ws" },
      { url: "wss://relay.example.invalid/ws", room: "" },
      { url: "wss://relay.example.invalid/ws", room: "bad/room!" },
      { room: "valid_room-1" },
      { url: "https://relay.example.invalid/ws", room: "valid_room-1" },
      { url: "wss://user:pass@relay.example.invalid/ws", room: "valid_room-1" },
      { url: "wss://relay.example.invalid/ws#frag", room: "valid_room-1" },
      "wss://relay.example.invalid/ws",
      null,
    ];
    for (const relay of badRelays) {
      const parsed = peerAddresses(JSON.stringify({ loopback: "ws://127.0.0.1:8744/v3/ws", relay }));
      expect(parsed, JSON.stringify(relay)).toEqual({ loopback: "ws://127.0.0.1:8744/v3/ws" });
    }
  });

  it("builds addressesValue with tailnet and relay, and classifies join URLs via addressesForUrl", () => {
    expect(peerAddresses(addressesValue(8744))).toEqual({ loopback: "ws://127.0.0.1:8744/v3/ws" });

    const full = addressesValue(8744, {
      tailnet: "https://peer-a.example.invalid",
      relay: { url: "ws://127.0.0.1:9100/ws", room: "room_xyz" },
    });
    expect(peerAddresses(full)).toEqual({
      loopback: "ws://127.0.0.1:8744/v3/ws",
      tailnet: "wss://peer-a.example.invalid/v3/ws",
      relay: { url: "ws://127.0.0.1:9100/ws", room: "room_xyz" },
    });

    // An IP tailnet origin is never written into tailnet.
    const ipOrigin = addressesValue(8744, { tailnet: "https://192.0.2.1" });
    expect(peerAddresses(ipOrigin)).toEqual({ loopback: "ws://127.0.0.1:8744/v3/ws" });

    // Server pairing URL classification (join.ts:516).
    expect(peerAddresses(addressesForUrl("ws://127.0.0.1:8744/v3/ws"))).toEqual({ loopback: "ws://127.0.0.1:8744/v3/ws" });
    expect(peerAddresses(addressesForUrl("wss://peer-n.example.invalid/v3/ws"))).toEqual({ tailnet: "wss://peer-n.example.invalid/v3/ws" });
    expect(addressesForUrl("wss://127.0.0.1/v3/ws")).toBeNull();
  });
});

describe("M4-14: server Profile advertising", () => {
  it("writes the relay room (and tailnet) into its Profile when BOTLING_SERVER_RELAY_URL is set, and never the room key", async () => {
    const relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());

    const dataDir = join(root, "srv-a");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const store = await openServerStore(dataDir);
    const identity = await loadOrCreateServerIdentity(dataDir);
    await store.submit((tx) => bindServerIdentity(tx, identity));
    await store.close();

    const ka = await readServerKeys(dataDir);
    const kb = await strangerKeys();
    const made = await makeCluster([ka, kb]);
    writeStatements(dataDir, made.clusterId, made.statements);

    const daemon = new BotlingdProcess(dataDir, {
      BOTLING_SERVER_RELAY_URL: relay.url,
      BOTLING_SERVER_TAILNET_ORIGIN: "https://peer-a.example.invalid",
    });
    cleanups.push(() => daemon.stop());
    await daemon.ready();

    const roomKey = readFileSync(join(dataDir, "relay-room.key"), "utf8").trim();
    const expectedRoom = await relayRoomOf(roomKey);

    const listenInfo = JSON.parse(readFileSync(join(dataDir, "botlingd.listen.json"), "utf8")) as { port: number };
    const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
    let profileBytes: Uint8Array | null = null;
    let profileValue: string | null = null;
    const allBytes: Buffer[] = [];
    try {
      const rows = db.prepare("SELECT bytes FROM roster").all() as Array<{ bytes: Uint8Array }>;
      for (const row of rows) {
        allBytes.push(Buffer.from(row.bytes));
        const stored = parseStored(row.bytes);
        if (stored?.body.type === "profile" && stored.body.member === ka.memberId && stored.body.field === "addresses") {
          profileBytes = row.bytes;
          profileValue = stored.body.value;
        }
      }
    } finally {
      db.close();
    }

    expect(profileValue).not.toBeNull();
    expect(profileBytes).not.toBeNull();
    expect(peerAddresses(profileValue)).toEqual({
      loopback: `ws://127.0.0.1:${listenInfo.port}/v3/ws`,
      tailnet: "wss://peer-a.example.invalid/v3/ws",
      relay: { url: relay.url, room: expectedRoom },
    });

    // Byte scan: the room key must never leave the data folder (not in the Profile or any roster row).
    expect(Buffer.from(profileBytes!).includes(roomKey, 0, "utf8")).toBe(false);
    for (const buf of allBytes) {
      expect(buf.includes(roomKey, 0, "utf8")).toBe(false);
    }
    expect(profileValue!).not.toContain(roomKey);
  }, 60_000);
});
