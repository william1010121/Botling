// @vitest-environment jsdom
// M4-21 (D73): when the server sends bye{revoked}, the page stops reconnecting, keeps its outbox unsent,
// and shows "This device was removed. Pair it again."
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../src/contract";
import { MemoryFeStorage, type Dial, type FeSocket, type SocketHandlers } from "../../src/fe-link";
import { decodeFrame, encodeFrame, GENESIS_HASH, PROTOCOL_VERSION, type Message } from "../../src/protocol";
import {
  bannerText, openFallbackLink, REPROBE_INTERVAL_MS,
  type Connection, type DialPath, type Diagnostics, type FallbackLink,
} from "../../web-v3/shell/connection";
import { BOT, FakeClock, flush, react, SERVER_ID, SRV_STREAM } from "./fe-link-harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REMOTE = { local: false } as const;

interface DialedConn {
  path: DialPath;
  handlers: SocketHandlers;
  sent: Message[];
  closed: boolean;
  sendServer(msg: Message): void;
  closeServer(): void;
}

function makeServerBehavior(opts: { mode: "revoke-on-hello" | "welcome-then-revoke" }) {
  const dialed: DialedConn[] = [];
  const dialFor = (path: DialPath): Dial => (handlers) => {
    const conn: DialedConn = {
      path,
      handlers,
      sent: [],
      closed: false,
      sendServer(msg) {
        const enc = encodeFrame(msg, "server", REMOTE);
        if (!enc.ok) throw new Error(enc.detail);
        handlers.frame(enc.text);
      },
      closeServer() {
        if (conn.closed) return;
        conn.closed = true;
        handlers.close("closed");
      },
    };
    dialed.push(conn);
    queueMicrotask(() => {
      if (!conn.closed) handlers.open();
    });
    return {
      send(frame: string) {
        const dec = decodeFrame(frame, "fe", REMOTE);
        if (!dec.ok) return;
        conn.sent.push(dec.message);
        if (dec.message.t === "hello") {
          if (opts.mode === "revoke-on-hello") {
            conn.sendServer({ t: "bye", reason: "revoked", detail: "this device is no longer in the roster" });
            conn.closeServer();
          } else {
            conn.sendServer({
              t: "welcome",
              serverId: SERVER_ID,
              protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
              minFeVersion: "3.0.0",
              rosterDigest: null,
              next: {},
              servers: [{ id: SERVER_ID, name: "Mac", state: "live", since: null }],
              views: {},
            });
          }
        } else if (dec.message.t === "sub" && dec.message.stream === SRV_STREAM) {
          conn.sendServer({
            t: "snap",
            stream: SRV_STREAM,
            logId: "srv-log-1",
            seq: 0,
            hash: GENESIS_HASH,
            view: {},
          });
        }
      },
      close() {
        conn.closed = true;
      },
    } satisfies FeSocket;
  };
  return { dialed, dialFor };
}

let activeLinks: FallbackLink[] = [];
let activeRoots: Array<{ root: Root; el: HTMLElement }> = [];
let activeOpenConnectionImpl: ((diag: Diagnostics, pageUrl: string) => Promise<Connection>) | null = null;

vi.mock("../../web-v3/shell/device-store", () => ({
  loadDevice: async () => ({
    v: 1,
    memberId: "dev1",
    name: "Phone",
    signKey: {} as CryptoKey,
    signPub: "s",
    dhKey: {} as CryptoKey,
    dhPub: new Uint8Array(32),
    cluster: "c".repeat(32),
    server: { memberId: SERVER_ID, name: "Mac", dhPub: new Uint8Array(32) },
    addId: "a".repeat(32),
    scope: ["read", "reply"],
    pairedAt: 1000,
    relay: { url: "ws://127.0.0.1/ws", room: "room1" },
  }),
  loadPref: async () => null,
  savePref: async () => undefined,
  saveDevice: async () => undefined,
  forgetDevice: async () => undefined,
}));

vi.mock("../../web-v3/bridge-v3", () => ({
  mountRenderer: () => ({ render() {}, unmount() {}, store: { resync: async () => undefined } }),
}));

vi.mock("../../web-v3/shell/content-cache", () => ({
  CONTENT_CACHE_CAP: 200 * 1024 * 1024,
  ContentCache: class { async clear() {} },
  clearContentCache: async () => undefined,
}));

vi.mock("../../web-v3/shell/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/media")>();
  return {
    ...actual,
    MediaBroker: class {
      start() {}
      stop() {}
      setPath() {}
      dropCached() {}
    },
  };
});

vi.mock("../../web-v3/shell/sw-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/sw-bridge")>();
  return {
    ...actual,
    SwBridge: class {
      start() {}
      stop() {}
    },
  };
});

vi.mock("../../web-v3/shell/uploads", () => ({
  PageUploads: class {
    start() {}
    stop() {}
  },
}));

vi.mock("../../web-v3/shell/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/connection")>();
  return {
    ...actual,
    openConnection: async (_device: unknown, diag: Diagnostics, pageUrl: string, ...rest: unknown[]) => {
      if (activeOpenConnectionImpl) return activeOpenConnectionImpl(diag, pageUrl);
      return (actual.openConnection as (...args: unknown[]) => Promise<Connection>)(_device, diag, pageUrl, ...rest);
    },
  };
});

