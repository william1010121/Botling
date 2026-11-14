// Botling 3 M2 step 13: botlingd's room on the relay (src/server/net/relay.ts) and the device's relay socket
// (src/fe-link/relay-socket.ts) against the unchanged relay started locally (relay/src/main.ts on 127.0.0.1), with an
// echo in place of the device sessions. Also the join tokens (src/session/relay-wire.ts): both sides derive the same
// device token, and the hashes and room ids are the relay's own (relay.ts hashToken / roomOf).
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RelaySocket } from "../../src/fe-link";
import { cspWith, CSP, loadRelayRoomKey, relayConnectOrigin, RelayConnector, relayTestOptions, relayUrl } from "../../src/server/net";
import {
  generateDhKeyPair, newRelayRoomKey, relayDeviceToken, relayPairToken, relayRoomOf, relayTokenHash, type Lane, type SessionTransport,
} from "../../src/session";
import { until } from "../helpers";
import { LocalRelay } from "../support/local-relay";

const root = mkdtempSync(join(tmpdir(), "relay-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

/** An echo "session" per relay peer: every frame comes back on the same lane. */
function echoSessions() {
  const accepted: Array<{ transport: SessionTransport; frames: number; closed: boolean }> = [];
  return {
    accepted,
    accept(transport: SessionTransport, kind: "relay") {
      expect(kind).toBe("relay");
      const entry = { transport, frames: 0, closed: false };
      accepted.push(entry);
      return {
        link: { established: Promise.resolve(), resume: () => undefined },
        receive(frame: Uint8Array) { entry.frames++; transport.send(frame, (frame[0] === 0xbb ? "bulk" : "control") as Lane); },
        transportClosed() { entry.closed = true; },
      };
    },
  };
}

function device(url: string, room: string, token: string) {
  const socket = new RelaySocket({ url, room, token });
  const got: Uint8Array[] = [];
  let open = false, closed: number | null = null;
  socket.onopen = () => { open = true; };
  socket.onmessage = (event) => { got.push(new Uint8Array(event.data as ArrayBuffer)); };
  socket.onclose = (event) => { closed = event.code ?? 0; };
  cleanups.push(() => socket.close());
  return { socket, got, get open() { return open; }, get closed() { return closed; } };
}

describe("relay join tokens", () => {
  it("device and server derive the same token; hashes and room ids are the relay's", async () => {
    const dev = await generateDhKeyPair();
    const srv = await generateDhKeyPair();
    const a = await relayDeviceToken("dev1", dev.privateKey, srv.publicKey);
    const b = await relayDeviceToken("dev1", srv.privateKey, dev.publicKey);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await relayDeviceToken("dev2", dev.privateKey, srv.publicKey)).not.toBe(a);
    const secret = new Uint8Array(32).fill(7);
    const pairToken = await relayPairToken("offer-1", secret);
    expect(pairToken).not.toBe(await relayPairToken("offer-2", secret));
    expect(await relayTokenHash(pairToken)).toBe(createHash("sha256").update(pairToken, "utf8").digest("hex"));
    const key = newRelayRoomKey();
    expect(await relayRoomOf(key)).toBe(createHash("sha256").update(Buffer.from(key, "base64url")).digest("base64url"));
  });

  it("settings: the URL, the room key file (0600, kept), the page's connect-src", () => {
    expect(relayUrl({})).toBeNull();
    expect(relayUrl({ BOTLING_SERVER_RELAY_URL: "ws://127.0.0.1:9/ws" })).toBe("ws://127.0.0.1:9/ws");
    expect(() => relayUrl({ BOTLING_SERVER_RELAY_URL: "https://example.invalid/ws" })).toThrow();
    expect(relayTestOptions({ BOTLING_SERVER_RELAY_BACKOFF_MS: "50,200" })).toEqual({ backoff: { minMs: 50, maxMs: 200 } });
    const file = join(root, "relay-room.key");
    const key = loadRelayRoomKey(file);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadRelayRoomKey(file)).toBe(key);
    chmodSync(file, 0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(key);
    expect(relayConnectOrigin("wss://relay.example.invalid/ws")).toBe("wss://relay.example.invalid");
    expect(cspWith([])).toBe(CSP);
    expect(cspWith(["ws://127.0.0.1:9"])).toContain("connect-src 'self' ws://127.0.0.1:9;");
    expect(cspWith(["javascript:alert(1)"])).toBe(CSP);
  });
});

describe("botlingd's room on a local relay", () => {
  it("opens its room, admits listed tokens only, echoes frames, revokes by the allow list, and comes back after a relay restart", async () => {
    let relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());
    const port = relay.port;
    const key = newRelayRoomKey();
    const good = "g".repeat(43), bad = "b".repeat(43);
    let tokens = [{ h: await relayTokenHash(good) }];
    const sessions = echoSessions();
    const lines: string[] = [];
    const connector = new RelayConnector({ url: relay.url, roomKey: key, sessions, allowList: async () => tokens, log: (line) => lines.push(line), backoff: { minMs: 50, maxMs: 200 } });
    cleanups.push(() => connector.close());
    await connector.start();
    await until(() => connector.state === "ready", { what: "the room", timeout: 10_000 });
    expect(connector.room).toBe(await relayRoomOf(key));
    // Let the allow list arrive before devices join.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const refused = device(relay.url, connector.room!, bad);
    await until(() => refused.closed !== null, { what: "the refused join" });
    expect(refused.open).toBe(false);
    expect(refused.socket.refusal).toBe("denied");

    const phone = device(relay.url, connector.room!, good);
    await until(() => phone.open, { what: "the join" });
    phone.socket.send(Uint8Array.of(1, 2, 3));
    const big = new Uint8Array(128 * 1024 + 40).fill(0xbb);
    for (let i = 0; i < 20; i++) phone.socket.send(big);
    await until(() => phone.got.length === 21, { what: "the echoes", timeout: 10_000 });
    expect([...phone.got[0]!]).toEqual([1, 2, 3]);
    expect(phone.got[20]!.length).toBe(big.length);
    expect(connector.pace!.bulk).toBe(20);
    expect(connector.pace!.minTokens).toBeGreaterThanOrEqual(0);

    // Off the allow list: the relay closes the device at once; the session hears its transport closed.
    tokens = [];
    await connector.refreshAllow();
    await until(() => phone.closed !== null, { what: "the revoke" });
    expect(phone.closed).toBe(4403);
    await until(() => sessions.accepted[0]!.closed, { what: "the session's end" });

    // The relay restarts on the same port: botlingd opens the same room again; a device joins and talks.
    tokens = [{ h: await relayTokenHash(good) }];
    await relay.stop();
    await until(() => connector.state !== "ready", { what: "the loss" });
    relay = await new LocalRelay({}, port).ready();
    await until(() => connector.state === "ready", { what: "the room again", timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = device(relay.url, connector.room!, good);
    await until(() => again.open, { what: "the join after the restart" });
    again.socket.send(Uint8Array.of(9));
    await until(() => again.got.length === 1, { what: "the echo after the restart" });
    expect(connector.counts.readies).toBe(2);
    expect(connector.counts.closes.some((close) => close.code === 4429)).toBe(false);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.join("\n")).not.toContain(good);
  }, 30_000);
});
