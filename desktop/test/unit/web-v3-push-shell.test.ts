// @vitest-environment jsdom
// Botling 3 M4-25 F3: Shell Workspace `forget()` and `bye{revoked}` must unsubscribe any browser Web Push
// subscription and clear push preferences so forgetting + re-pairing never leaves duplicate endpoints.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFeStorage, type FeLink } from "../../src/fe-link";
import { toBase64Url } from "../../src/protocol";
import type { Connection, DialPath, Diagnostics, OpenConnectionOptions } from "../../web-v3/shell/connection";
import type { DeviceRecord } from "../../web-v3/shell/device-store";
import { flush } from "./fe-link-harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRV_A = "srva-000000000000000000000";
const callOrder: string[] = [];
const prefs = new Map<string, string>([
  ["pushEnabled", "1"],
  ["pushVapidKey", "k1"],
  ["pushVapidKeys", JSON.stringify(["k1"])],
]);

const currentDevice: DeviceRecord = {
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
  scope: ["read", "reply", "approve", "manage"],
  pairedAt: 1000,
  servers: [{ id: SRV_A, name: "Studio", dh: toBase64Url(new Uint8Array(32).fill(1)) }],
};

vi.mock("../../web-v3/shell/device-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/device-store")>();
  return {
    ...actual,
    loadDevice: async () => currentDevice,
    loadPref: async (k: string) => prefs.get(k) ?? null,
    savePref: async (k: string, v: string) => {
      callOrder.push(`savePref:${k}=${v}`);
      prefs.set(k, v);
    },
    saveDevice: async () => undefined,
    saveDeviceServers: async () => currentDevice.servers ?? [],
    forgetDevice: async () => {
      callOrder.push("forgetDevice");
    },
  };
});

let footerEl: HTMLElement | null = null;
let footerRoot: Root | null = null;
function renderChrome(chrome?: { railFooter?: unknown }) {
  if (!chrome?.railFooter) return;
  if (!footerEl) {
    footerEl = document.createElement("div");
    document.body.appendChild(footerEl);
    footerRoot = createRoot(footerEl);
  }
  footerRoot?.render(chrome.railFooter as ReactElement);
}

vi.mock("../../web-v3/bridge-v3", () => ({
  mountRenderer: (_el: HTMLElement, opts: { chrome?: { railFooter?: unknown } }) => {
    renderChrome(opts.chrome);
    return {
      render(chrome: { railFooter?: unknown }) { renderChrome(chrome); },
      unmount() {
        footerRoot?.unmount();
        footerRoot = null;
        footerEl?.remove();
        footerEl = null;
      },
      store: { select: () => undefined, resync: async () => undefined },
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
    MediaBroker: class { start() {} stop() {} setPath() {} dropCached() {} },
  };
});

vi.mock("../../web-v3/shell/sw-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/sw-bridge")>();
  return { ...actual, SwBridge: class { start() {} stop() {} } };
});

vi.mock("../../web-v3/shell/uploads", () => ({
  PageUploads: class { start() {} stop() {} },
}));

type LinkListener = (event: { type: string; reason?: string; attached?: boolean }) => void;
let linkListeners = new Set<LinkListener>();
let activeOpts: OpenConnectionOptions | undefined;

vi.mock("../../web-v3/shell/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web-v3/shell/connection")>();
  return {
    ...actual,
    openConnection: async (_dev: DeviceRecord, _diag: Diagnostics, _url: string, opts?: DialPath | OpenConnectionOptions): Promise<Connection> => {
      activeOpts = typeof opts === "object" ? opts : undefined;
      const fakeLink = {
        attached: true,
        attachedServerId: () => SRV_A,
        status: { state: "live" as const },
        pending: () => [],
        servers: () => [{ id: SRV_A, name: "Studio", state: "live" as const, since: null, self: true }],
        vapidPublicKey: null,
        sendPushSubscribe: () => false,
        start: () => undefined,
        close: () => undefined,
        on: (fn: LinkListener) => { linkListeners.add(fn); return () => linkListeners.delete(fn); },
      } as unknown as FeLink;
      return {
        link: fakeLink,
        port: new MemoryFeStorage() as unknown as Connection["port"],
        path: "direct",
        revoked: false,
        serverId: SRV_A,
        close: async () => undefined,
      };
    },
  };
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  linkListeners = new Set();
  activeOpts = undefined;
  callOrder.length = 0;
  prefs.set("pushEnabled", "1");
  prefs.set("pushVapidKey", "k1");
  prefs.set("pushVapidKeys", JSON.stringify(["k1"]));
});

describe("M4-25 F3: Shell Workspace forget() and revoked() unsubscribe push", () => {
  function setupFakeSw() {
    let unsubscribes = 0;
    const origSw = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({
              unsubscribe: async () => {
                unsubscribes += 1;
                callOrder.push("push.unsubscribe");
                return true;
              },
            }),
          },
        }),
      },
    });
    cleanups.push(() => {
      if (origSw) Object.defineProperty(navigator, "serviceWorker", origSw);
      else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    });
    return () => unsubscribes;
  }

  it("unsubscribes push and clears push prefs before forgetDevice when forgetting this device", async () => {
    const getUnsubs = setupFakeSw();
    const { Shell } = await import("../../web-v3/shell/Shell");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });

    await act(async () => {
      root.render(createElement(Shell));
      await flush();
    });

    const openBtn = footerEl?.querySelector("button.web-sign-out") as HTMLButtonElement | null;
    expect(openBtn).not.toBeNull();
    await act(async () => {
      openBtn!.click();
      await flush();
    });

    const forgetTrigger = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Forget this device"));
    expect(forgetTrigger).toBeDefined();
    await act(async () => {
      forgetTrigger!.click();
      await flush();
    });

    const confirmBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Forget");
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      confirmBtn!.click();
      await flush();
    });

    expect(getUnsubs()).toBe(1);
    expect(prefs.get("pushEnabled")).toBe("0");
    expect(prefs.get("pushVapidKey")).toBe("");
    const unsubIdx = callOrder.indexOf("push.unsubscribe");
    const forgetIdx = callOrder.indexOf("forgetDevice");
    expect(unsubIdx).toBeGreaterThanOrEqual(0);
    expect(forgetIdx).toBeGreaterThan(unsubIdx);
  });

  it("unsubscribes push and clears push prefs when bye{revoked} arrives", async () => {
    const getUnsubs = setupFakeSw();
    const { Shell } = await import("../../web-v3/shell/Shell");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });

    await act(async () => {
      root.render(createElement(Shell));
      await flush();
    });

    await act(async () => {
      activeOpts?.onRevoked?.();
      await flush();
    });

    expect(getUnsubs()).toBe(1);
    expect(prefs.get("pushEnabled")).toBe("0");
    expect(prefs.get("pushVapidKey")).toBe("");
    expect(host.querySelector('[data-testid="conn-banner"]')?.getAttribute("data-state")).toBe("needs pairing");
  });
});
