// @vitest-environment jsdom
// M4-20b (D72): "This device › Server" menu in Shell.tsx lists conn.link.servers() when connected, falls back to
// device.servers[] (D70) when offline, and triggers immediate switching via M4-20a's pickServer(id) / onServer API.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { MemoryFeStorage, type Dial, type FeLink, type FeSocket, type SocketHandlers } from "../../src/fe-link";
import { decodeFrame, encodeFrame, GENESIS_HASH, PROTOCOL_VERSION, toBase64Url, type Message } from "../../src/protocol";
import {
  FE_VERSION,
  openFallbackLink,
  type Connection,
  type DialPath,
  type Diagnostics,
  type FallbackLink,
  type OpenConnectionOptions,
} from "../../web-v3/shell/connection";
import type { DeviceRecord, StoredServer } from "../../web-v3/shell/device-store";
import { FakeClock, flush } from "./fe-link-harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REMOTE = { local: false } as const;

const SRV_A = "srva-000000000000000000000";
const SRV_B = "srvb-000000000000000000000";
const SRV_C = "srvc-000000000000000000000";
const DH_A = toBase64Url(new Uint8Array(32).fill(1));
const DH_B = toBase64Url(new Uint8Array(32).fill(2));
const DH_C = toBase64Url(new Uint8Array(32).fill(3));

const savePrefMock = vi.fn(async () => undefined);
let storedServers: StoredServer[] | undefined;
let mergeServersImpl: ((cur: readonly StoredServer[] | undefined, upd: readonly StoredServer[]) => StoredServer[]) | null = null;
const saveDeviceServersMock = vi.fn(async (updates: readonly StoredServer[]) => {
  storedServers = mergeServersImpl!(storedServers ?? currentDevice.servers, updates);
  return storedServers;
});

let currentDevice: DeviceRecord = makeDevice();

function makeDevice(servers?: StoredServer[]): DeviceRecord {
  return {
    v: 1,
    memberId: "dev1",
    name: "Phone",
    signKey: {} as CryptoKey,
    signPub: "s",
    dhKey: {} as CryptoKey,
    dhPub: new Uint8Array(32),
    cluster: "c".repeat(32),
    server: { memberId: SRV_A, name: "Studio", dhPub: new Uint8Array(32).fill(1) },
    addId: "a".repeat(32),
    scope: ["read", "reply"],
    pairedAt: 1000,
    servers: servers ?? [
      { id: SRV_A, name: "Studio", dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: SRV_B, name: "Linux", dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
    ],
  };
}

vi.mock("../../web-v3/shell/device-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/device-store")>();
  mergeServersImpl = actual.mergeServers;
  return {
    ...actual,
    loadDevice: async () => currentDevice,
    loadPref: async () => null,
    savePref: savePrefMock,
    saveDevice: async () => undefined,
    saveDeviceServers: saveDeviceServersMock,
    forgetDevice: async () => undefined,
  };
});

let lastFooterEl: HTMLElement | null = null;
let lastFooterRoot: Root | null = null;
function renderChrome(chrome?: { railFooter?: unknown }) {
  if (!chrome?.railFooter) return;
  if (!lastFooterEl) {
    lastFooterEl = document.createElement("div");
    document.body.appendChild(lastFooterEl);
    lastFooterRoot = createRoot(lastFooterEl);
  }
  lastFooterRoot?.render(chrome.railFooter as ReactElement);
}