afterEach(async () => {
  activeOpenConnectionImpl = null;
  for (const fb of activeLinks.splice(0)) await fb.close();
  for (const item of activeRoots.splice(0)) {
    await act(async () => { item.root.unmount(); });
    item.el.remove();
  }
});

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

describe("M4-21 (D73): page handling of bye{revoked}", () => {
  it("connection: bye{revoked} before welcome shows the text, stops dialing/relay fallback, and keeps the outbox unsent", async () => {
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const srv = makeServerBehavior({ mode: "revoke-on-hello" });
    let revokedCalls = 0;

    const fb = await openFallbackLink({
      storage,
      directDial: srv.dialFor("direct"),
      relayDial: srv.dialFor("relay"),
      deviceId: "dev1",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
      onRevoked: () => { revokedCalls += 1; },
    });
    activeLinks.push(fb);

    // Queue an outbox item before starting, as happens when offline before reload.
    await fb.link.submit(BOT, react("m1"));
    expect(fb.link.pending()).toHaveLength(1);

    fb.start();
    await flush();

    expect(fb.revoked).toBe(true);
    expect(revokedCalls).toBe(1);
    expect(bannerText(fb.link.status, fb.link.pending(), fb.link.servers(), fb.revoked)).toBe("This device was removed. Pair it again.");
    // Never fell back to relay and never re-dialed after advancing clock.
    expect(srv.dialed.map((d) => d.path)).toEqual(["direct"]);
    clock.advance(REPROBE_INTERVAL_MS * 2);
    await flush();
    expect(srv.dialed).toHaveLength(1);

    // Submitting another command keeps both in the outbox and sends nothing.
    await fb.link.submit(BOT, { type: "chat.send", botId: "b1", text: "still unsent" } as Command);
    await flush();
    expect(fb.link.pending().map((p) => p.state)).toEqual(["waiting", "waiting"]);
    expect(srv.dialed.flatMap((d) => d.sent).filter((m) => m.t === "cmd")).toEqual([]);
  });

  it("connection: bye{revoked} while attached on relay stops re-probing/reconnecting and keeps new writes unsent", async () => {
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const srv = makeServerBehavior({ mode: "welcome-then-revoke" });

    const fb = await openFallbackLink({
      storage,
      directDial: srv.dialFor("direct"),
      relayDial: srv.dialFor("relay"),
      forcedPath: "relay",
      deviceId: "dev1",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    activeLinks.push(fb);
    fb.start();
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");

    // Revoke while connected.
    srv.dialed[0]!.sendServer({ t: "bye", reason: "revoked", detail: "removed" });
    srv.dialed[0]!.closeServer();
    await flush();

    expect(fb.revoked).toBe(true);
    expect(bannerText(fb.link.status, fb.link.pending(), fb.link.servers(), fb.revoked)).toBe("This device was removed. Pair it again.");

    clock.advance(REPROBE_INTERVAL_MS * 2);
    await flush();
    expect(srv.dialed).toHaveLength(1);

    await fb.link.submit(BOT, react("m2"));
    await flush();
    expect(fb.link.pending().map((p) => p.state)).toEqual(["waiting"]);
    expect(srv.dialed.flatMap((d) => d.sent).filter((m) => m.t === "cmd")).toEqual([]);
  });

  it("Shell: shows 'This device was removed. Pair it again.' (even if on relay) and sends nothing", async () => {
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const srv = makeServerBehavior({ mode: "revoke-on-hello" });
    let capturedFb!: FallbackLink;

    activeOpenConnectionImpl = async (diag) => {
      const fb = await openFallbackLink({
        storage,
        directDial: srv.dialFor("direct"),
        relayDial: srv.dialFor("relay"),
        forcedPath: "relay",
        deviceId: "dev1",
        feVersion: "3.0.0",
        local: false,
        clock,
        newEpoch: nextEpoch,
        onRevoked: () => {
          if (diag.conn[diag.conn.length - 1] !== "needs pairing") diag.conn.push("needs pairing");
        },
      });
      activeLinks.push(fb);
      capturedFb = fb;
      await fb.link.submit(BOT, react("m-before"));
      return {
        link: fb.link,
        port: fb.link as unknown as Connection["port"],
        get path() { return fb.path; },
        get revoked() { return fb.revoked; },
        close: () => fb.close(),
      };
    };

    const { Shell, diagnostics } = await import("../../web-v3/shell/Shell");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    activeRoots.push({ root, el });

    await act(async () => {
      root.render(createElement(Shell));
    });
    await act(async () => {
      await flush();
    });

    const banner = el.querySelector('[data-testid="conn-banner"]');
    expect(banner?.textContent).toBe("This device was removed. Pair it again.");
    expect(banner?.getAttribute("data-state")).toBe("needs pairing");
    expect(diagnostics.conn).toContain("needs pairing");
    expect(diagnostics.banners).toContain("This device was removed. Pair it again.");

    // Submitting a new command after revocation stays in outbox and nothing is sent on the wire.
    await act(async () => {
      await capturedFb.link.submit(BOT, react("m-after"));
      await flush();
    });
    expect(el.querySelector('[data-testid="conn-banner"]')?.textContent).toBe("This device was removed. Pair it again.");
    expect(capturedFb.link.pending().map((p) => p.state)).toEqual(["waiting", "waiting"]);
    expect(srv.dialed).toHaveLength(1);
    expect(srv.dialed.flatMap((d) => d.sent).filter((m) => m.t === "cmd")).toEqual([]);
  });
});
