// @vitest-environment jsdom
// Botling 3 M4-25: Page-side Web Push subscription ("This device" opt-in, never on load) and service worker
// `push` / `notificationclick` handlers (protocol v1 §18.4, Q-P1..Q-P4).
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { FeLink, MemoryFeStorage, type Dial } from "../../src/fe-link";
import { decodeFrame, FrameSplitter, packFrame, toBase64Url, Welcome, type CmdBody, type Message, type MessageOf, type Scope, type SessionKind } from "../../src/protocol";
import { Session, SessionCore, type SessionHost } from "../../src/server/session";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { formatPushNotification, handleNotificationClick, handlePush, resolveNotificationUrl, type PushNotificationOptions } from "../../web-v3/push-sw";
import { decodeApplicationServerKey, enablePushNotifications, extractPushSubscription, pushSupport, syncPushOnAttach, type PushPrefs } from "../../web-v3/shell/push";
import { ThisDevice } from "../../web-v3/shell/Shell";
import type { Connection } from "../../web-v3/shell/connection";
import type { DeviceRecord } from "../../web-v3/shell/device-store";
import { FakeClock, FakeServer, flush } from "./fe-link-harness";

const links: FeLink[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function makeVapidPub(fill = 7): string {
  const bytes = new Uint8Array(65).fill(fill);
  bytes[0] = 4;
  return toBase64Url(bytes);
}

function makeP256Pub(fill = 11): string {
  const bytes = new Uint8Array(65).fill(fill);
  bytes[0] = 4;
  return toBase64Url(bytes);
}

function makeAuth(fill = 22): string {
  return toBase64Url(new Uint8Array(16).fill(fill));
}

const DEVICE: DeviceRecord = {
  v: 1,
  cluster: "c1",
  memberId: "a".repeat(26),
  name: "Phone",
  signKey: {} as CryptoKey,
  signPub: "pub",
  addId: "a1",
  scope: ["read", "reply", "approve", "manage"],
  pairedAt: 1_700_000_000_000,
  dhKey: {} as CryptoKey,
  dhPub: new Uint8Array(32),
  server: { memberId: "b".repeat(26), name: "Mac", dhPub: new Uint8Array(32) },
};

function makeFakeSubscription(endpoint = "https://push.example.com/sub/1", p256dhBytes?: Uint8Array, authBytes?: Uint8Array) {
  const p256dh = p256dhBytes ?? (() => { const b = new Uint8Array(65).fill(15); b[0] = 4; return b; })();
  const auth = authBytes ?? new Uint8Array(16).fill(31);
  let unsubscribed = false;
  return {
    endpoint,
    options: { applicationServerKey: null as ArrayBuffer | null },
    getKey(name: "p256dh" | "auth") {
      return name === "p256dh" ? p256dh.buffer.slice(0) : auth.buffer.slice(0);
    },
    toJSON() {
      return { endpoint, keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) } };
    },
    async unsubscribe() {
      unsubscribed = true;
      return true;
    },
    get wasUnsubscribed() { return unsubscribed; },
  };
}

class TestRemoteSession extends SessionCore {
  protected readonly kind: SessionKind = { local: false };
  readonly sent: Message[] = [];

  constructor(host: SessionHost) { super(host); }
  protected get writable(): boolean { return true; }
  protected writeTexts(texts: string[]): boolean {
    for (const text of texts) {
      const decoded = decodeFrame(text, "server", this.kind);
      if (decoded.ok) this.sent.push(decoded.message as Message);
    }
    return true;
  }
  protected endTransport(): void {}
  protected destroyTransport(): void {}
  protected checkHello() { return null; }
  protected cmdScope(_body: CmdBody): { scope: Scope } { return { scope: "read" }; }
  protected reqRefusal(_cmd: Command) { return null; }

  receiveHello(msg: MessageOf<"hello">): void { this.onMessage(msg); }
}

class FakeLocalSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: Uint8Array[] = [];

  write(bytes: Uint8Array): boolean { this.writes.push(bytes); return true; }
  end(): void {}
  destroy(): void { this.destroyed = true; }
  feedRaw(value: unknown): void { this.emit("data", Buffer.from(packFrame(JSON.stringify(value)))); }
  frames(): Message[] {
    const splitter = new FrameSplitter();
    const out: Message[] = [];
    for (const chunk of this.writes) {
      const split = splitter.push(chunk);
      if (!split.ok) throw new Error(split.detail);
      for (const frame of split.frames) {
        const decoded = decodeFrame(frame, "server", { local: true });
        if (!decoded.ok) throw new Error(decoded.detail);
        out.push(decoded.message as Message);
      }
    }
    return out;
  }
}

describe("M4-25 protocol & FeLink push support", () => {
  it("Welcome accepts optional valid vapidPublicKey and rejects malformed ones", () => {
    const base = {
      t: "welcome" as const,
      serverId: "srv1",
      protocol: { min: 1, max: 1 },
      minFeVersion: "3.0.0",
      rosterDigest: null,
      servers: [{ id: "srv1", name: "Mac", state: "live" as const, since: null }],
      next: {},
      views: {},
    };
    expect(Welcome.safeParse(base).success).toBe(true);
    expect(Welcome.safeParse({ ...base, vapidPublicKey: makeVapidPub(9) }).success).toBe(true);
    // Compressed point (starts with 0x02) and truncated key must fail.
    const compressed = new Uint8Array(65).fill(2);
    expect(Welcome.safeParse({ ...base, vapidPublicKey: toBase64Url(compressed) }).success).toBe(false);
    expect(Welcome.safeParse({ ...base, vapidPublicKey: "too-short" }).success).toBe(false);
  });

  it("SessionCore includes welcome.vapidPublicKey only on remote sessions when host provides one", async () => {
    const store = await openServerStore(":memory:");
    const engine = new FakeTurnEngine({ bots: ["6A0B0000-0000-4000-8000-000000000002"] });
    const hub = new LogHub(store, { serverStreams: true });
    const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
    const runtime = new IntentRuntime({ store, engine, hub, live, log: () => undefined });
    await runtime.start();
    cleanups.push(async () => {
      await runtime.scope.submit(() => undefined);
      engine.close();
      runtime.close();
      live.close();
      hub.close();
      await store.close();
    });

    const vapidKey = makeVapidPub(12);
    const host: SessionHost = {
      serverId: "srv1",
      serverName: "Mac",
      startedAt: Date.now(),
      minFeVersion: "3.0.0",
      token: () => "t".repeat(32),
      hub,
      live,
      runtime,
      engine,
      content: null,
      shell: new ShellBridge(),
      nextFor: () => ({}),
      ensureBotStream: async (botId) => { await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
      log: () => undefined,
      vapidPublicKey: () => vapidKey,
    };

    const remoteSession = new TestRemoteSession(host);
    remoteSession.receiveHello({
      t: "hello",
      deviceId: "dev1",
      feVersion: "3.0.0",
      protocol: 1,
      originEpoch: "0".repeat(32),
      cursors: {},
      outbox: [],
      want: [],
    });
    const remoteWelcome = remoteSession.sent.find((m): m is MessageOf<"welcome"> => m.t === "welcome");
    remoteSession.close();

    const socket = new FakeLocalSocket();
    const localSession = new Session(socket as never, host);
    socket.feedRaw({
      t: "hello",
      deviceId: "dev1",
      feVersion: "3.0.0",
      protocol: 1,
      originEpoch: "0".repeat(32),
      cursors: {},
      outbox: [],
      want: [],
      token: "t".repeat(32),
    });
    const localWelcome = socket.frames().find((m): m is MessageOf<"welcome"> => m.t === "welcome");
    localSession.close();

    expect(remoteWelcome?.vapidPublicKey).toBe(vapidKey);
    expect(localWelcome?.vapidPublicKey).toBeUndefined();
  });

  it("FeLink learns vapidPublicKey from welcome and sends push.subscribe live without touching the outbox", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const vapidKey = makeVapidPub(14);
    const sentToServer: Message[] = [];
    const dial: Dial = (handlers) => {
      const inner = server.dial({
        open: () => handlers.open(),
        frame: (raw) => {
          if (typeof raw === "string") {
            const parsed = JSON.parse(raw) as Message;
            if (parsed.t === "welcome") {
              handlers.frame(JSON.stringify({ ...parsed, vapidPublicKey: vapidKey }));
              return;
            }
          }
          handlers.frame(raw);
        },
        close: (detail) => handlers.close(detail),
      });
      return {
        send: (frame) => {
          sentToServer.push(JSON.parse(frame) as Message);
          inner.send(frame);
        },
        close: () => inner.close(),
      };
    };

    const link = await FeLink.open({
      storage: new MemoryFeStorage(),
      dial,
      deviceId: "dev1",
      feVersion: "3.0.0",
      local: false,
      clock,
    });
    links.push(link);

    // Offline: sendPushSubscribe must refuse (never queue into durable outbox).
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: makeP256Pub(5), auth: makeAuth(6) } };
    expect(link.sendPushSubscribe(sub)).toBe(false);
    expect(link.pending()).toEqual([]);

    link.start();
    await flush();
    expect(link.vapidPublicKey).toBe(vapidKey);

    // Invalid endpoint (loopback/private SSRF) must be refused client-side too.
    expect(link.sendPushSubscribe({ ...sub, endpoint: "http://127.0.0.1:8080/push" })).toBe(false);
    expect(sentToServer.some((m) => m.t === "push.subscribe")).toBe(false);

    // Valid subscription sends live over session and never creates an outbox item.
    expect(link.sendPushSubscribe(sub)).toBe(true);
    expect(link.pending()).toEqual([]);
    const pushed = sentToServer.filter((m): m is MessageOf<"push.subscribe"> => m.t === "push.subscribe");
    expect(pushed).toEqual([{ t: "push.subscribe", endpoint: sub.endpoint, keys: sub.keys }]);

    // Local link never sends push.subscribe.
    const localLink = await FeLink.open({
      storage: new MemoryFeStorage(),
      dial,
      deviceId: "dev-local",
      feVersion: "3.0.0",
      local: true,
      clock,
    });
    links.push(localLink);
    localLink.start();
    await flush();
    expect(localLink.sendPushSubscribe(sub)).toBe(false);
  });
});

