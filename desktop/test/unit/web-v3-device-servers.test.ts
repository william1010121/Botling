// @vitest-environment jsdom
// M4-18 (D70): Shell.tsx persists welcome.servers and peer updates via saveDeviceServers.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFeStorage, type Dial, type FeSocket, type SocketHandlers } from "../../src/fe-link";
import { decodeFrame, encodeFrame, GENESIS_HASH, PROTOCOL_VERSION, toBase64Url, type Message } from "../../src/protocol";
import { openFallbackLink, type Connection, type DialPath, type Diagnostics, type FallbackLink } from "../../web-v3/shell/connection";
import type { StoredServer } from "../../web-v3/shell/device-store";
import { FakeClock, flush, SERVER_ID, SRV_STREAM } from "./fe-link-harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REMOTE = { local: false } as const;
const PEER_ID = "srv2-000000000000000000000";
const DH_SELF = toBase64Url(new Uint8Array(32).fill(1));
const DH_PEER = toBase64Url(new Uint8Array(32).fill(2));

interface DialedConn {
  handlers: SocketHandlers;
  closed: boolean;
  sendServer(msg: Message): void;
}

const saveDeviceServersMock = vi.fn(async (_updates: readonly StoredServer[]) => [..._updates]);

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
    relay: { url: "wss://relay.example.invalid/ws", room: "room1" },
  }),
  loadPref: async () => null,
  savePref: async () => undefined,
  saveDevice: async () => undefined,
  saveDeviceServers: saveDeviceServersMock,
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

let activeOpenConnectionImpl: ((diag: Diagnostics, pageUrl: string) => Promise<Connection>) | null = null;
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

const activeLinks: FallbackLink[] = [];
const activeRoots: Array<{ root: Root; el: HTMLElement }> = [];

afterEach(async () => {
  activeOpenConnectionImpl = null;
  saveDeviceServersMock.mockClear();
  for (const fb of activeLinks.splice(0)) await fb.close();
  for (const item of activeRoots.splice(0)) {
    await act(async () => { item.root.unmount(); });
    item.el.remove();
  }
});

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

describe("M4-18 (D70): Shell.tsx saves discovered servers", () => {
  it("calls saveDeviceServers on welcome and on peer updates (including gone clearing addresses)", async () => {
    const dialed: DialedConn[] = [];
    const dialFor = (_path: DialPath): Dial => (handlers) => {
      const conn: DialedConn = {
        handlers,
        closed: false,
        sendServer(msg) {
          const enc = encodeFrame(msg, "server", REMOTE);
          if (!enc.ok) throw new Error(enc.detail);
          handlers.frame(enc.text);
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
          if (dec.message.t === "hello") {
            conn.sendServer({
              t: "welcome",
              serverId: SERVER_ID,
              protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
              minFeVersion: "3.0.0",
              rosterDigest: null,
              next: {},
              servers: [
                {
                  id: SERVER_ID,
                  name: "Studio",
                  state: "live",
                  since: 100,
                  dh: DH_SELF,
                  addresses: { tailnet: "wss://studio.example.invalid/v3/ws" },
                },
                {
                  id: PEER_ID,
                  name: "Linux",
                  state: "live",
                  since: 200,
                  dh: DH_PEER,
                  addresses: {
                    tailnet: "wss://linux.example.invalid/v3/ws",
                    relay: { url: "wss://relay.example.invalid/ws", room: "r-linux" },
                  },
                },
              ],
              views: {},
            });
          } else if (dec.message.t === "sub" && dec.message.stream === SRV_STREAM) {
            conn.sendServer({ t: "snap", stream: SRV_STREAM, logId: "srv-log-1", seq: 0, hash: GENESIS_HASH, view: {} });
          }
        },
        close() {
          conn.closed = true;
        },
      } satisfies FeSocket;
    };

    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    activeOpenConnectionImpl = async () => {
      const fb = await openFallbackLink({
        storage,
        directDial: dialFor("direct"),
        deviceId: "dev1",
        feVersion: "3.0.0",
        local: false,
        clock,
        newEpoch: nextEpoch,
      });
      activeLinks.push(fb);
      return {
        link: fb.link,
        port: fb.link as unknown as Connection["port"],
        get path() { return fb.path; },
        get revoked() { return fb.revoked; },
        close: () => fb.close(),
      };
    };

    const { Shell } = await import("../../web-v3/shell/Shell");
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

    expect(saveDeviceServersMock).toHaveBeenCalledTimes(1);
    expect(saveDeviceServersMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        id: SERVER_ID,
        name: "Studio",
        state: "live",
        since: 100,
        dh: DH_SELF,
        addresses: { tailnet: "wss://studio.example.invalid/v3/ws" },
      }),
      expect.objectContaining({
        id: PEER_ID,
        name: "Linux",
        state: "live",
        since: 200,
        dh: DH_PEER,
        addresses: {
          tailnet: "wss://linux.example.invalid/v3/ws",
          relay: { url: "wss://relay.example.invalid/ws", room: "r-linux" },
        },
      }),
    ]);

    // A peer update marking PEER_ID gone invokes saveDeviceServers again with addresses cleared and dh preserved.
    await act(async () => {
      dialed[0]!.sendServer({ t: "peer", serverId: PEER_ID, state: "gone", since: 900 });
      await flush();
    });

    expect(saveDeviceServersMock).toHaveBeenCalledTimes(2);
    const secondCall = saveDeviceServersMock.mock.calls[1]![0];
    const gonePeer = secondCall.find((s) => s.id === PEER_ID);
    expect(gonePeer).toEqual(expect.objectContaining({
      id: PEER_ID,
      name: "Linux",
      state: "gone",
      since: 900,
      dh: DH_PEER,
    }));
    expect("addresses" in gonePeer!).toBe(false);
  });
});