vi.mock("../../web-v3/bridge-v3", () => ({
  mountRenderer: (_el: HTMLElement, opts: { chrome?: { railFooter?: unknown } }) => {
    renderChrome(opts.chrome);
    return {
      render(chrome: { railFooter?: unknown }) { renderChrome(chrome); },
      unmount() { lastFooterEl = null; },
      store: { resync: async () => undefined },
    };
  },
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

let activeOpenConnectionImpl: ((device: DeviceRecord, diag: Diagnostics, pageUrl: string, opts?: DialPath | OpenConnectionOptions) => Promise<Connection>) | null = null;
vi.mock("../../web-v3/shell/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/connection")>();
  return {
    ...actual,
    openConnection: async (device: DeviceRecord, diag: Diagnostics, pageUrl: string, opts?: DialPath | OpenConnectionOptions) => {
      if (activeOpenConnectionImpl) return activeOpenConnectionImpl(device, diag, pageUrl, opts);
      return actual.openConnection(device, diag, pageUrl, opts);
    },
  };
});

interface DialedConn {
  serverId: string;
  handlers: SocketHandlers;
  closed: boolean;
  sendServer(msg: Message): void;
  closeFromServer(): void;
}

const activeLinks: FallbackLink[] = [];
const activeRoots: Array<{ root: Root; el: HTMLElement }> = [];

afterEach(async () => {
  currentDevice = makeDevice();
  storedServers = undefined;
  activeOpenConnectionImpl = null;
  savePrefMock.mockClear();
  saveDeviceServersMock.mockClear();
  for (const fb of activeLinks.splice(0)) await fb.close();
  for (const item of activeRoots.splice(0)) {
    await act(async () => { item.root.unmount(); });
    item.el.remove();
  }
  if (lastFooterRoot) {
    await act(async () => { lastFooterRoot!.unmount(); });
    lastFooterRoot = null;
  }
  lastFooterEl?.remove();
  lastFooterEl = null;
});

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

function changeSelect(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("M4-20b (D72): Shell.tsx This device › Server picker", () => {
  it("lists conn.link.servers() when connected, disables gone servers, and calls pickServer immediately without saving prefs in M4-20b", async () => {
    const { ThisDevice } = await import("../../web-v3/shell/Shell");
    const listeners = new Set<(e: { type: string }) => void>();
    const pickServer = vi.fn(() => true);
    const link = {
      attached: true,
      attachedServerId: () => SRV_A,
      pending: () => [],
      servers: () => [
        { id: SRV_A, name: "Studio", state: "live" as const, since: null, self: true, dh: DH_A },
        { id: SRV_B, name: "Linux", state: "stale" as const, since: 100, self: false, dh: DH_B },
        { id: SRV_C, name: "Removed", state: "gone" as const, since: 200, self: false, dh: DH_C },
      ],
      on: (fn: (e: { type: string }) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as FeLink;

    const conn: Connection = {
      link,
      port: link as unknown as Connection["port"],
      path: "direct",
      revoked: false,
      serverId: SRV_A,
      pickServer,
      close: async () => undefined,
    };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    activeRoots.push({ root, el: host });

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: makeDevice([{ id: SRV_A, name: "StaleDeviceCacheOnly" }]),
        connection: conn,
        path: "direct",
        serverId: SRV_A,
        onClose: () => undefined,
        onForget: () => undefined,
      }));
    });

    const select = host.querySelector('[data-testid="server-picker"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = [...select!.options];
    // Must read conn.link.servers() while attached, not the stale device.servers[] cache.
    expect(options.map((o) => o.value)).toEqual([SRV_A, SRV_B, SRV_C]);
    expect(options[0]!.disabled).toBe(false);
    expect(options[1]!.disabled).toBe(false);
    expect(options[2]!.disabled).toBe(true);
    expect(select!.value).toBe(SRV_A);

    await act(async () => {
      changeSelect(select!, SRV_B);
    });

    expect(pickServer).toHaveBeenCalledTimes(1);
    expect(pickServer).toHaveBeenCalledWith(SRV_B);
    expect(select!.value).toBe(SRV_B);
    expect(savePrefMock).not.toHaveBeenCalled();
  });

  it("falls back to device.servers[] (D70) while offline and calls pickServer immediately", async () => {
    const { ThisDevice } = await import("../../web-v3/shell/Shell");
    const pickServer = vi.fn(() => true);
    const link = {
      attached: false,
      attachedServerId: () => null,
      pending: () => [],
      // Even if link.servers() is empty or stale while offline, offline menu uses device.servers[] (D70).
      servers: () => [],
      on: () => () => undefined,
    } as unknown as FeLink;

    const conn: Connection = {
      link,
      port: link as unknown as Connection["port"],
      path: "direct",
      revoked: false,
      serverId: SRV_A,
      pickServer,
      close: async () => undefined,
    };

    const device = makeDevice([
      { id: SRV_A, name: "Studio", dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: SRV_B, name: "Linux", dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
      { id: SRV_C, name: "OldBox", dh: DH_C, state: "gone" },
    ]);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    activeRoots.push({ root, el: host });

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device,
        connection: conn,
        path: "direct",
        serverId: SRV_A,
        onClose: () => undefined,
        onForget: () => undefined,
      }));
    });

    const select = host.querySelector('[data-testid="server-picker"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = [...select!.options];
    expect(options.map((o) => o.value)).toEqual([SRV_A, SRV_B, SRV_C]);
    expect(options[1]!.disabled).toBe(false);
    expect(options[2]!.disabled).toBe(true);
    expect(select!.value).toBe(SRV_A);

    await act(async () => {
      changeSelect(select!, SRV_B);
    });

    expect(pickServer).toHaveBeenCalledTimes(1);
    expect(pickServer).toHaveBeenCalledWith(SRV_B);
    expect(select!.value).toBe(SRV_B);
    expect(savePrefMock).not.toHaveBeenCalled();
  });

  it("Shell + openFallbackLink: selecting a server in This device › Server switches immediately, updates on peer frames, and reflects onServer", async () => {
    const dialed: DialedConn[] = [];
    const serverViews = [
      { id: SRV_A, name: "Studio", state: "live" as const, since: 100, dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: SRV_B, name: "Linux", state: "live" as const, since: 200, dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
    ];
    const makeDial = (serverId: string): Dial => (handlers) => {
      const conn: DialedConn = {
        serverId,
        handlers,
        closed: false,
        sendServer(msg) {
          const enc = encodeFrame(msg, "server", REMOTE);
          if (!enc.ok) throw new Error(enc.detail);
          handlers.frame(enc.text);
        },
        closeFromServer() {
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
          if (dec.message.t === "hello") {
            conn.sendServer({
              t: "welcome",
              serverId,
              protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
              minFeVersion: "3.0.0",
              rosterDigest: null,
              next: {},
              servers: serverViews,
              views: {},
            });
          } else if (dec.message.t === "sub" && dec.message.stream.startsWith("srv:")) {
            conn.sendServer({ t: "snap", stream: dec.message.stream, logId: `log-${serverId}`, seq: 0, hash: GENESIS_HASH, view: {} });
          }
        },
        close() {
          conn.closed = true;
        },
      } satisfies FeSocket;
    };

    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let capturedFb: FallbackLink | undefined;
    activeOpenConnectionImpl = async (device, _diag, _pageUrl, pathOrOpts) => {
      const opts = typeof pathOrOpts === "string" ? {} : (pathOrOpts ?? {});
      const fb = await openFallbackLink({
        storage,
        servers: [
          { id: SRV_A, name: "Studio", dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" }, directDial: makeDial(SRV_A) },
          { id: SRV_B, name: "Linux", dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" }, directDial: makeDial(SRV_B) },
        ],
        designatedServerId: device.server.memberId,
        deviceId: device.memberId,
        feVersion: FE_VERSION,
        local: false,
        clock,
        newEpoch: nextEpoch,
        onServer: opts.onServer,
      });
      capturedFb = fb;
      activeLinks.push(fb);
      return {
        link: fb.link,
        port: fb.link as unknown as Connection["port"],
        get path() { return fb.path; },
        get revoked() { return fb.revoked; },
        get serverId() { return fb.serverId ?? device.server.memberId; },
        pickServer(id: string) { return fb.pickServer(id); },
        close: () => fb.close(),
      };
    };

    const { Shell } = await import("../../web-v3/shell/Shell");
    const getFb = () => capturedFb;
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

    expect(dialed.map((d) => d.serverId)).toEqual([SRV_A]);
    expect(getFb()?.link.attachedServerId()).toBe(SRV_A);

    // Open "This device" sheet.
    const thisDeviceBtn = lastFooterEl?.querySelector("button");
    expect(thisDeviceBtn?.textContent).toBe("This device");
    await act(async () => {
      thisDeviceBtn!.click();
    });

    const select = el.querySelector('[data-testid="server-picker"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.value).toBe(SRV_A);
    expect([...select!.options].map((o) => o.value)).toEqual([SRV_A, SRV_B]);

    // A peer frame discovers SRV_C while the sheet is open.
    await act(async () => {
      dialed[0]!.sendServer({
        t: "peer",
        serverId: SRV_C,
        state: "live",
        since: 300,
        dh: DH_C,
        addresses: { tailnet: "wss://mini.example.invalid/v3/ws" },
      });
      await flush();
    });
    expect([...select!.options].map((o) => o.value)).toEqual([SRV_A, SRV_B, SRV_C]);

    // Pick server B: immediately switches away from A and attaches to B.
    await act(async () => {
      changeSelect(select!, SRV_B);
      await flush();
    });

    expect(dialed[0]!.closed).toBe(true);
    expect(dialed.map((d) => d.serverId)).toEqual([SRV_A, SRV_B]);
    expect(getFb()?.link.attachedServerId()).toBe(SRV_B);
    expect(select!.value).toBe(SRV_B);

    // If connection drops offline, Shell still lists learned servers (including SRV_C) from deviceServers state.
    await act(async () => {
      dialed[1]!.closeFromServer();
      await flush();
    });
    expect(getFb()?.link.attached).toBe(false);
    expect([...select!.options].map((o) => o.value)).toEqual([SRV_A, SRV_B, SRV_C]);

    // Picking server A while offline still triggers an immediate switch via 20a's pickServer and updates the picker.
    await act(async () => {
      changeSelect(select!, SRV_A);
      await flush();
    });
    expect(select!.value).toBe(SRV_A);
    expect(getFb()?.link.attachedServerId()).toBe(SRV_A);
    expect(savePrefMock).not.toHaveBeenCalled();
  });

  it("Shell + openFallbackLink: starting offline still lists device.servers[] (D70) and picking switches immediately", async () => {
    const dialedIds: string[] = [];
    const makeOfflineOrOnlineDial = (serverId: string, online: boolean): Dial => (handlers) => {
      dialedIds.push(serverId);
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        if (!online) {
          closed = true;
          handlers.close("refused");
        } else {
          handlers.open();
        }
      });
      return {
        send(frame: string) {
          if (!online) return;
          const dec = decodeFrame(frame, "fe", REMOTE);
          if (!dec.ok) return;
          if (dec.message.t === "hello") {
            const enc = encodeFrame({
              t: "welcome",
              serverId,
              protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
              minFeVersion: "3.0.0",
              rosterDigest: null,
              next: {},
              servers: [
                { id: SRV_A, name: "Studio", state: "stale", since: 100, dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
                { id: SRV_B, name: "Linux", state: "live", since: 200, dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
              ],
              views: {},
            }, "server", REMOTE);
            if (enc.ok) handlers.frame(enc.text);
          } else if (dec.message.t === "sub" && dec.message.stream.startsWith("srv:")) {
            const enc = encodeFrame({ t: "snap", stream: dec.message.stream, logId: `log-${serverId}`, seq: 0, hash: GENESIS_HASH, view: {} }, "server", REMOTE);
            if (enc.ok) handlers.frame(enc.text);
          }
        },
        close() { closed = true; },
      };
    };

    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let fbRef: FallbackLink | undefined;
    activeOpenConnectionImpl = async (device, _diag, _pageUrl, pathOrOpts) => {
      const opts = typeof pathOrOpts === "string" ? {} : (pathOrOpts ?? {});
      const fb = await openFallbackLink({
        storage,
        servers: [
          { id: SRV_A, name: "Studio", dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" }, directDial: makeOfflineOrOnlineDial(SRV_A, false) },
          { id: SRV_B, name: "Linux", dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" }, directDial: makeOfflineOrOnlineDial(SRV_B, true) },
        ],
        designatedServerId: device.server.memberId,
        deviceId: device.memberId,
        feVersion: FE_VERSION,
        local: false,
        clock,
        newEpoch: nextEpoch,
        onServer: opts.onServer,
      });
      fbRef = fb;
      activeLinks.push(fb);
      return {
        link: fb.link,
        port: fb.link as unknown as Connection["port"],
        get path() { return fb.path; },
        get revoked() { return fb.revoked; },
        get serverId() { return fb.serverId ?? device.server.memberId; },
        pickServer(id: string) { return fb.pickServer(id); },
        close: () => fb.close(),
      };
    };

    const { Shell } = await import("../../web-v3/shell/Shell");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    activeRoots.push({ root, el });

    await act(async () => { root.render(createElement(Shell)); });
    await act(async () => { await flush(); });

    expect(fbRef?.link.attached).toBe(false);
    expect(dialedIds).toEqual([SRV_A]);

    const thisDeviceBtn = lastFooterEl?.querySelector("button");
    await act(async () => { thisDeviceBtn!.click(); });

    const select = el.querySelector('[data-testid="server-picker"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.value).toBe(SRV_A);
    expect([...select!.options].map((o) => o.value)).toEqual([SRV_A, SRV_B]);

    // While offline, picking SRV_B switches immediately without waiting 30 s and attaches to SRV_B.
    await act(async () => {
      changeSelect(select!, SRV_B);
      await flush();
    });

    expect(dialedIds).toEqual([SRV_A, SRV_B]);
    expect(fbRef?.link.attachedServerId()).toBe(SRV_B);
    expect(select!.value).toBe(SRV_B);
  });

  it("distinguishes target (conn.serverId) vs attached (conn.link.attachedServerId()) states in ThisDevice", async () => {
    const { ThisDevice } = await import("../../web-v3/shell/Shell");
    const listeners = new Set<(e: { type: string; attached?: boolean }) => void>();
    let currentAttached = true;
    let currentAttachedId: string | null = SRV_A;
    let currentTargetId = SRV_B;
    const link = {
      get attached() { return currentAttached; },
      attachedServerId: () => currentAttachedId,
      pending: () => [],
      servers: () => [
        { id: SRV_A, name: "Studio", state: "live" as const, since: null, self: true, dh: DH_A },
        { id: SRV_B, name: "Linux", state: "live" as const, since: null, self: false, dh: DH_B },
      ],
      on: (fn: (e: { type: string; attached?: boolean }) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as FeLink;

    const conn: Connection = {
      link,
      port: link as unknown as Connection["port"],
      path: "direct",
      revoked: false,
      get serverId() { return currentTargetId; },
      pickServer: vi.fn(() => true),
      close: async () => undefined,
    };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    activeRoots.push({ root, el: host });

    // Target is SRV_B while still attached to SRV_A: target and attached must both be visible & distinct.
    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: makeDevice(),
        connection: conn,
        path: "direct",
        serverId: SRV_B,
        onClose: () => undefined,
        onForget: () => undefined,
      }));
    });

    const select = host.querySelector('[data-testid="server-picker"]') as HTMLSelectElement;
    const status = host.querySelector('[data-testid="server-status"]') as HTMLElement | null;
    expect(select.value).toBe(SRV_B);
    expect(select.getAttribute("data-target")).toBe(SRV_B);
    expect(select.getAttribute("data-attached")).toBe(SRV_A);
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Linux");
    expect(status!.textContent).toContain("Studio");
    expect(select.options[0]!.textContent).toContain("(attached)");
    expect(select.options[1]!.textContent).toContain("(target)");

    // Once SRV_B attaches, attachedServerId() becomes SRV_B and status reflects Attached to Linux.
    currentAttachedId = SRV_B;
    await act(async () => {
      for (const fn of listeners) fn({ type: "attached", attached: true });
    });
    expect(select.getAttribute("data-target")).toBe(SRV_B);
    expect(select.getAttribute("data-attached")).toBe(SRV_B);
    expect(status!.textContent).toBe("Attached to Linux");
    expect(select.options[1]!.textContent).toContain("(attached)");
    expect(select.options[1]!.textContent).not.toContain("(target)");

    // When disconnected, attachedServerId() is not shown as attached even if link.server cached SRV_B.
    currentAttached = false;
    await act(async () => {
      for (const fn of listeners) fn({ type: "attached", attached: false });
    });
    expect(select.getAttribute("data-target")).toBe(SRV_B);
    expect(select.getAttribute("data-attached")).toBe("");
    expect(status!.textContent).toBe("Connecting to Linux…");
  });

  it("Shell + openFallbackLink: shows target vs attached while switching to a slow server, and re-picking current server does not restart 30 s window", async () => {
    const dialed: Array<{ serverId: string; handlers: SocketHandlers; closed: boolean; holdWelcome: boolean; sendWelcome: () => void }> = [];
    const serverViews = [
      { id: SRV_A, name: "Studio", state: "live" as const, since: 100, dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: SRV_B, name: "Linux", state: "live" as const, since: 200, dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
    ];
    let holdWelcomeFor: string | null = null;
    const makeDial = (serverId: string): Dial => (handlers) => {
      const rec = {
        serverId,
        handlers,
        closed: false,
        holdWelcome: holdWelcomeFor === serverId,
        sendWelcome() {
          const enc = encodeFrame({
            t: "welcome",
            serverId,
            protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
            minFeVersion: "3.0.0",
            rosterDigest: null,
            next: {},
            servers: serverViews,
            views: {},
          }, "server", REMOTE);
          if (enc.ok) handlers.frame(enc.text);
        },
      };
      dialed.push(rec);
      queueMicrotask(() => { if (!rec.closed) handlers.open(); });
      return {
        send(frame: string) {
          const dec = decodeFrame(frame, "fe", REMOTE);
          if (!dec.ok) return;
          if (dec.message.t === "hello" && !rec.holdWelcome) rec.sendWelcome();
          else if (dec.message.t === "sub" && dec.message.stream.startsWith("srv:")) {
            const enc = encodeFrame({ t: "snap", stream: dec.message.stream, logId: `log-${serverId}`, seq: 0, hash: GENESIS_HASH, view: {} }, "server", REMOTE);
            if (enc.ok) handlers.frame(enc.text);
          }
        },
        close() { rec.closed = true; },
      };
    };

    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let fbRef: FallbackLink | undefined;
    activeOpenConnectionImpl = async (device, _diag, _pageUrl, pathOrOpts) => {
      const opts = typeof pathOrOpts === "string" ? {} : (pathOrOpts ?? {});
      const fb = await openFallbackLink({
        storage,
        servers: [
          { id: SRV_A, name: "Studio", dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" }, directDial: makeDial(SRV_A) },
          { id: SRV_B, name: "Linux", dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" }, directDial: makeDial(SRV_B) },
        ],
        designatedServerId: device.server.memberId,
        deviceId: device.memberId,
        feVersion: FE_VERSION,
        local: false,
        clock,
        newEpoch: nextEpoch,
        onServer: opts.onServer,
      });
      fbRef = fb;
      activeLinks.push(fb);
      return {
        link: fb.link,
        port: fb.link as unknown as Connection["port"],
        get path() { return fb.path; },
        get revoked() { return fb.revoked; },
        get serverId() { return fb.serverId ?? device.server.memberId; },
        pickServer(id: string) { return fb.pickServer(id); },
        close: () => fb.close(),
      };
    };

    const { Shell } = await import("../../web-v3/shell/Shell");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    activeRoots.push({ root, el });

    await act(async () => { root.render(createElement(Shell)); });
    await act(async () => { await flush(); });

    const thisDeviceBtn = lastFooterEl?.querySelector("button");
    await act(async () => { thisDeviceBtn!.click(); });

    const select = el.querySelector('[data-testid="server-picker"]') as HTMLSelectElement;
    const status = el.querySelector('[data-testid="server-status"]') as HTMLElement;
    expect(select.getAttribute("data-target")).toBe(SRV_A);
    expect(select.getAttribute("data-attached")).toBe(SRV_A);
    expect(status.textContent).toBe("Attached to Studio");

    // Pick SRV_B while SRV_B holds its welcome (target = SRV_B, attached = none yet).
    holdWelcomeFor = SRV_B;
    await act(async () => {
      changeSelect(select, SRV_B);
      await flush();
    });
    expect(select.value).toBe(SRV_B);
    expect(select.getAttribute("data-target")).toBe(SRV_B);
    expect(select.getAttribute("data-attached")).toBe("");
    expect(status.textContent).toBe("Connecting to Linux…");

    // Advance 20 s while SRV_B has not welded, then re-call pickServer(SRV_B): must NOT restart the 30 s timer.
    clock.advance(20_000);
    await act(async () => { await flush(); });
    expect(fbRef!.pickServer(SRV_B)).toBe(true);
    expect(fbRef!.serverId).toBe(SRV_B);

    // Advance remaining 10 s (30 s total): auto-switch fires back to SRV_A (not postponed to 50 s!).
    clock.advance(10_000);
    await act(async () => { await flush(); });
    expect(fbRef!.serverId).toBe(SRV_A);
    expect(fbRef!.link.attachedServerId()).toBe(SRV_A);
    expect(select.getAttribute("data-target")).toBe(SRV_A);
    expect(select.getAttribute("data-attached")).toBe(SRV_A);
    expect(status.textContent).toBe("Attached to Studio");
  });

  it("marks options gone in the picker from deviceServers (knownServers) even when connected link.servers() lists them live", async () => {
    const { ThisDevice } = await import("../../web-v3/shell/Shell");
    const link = {
      attached: true,
      attachedServerId: () => SRV_A,
      pending: () => [],
      servers: () => [
        { id: SRV_A, name: "Studio", state: "live" as const, since: null, self: true, dh: DH_A },
        { id: SRV_B, name: "Linux", state: "live" as const, since: 100, self: false, dh: DH_B },
        { id: SRV_C, name: "Removed", state: "live" as const, since: 200, self: false, dh: DH_C },
      ],
      on: () => () => undefined,
    } as unknown as FeLink;

    const conn: Connection = {
      link,
      port: link as unknown as Connection["port"],
      path: "direct",
      revoked: false,
      serverId: SRV_A,
      pickServer: vi.fn(() => true),
      close: async () => undefined,
    };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    activeRoots.push({ root, el: host });

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: makeDevice(),
        connection: conn,
        path: "direct",
        serverId: SRV_A,
        knownServers: [
          { id: SRV_A, name: "Studio", dh: DH_A, state: "live" },
          { id: SRV_B, name: "Linux", dh: DH_B, state: "live" },
          { id: SRV_C, name: "Removed", dh: DH_C, state: "gone" },
        ],
        onClose: () => undefined,
        onForget: () => undefined,
      }));
    });

    const select = host.querySelector('[data-testid="server-picker"]') as HTMLSelectElement;
    const options = [...select.options];
    expect(options.map((o) => o.value)).toEqual([SRV_A, SRV_B, SRV_C]);
    expect(options[0]!.disabled).toBe(false);
    expect(options[1]!.disabled).toBe(false);
    expect(options[2]!.disabled).toBe(true);
    expect(options[2]!.textContent).toContain("(removed)");
  });

  it("Shell + openFallbackLink: marks gone options from sticky deviceServers when attached to a lagging server whose welcome lists them live", async () => {
    const dialed: DialedConn[] = [];
    const laggingWelcomeServers = [
      { id: SRV_A, name: "Studio", state: "live" as const, since: 100, dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: SRV_B, name: "Linux", state: "live" as const, since: 200, dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
      { id: SRV_C, name: "Removed", state: "live" as const, since: 300, dh: DH_C, addresses: { tailnet: "wss://mini.example.invalid/v3/ws" } },
    ];
    const makeDial = (serverId: string): Dial => (handlers) => {
      const conn: DialedConn = {
        serverId,
        handlers,
        closed: false,
        sendServer(msg) {
          const enc = encodeFrame(msg, "server", REMOTE);
          if (!enc.ok) throw new Error(enc.detail);
          handlers.frame(enc.text);
        },
        closeFromServer() {
          if (conn.closed) return;
          conn.closed = true;
          handlers.close("closed");
        },
      };
      dialed.push(conn);
      queueMicrotask(() => { if (!conn.closed) handlers.open(); });
      return {
        send(frame: string) {
          const dec = decodeFrame(frame, "fe", REMOTE);
          if (!dec.ok) return;
          if (dec.message.t === "hello") {
            conn.sendServer({
              t: "welcome",
              serverId,
              protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
              minFeVersion: "3.0.0",
              rosterDigest: null,
              next: {},
              servers: laggingWelcomeServers,
              views: {},
            });
          } else if (dec.message.t === "sub" && dec.message.stream.startsWith("srv:")) {
            conn.sendServer({ t: "snap", stream: dec.message.stream, logId: `log-${serverId}`, seq: 0, hash: GENESIS_HASH, view: {} });
          }
        },
        close() { conn.closed = true; },
      } satisfies FeSocket;
    };

    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    let fbRef: FallbackLink | undefined;
    activeOpenConnectionImpl = async (device, _diag, _pageUrl, pathOrOpts) => {
      const opts = typeof pathOrOpts === "string" ? {} : (pathOrOpts ?? {});
      const fb = await openFallbackLink({
        storage,
        servers: [
          { id: SRV_A, name: "Studio", dh: DH_A, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" }, directDial: makeDial(SRV_A) },
          { id: SRV_B, name: "Linux", dh: DH_B, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" }, directDial: makeDial(SRV_B) },
        ],
        designatedServerId: device.server.memberId,
        deviceId: device.memberId,
        feVersion: FE_VERSION,
        local: false,
        clock,
        newEpoch: nextEpoch,
        onServer: opts.onServer,
      });
      fbRef = fb;
      activeLinks.push(fb);
      return {
        link: fb.link,
        port: fb.link as unknown as Connection["port"],
        get path() { return fb.path; },
        get revoked() { return fb.revoked; },
        get serverId() { return fb.serverId ?? device.server.memberId; },
        pickServer(id: string) { return fb.pickServer(id); },
        close: () => fb.close(),
      };
    };

    const { Shell } = await import("../../web-v3/shell/Shell");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    activeRoots.push({ root, el });

    await act(async () => { root.render(createElement(Shell)); });
    await act(async () => { await flush(); });

    const thisDeviceBtn = lastFooterEl?.querySelector("button");
    await act(async () => { thisDeviceBtn!.click(); });

    // Server A learns SRV_C is gone via a peer frame; saveDeviceServers persists sticky gone into deviceServers.
    await act(async () => {
      dialed[0]!.sendServer({ t: "peer", serverId: SRV_C, state: "gone", since: 400, dh: DH_C });
      await flush();
    });

    const select = el.querySelector('[data-testid="server-picker"]') as HTMLSelectElement;
    // Switch to lagging Server B whose welcome still lists SRV_C as live.
    await act(async () => {
      changeSelect(select, SRV_B);
      await flush();
    });

    expect(fbRef?.link.attachedServerId()).toBe(SRV_B);
    expect(fbRef?.link.servers().find((s) => s.id === SRV_C)?.state).toBe("live");
    const optC = [...select.options].find((o) => o.value === SRV_C);
    expect(optC).toBeDefined();
    expect(optC!.disabled).toBe(true);
    expect(optC!.textContent).toContain("(removed)");
  });

  it("requires serverId on ThisDevice and keeps selectedServerId driven by the serverId prop", async () => {
    const { ThisDevice } = await import("../../web-v3/shell/Shell");
    type ThisDeviceProps = Parameters<typeof ThisDevice>[0];
    expectTypeOf<ThisDeviceProps["serverId"]>().toEqualTypeOf<string>();

    const listeners = new Set<(e: { type: string; attached?: boolean }) => void>();
    const link = {
      attached: false,
      attachedServerId: () => SRV_B,
      pending: () => [],
      servers: () => [
        { id: SRV_A, name: "Studio", state: "live" as const, since: null, self: true, dh: DH_A },
        { id: SRV_B, name: "Linux", state: "live" as const, since: null, self: false, dh: DH_B },
      ],
      on: (fn: (e: { type: string; attached?: boolean }) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as FeLink;

    const conn: Connection = {
      link,
      port: link as unknown as Connection["port"],
      path: "direct",
      revoked: false,
      serverId: SRV_B,
      pickServer: vi.fn(() => true),
      close: async () => undefined,
    };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    activeRoots.push({ root, el: host });

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: makeDevice(),
        connection: conn,
        path: "direct",
        serverId: SRV_A,
        onClose: () => undefined,
        onForget: () => undefined,
      }));
    });

    const select = host.querySelector('[data-testid="server-picker"]') as HTMLSelectElement;
    expect(select.value).toBe(SRV_A);

    await act(async () => {
      for (const fn of listeners) fn({ type: "attached", attached: true });
    });
    expect(select.value).toBe(SRV_A);

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: makeDevice(),
        connection: conn,
        path: "direct",
        serverId: SRV_B,
        onClose: () => undefined,
        onForget: () => undefined,
      }));
    });
    expect(select.value).toBe(SRV_B);
  });
});