describe("M4-25 service worker push and notificationclick handlers", () => {
  it("formats lock-screen notification as bot name + 'needs you' and ignores any message text", () => {
    const scope = "https://mac.tailnet.ts.net/v3/";
    const formatted = formatPushNotification(
      {
        botId: "bot-alpha_1",
        botName: "  Builder\n\x1b[31mBot\t ",
        kind: "approval",
        text: "SECRET PROMPT TEXT MUST NEVER APPEAR",
        body: "SECRET BODY MUST NEVER APPEAR",
        message: "SECRET MESSAGE",
      },
      scope,
    );
    expect(formatted.title).toBe("Builder Bot");
    expect(formatted.options.body).toBe("needs you");
    expect(formatted.options.tag).toBe("botling-needs-bot-alpha_1");
    expect(formatted.options.icon).toBe("https://mac.tailnet.ts.net/v3/icon-192.png");
    expect(formatted.options.data).toEqual({
      url: "https://mac.tailnet.ts.net/v3/?bot=bot-alpha_1",
      botId: "bot-alpha_1",
    });
    expect(JSON.stringify(formatted)).not.toContain("SECRET");
  });

  it("handles missing/malformed payloads and rejects unsafe botId / external URLs", () => {
    const scope = "https://mac.tailnet.ts.net/v3/";
    expect(formatPushNotification(null, scope)).toMatchObject({
      title: "Botling",
      options: { body: "A bot needs you", tag: "botling-needs", data: { url: "https://mac.tailnet.ts.net/v3/" } },
    });
    expect(formatPushNotification("{bad json", scope)).toMatchObject({
      title: "Botling",
      options: { body: "A bot needs you" },
    });
    const traversal = formatPushNotification({ botId: "../admin", botName: "Scout" }, scope);
    expect(traversal.options.tag).toBe("botling-needs");
    expect(traversal.options.data).toEqual({ url: "https://mac.tailnet.ts.net/v3/" });
    expect(resolveNotificationUrl({ url: "https://evil.example/phish", botId: "../evil" }, scope)).toBe("https://mac.tailnet.ts.net/v3/");
  });

  it("handlePush shows notification and handleNotificationClick focuses existing /v3/ window or opens a new one", async () => {
    const shown: Array<{ title: string; options: PushNotificationOptions | undefined }> = [];
    const posted: unknown[] = [];
    let focused = 0;
    let openedUrl: string | null = null;
    let closed = 0;

    const swScope = {
      location: new URL("https://mac.tailnet.ts.net/v3/sw.js") as unknown as Location,
      registration: {
        scope: "https://mac.tailnet.ts.net/v3/",
        showNotification: async (title: string, options?: PushNotificationOptions) => { shown.push({ title, options }); },
      },
      clients: {
        matchAll: async () => [{
          id: "w1",
          url: "https://mac.tailnet.ts.net/v3/",
          postMessage: (msg: unknown) => posted.push(msg),
          focus: async () => { focused += 1; },
        }],
        openWindow: async (url: string) => { openedUrl = url; return null; },
      },
    };

    await handlePush(swScope, {
      data: { json: () => ({ botId: "b1", botName: "Reviewer" }) },
    });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Reviewer");
    expect(shown[0].options?.body).toBe("needs you");

    await handleNotificationClick(swScope, {
      notification: {
        data: shown[0].options?.data,
        close: () => { closed += 1; },
      },
    });
    expect(closed).toBe(1);
    expect(focused).toBe(1);
    expect(posted).toEqual([{ botling3: "push.open", botId: "b1" }]);
    expect(openedUrl).toBeNull();

    // When no /v3/ window is open, openWindow is called with the safe /v3/ URL.
    const swNoWindow = {
      ...swScope,
      clients: {
        matchAll: async () => [{ id: "other", url: "https://mac.tailnet.ts.net/other", postMessage: () => undefined }],
        openWindow: async (url: string) => { openedUrl = url; return null; },
      },
    };
    await handleNotificationClick(swNoWindow, {
      notification: { data: { botId: "b1", url: "https://evil.example/" }, close: () => undefined },
    });
    expect(openedUrl).toBe("https://mac.tailnet.ts.net/v3/?bot=b1");
  });

  it("sw.ts registers push and notificationclick listeners and keeps zero storage usage", () => {
    const swSrc = readFileSync(join(__dirname, "../../web-v3/sw.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(swSrc).toContain('addEventListener("push"');
    expect(swSrc).toContain('addEventListener("notificationclick"');
    expect(swSrc).not.toMatch(/\bcaches\b|indexedDB|localStorage|sessionStorage/);
  });
});

describe("M4-25 page push opt-in UI and iOS Home Screen rules", () => {
  it("reports iOS Safari tab as requiring the Home Screen app", () => {
    expect(pushSupport({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
      standalone: false,
      matchMediaStandalone: false,
      hasServiceWorker: false,
      hasPushManager: false,
      notificationPermission: undefined,
    })).toEqual({
      supported: false,
      reason: "ios-home-screen",
      message: "Add this app to your Home Screen to enable notifications on iPhone or iPad.",
    });

    expect(pushSupport({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
      standalone: true,
      matchMediaStandalone: true,
      hasServiceWorker: true,
      hasPushManager: true,
      notificationPermission: "default",
    })).toEqual({ supported: true });
  });

  it("ThisDevice renders explicit Home Screen guidance and disabled button in an iOS Safari tab", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const origUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    cleanups.push(() => {
      if (origUa) Object.defineProperty(navigator, "userAgent", origUa);
      else delete (navigator as { userAgent?: unknown }).userAgent;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: DEVICE,
        connection: null,
        path: "direct",
        serverId: DEVICE.server.memberId,
        pushPrefs: { load: async () => null, save: async () => undefined },
        onClose: () => undefined,
        onForget: () => undefined,
      }));
      await flush();
    });

    expect(host.querySelector('[data-testid="push-status"]')?.textContent).toContain("Add this app to your Home Screen");
    const btn = host.querySelector('[data-testid="enable-notifications"]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    expect(btn!.textContent).toContain("Home Screen");
  });

  it("never subscribes on load; only subscribes after clicking Enable notifications in ThisDevice, with double-tap guard and secret hygiene", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const vapidKey = makeVapidPub(21);
    expect(decodeApplicationServerKey(vapidKey)).toHaveLength(65);

    const fakeSub = makeFakeSubscription("https://updates.push.services.mozilla.com/wpush/v2/sub-1");
    let registerCalls = 0;
    let permissionCalls = 0;
    let subscribeCalls = 0;
    let resolveSubscribe!: (sub: ReturnType<typeof makeFakeSubscription>) => void;
    const subscribePromise = new Promise<ReturnType<typeof makeFakeSubscription>>((r) => { resolveSubscribe = r; });

    const prefsMap = new Map<string, string>();
    const prefs: PushPrefs = {
      load: async (k) => prefsMap.get(k) ?? null,
      save: async (k, v) => { prefsMap.set(k, v); },
    };

    const sentFrames: Message[] = [];
    const server = new FakeServer();
    const clock = new FakeClock();
    const dial: Dial = (handlers) => {
      const inner = server.dial({
        open: () => handlers.open(),
        frame: (raw) => {
          if (typeof raw === "string") {
            const parsed = JSON.parse(raw) as Message;
            if (parsed.t === "welcome") {
              handlers.frame(JSON.stringify({ ...parsed, vapidPublicKey: vapidKey }));
              return;
            }
          }
          handlers.frame(raw);
        },
        close: (d) => handlers.close(d),
      });
      return {
        send: (frame) => { sentFrames.push(JSON.parse(frame) as Message); inner.send(frame); },
        close: () => inner.close(),
      };
    };

    const link = await FeLink.open({ storage: new MemoryFeStorage(), dial, deviceId: "dev1", feVersion: "3.0.0", local: false, clock });
    links.push(link);
    link.start();
    await flush();

    const registration = {
      scope: "http://127.0.0.1/v3/",
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => { subscribeCalls += 1; return subscribePromise; },
      },
    };
    const origSW = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    const origNotif = Object.getOwnPropertyDescriptor(globalThis, "Notification");
    const origPushMgr = Object.getOwnPropertyDescriptor(globalThis, "PushManager");

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => { registerCalls += 1; return registration; },
        getRegistration: async () => null,
        ready: Promise.resolve(registration),
      },
    });
    let perm: NotificationPermission = "default";
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: Object.assign(function Notification() {}, {
        get permission() { return perm; },
        requestPermission: async () => { permissionCalls += 1; perm = "granted"; return perm; },
      }),
    });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: function PushManager() {} });

    cleanups.push(() => {
      if (origSW) Object.defineProperty(navigator, "serviceWorker", origSW);
      else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      if (origNotif) Object.defineProperty(globalThis, "Notification", origNotif);
      else delete (globalThis as { Notification?: unknown }).Notification;
      if (origPushMgr) Object.defineProperty(globalThis, "PushManager", origPushMgr);
      else delete (globalThis as { PushManager?: unknown }).PushManager;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });

    const conn = { link, port: link, path: "direct", revoked: false, serverId: DEVICE.server.memberId, close: () => link.close() } as unknown as Connection;

    await act(async () => {
      root.render(createElement(ThisDevice, {
        device: DEVICE,
        connection: conn,
        path: "direct",
        serverId: DEVICE.server.memberId,
        pushPrefs: prefs,
        onClose: () => undefined,
        onForget: () => undefined,
      }));
      await flush();
    });

    // Never register SW, request permission, or subscribe on render/load.
    expect(registerCalls).toBe(0);
    expect(permissionCalls).toBe(0);
    expect(subscribeCalls).toBe(0);
    expect(host.textContent).toContain("Home Screen");

    const btn = host.querySelector('[data-testid="enable-notifications"]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);

    // Double-tap while subscribe is pending must only trigger one permission + subscribe flow.
    await act(async () => {
      btn!.click();
      btn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(permissionCalls).toBe(1);
    expect(registerCalls).toBe(1);
    expect(subscribeCalls).toBe(1);

    await act(async () => {
      resolveSubscribe(fakeSub);
      await flush();
    });

    const sentPush = sentFrames.filter((m): m is MessageOf<"push.subscribe"> => m.t === "push.subscribe");
    expect(sentPush).toHaveLength(1);
    expect(sentPush[0].endpoint).toBe(fakeSub.endpoint);
    expect(prefsMap.get("pushEnabled")).toBe("1");
    expect(prefsMap.get("pushVapidKey")).toBe(vapidKey);
    expect(host.querySelector('[data-testid="push-status"]')?.textContent).toContain("Enabled");

    // Secret keys must never appear in rendered UI or extracted diagnostics.
    const subJson = fakeSub.toJSON();
    expect(host.textContent).not.toContain(subJson.keys.p256dh);
    expect(host.textContent).not.toContain(subJson.keys.auth);
    expect(host.textContent).not.toContain(fakeSub.endpoint);
  });

  it("re-subscribes on attach when welcome.vapidPublicKey changes after opting in", async () => {
    const oldKey = makeVapidPub(30);
    const newKey = makeVapidPub(31);
    const oldSub = makeFakeSubscription("https://push.example/old");
    const newSub = makeFakeSubscription("https://push.example/new");
    const subscribedWith: Uint8Array[] = [];
    const sentSubs: Array<{ endpoint: string; keys: { p256dh: string; auth: string } }> = [];
    const prefsMap = new Map<string, string>([["pushEnabled", "1"], ["pushVapidKey", oldKey]]);

    const reg = {
      scope: "https://mac.tailnet.ts.net/v3/",
      pushManager: {
        getSubscription: async () => oldSub,
        subscribe: async (opts: { userVisibleOnly: boolean; applicationServerKey: BufferSource }) => {
          subscribedWith.push(new Uint8Array(opts.applicationServerKey as ArrayBuffer));
          return newSub;
        },
      },
    };

    const result = await syncPushOnAttach({
      vapidPublicKey: newKey,
      sendPushSubscribe: (sub) => { sentSubs.push(sub); return true; },
      prefs: { load: async (k) => prefsMap.get(k) ?? null, save: async (k, v) => { prefsMap.set(k, v); } },
      permission: "granted",
      getRegistration: async () => reg as unknown as ServiceWorkerRegistration,
    });

    expect(result).toBe("resubscribed");
    expect(oldSub.wasUnsubscribed).toBe(true);
    expect(subscribedWith).toHaveLength(1);
    expect(toBase64Url(subscribedWith[0])).toBe(newKey);
    expect(sentSubs).toHaveLength(1);
    expect(sentSubs[0].endpoint).toBe("https://push.example/new");
    expect(prefsMap.get("pushVapidKey")).toBe(newKey);
  });

  it("enablePushNotifications refuses when permission is denied without subscribing", async () => {
    let subscribeCalls = 0;
    const res = await enablePushNotifications({
      vapidPublicKey: makeVapidPub(40),
      sendPushSubscribe: () => true,
      prefs: { load: async () => null, save: async () => undefined },
      requestPermission: async () => "denied",
      registerSw: async () => ({
        scope: "https://mac.tailnet.ts.net/v3/",
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => { subscribeCalls += 1; return makeFakeSubscription() as unknown as PushSubscription; },
        },
      } as unknown as ServiceWorkerRegistration),
    });
    expect(res.ok).toBe(false);
    expect(subscribeCalls).toBe(0);
  });

  it("extractPushSubscription works with getKey or toJSON and rejects malformed subscriptions", () => {
    const sub = makeFakeSubscription();
    const extracted = extractPushSubscription(sub as unknown as PushSubscription);
    expect(extracted?.endpoint).toBe(sub.endpoint);
    expect(extracted?.keys.p256dh).toHaveLength(87);
    expect(extracted?.keys.auth).toHaveLength(22);

    const bad = makeFakeSubscription("http://127.0.0.1/bad");
    expect(extractPushSubscription(bad as unknown as PushSubscription)).toBeNull();
  });
});
