// @vitest-environment jsdom
// Per-device shell storage (`shell.storage`, M7-05c):
//   - Registered on `:shell` in the renderer kernel; survives plugin unload/reload.
//   - Strict per-plugin namespace isolation (in-page and through FrameBroker + pluginFrameHost + panelPage).
//   - 1 MiB per-plugin UTF-8 JSON byte quota, refused with a clear error.
//   - Desktop JSON file persistence in the window's own data folder (symlink-safe, IPC-gated) and web-v3 IndexedDB
//     persistence (`botling3-shell-storage` via device-store.ts).
//   - Storage backend failures (private window, IDB/disk errors) log a warning and degrade to memory without crashing.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFrameRequest } from "../../../Web/src/frame-protocol";
import { PROTOCOL_VERSION, type BotView } from "../../src/contract";
import { DesktopShellStorage, SHELL_STORAGE_CHANNEL, SHELL_STORAGE_FILE, installShellStorageIpc, parseShellStorageRequest } from "../../src/main/shell-storage";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { panelPage } from "../../src/renderer/panel-page";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { SHELL_SURFACE, SHELL_STORAGE, rendererKernel } from "../../src/renderer/renderer-kernel";
import {
  SHELL_STORAGE_QUOTA_BYTES,
  ShellStorageError,
  ShellStorageQuotaError,
  configureShellStorage,
  createMemoryShellStorageBackend,
  createShellStorage,
  shellStorage,
  type ShellStorageBackend,
} from "../../src/renderer/shell/storage";
import {
  DEVICE_DB,
  SHELL_STORAGE_DB,
  createWebShellStorageBackend,
  forgetDevice,
  loadShellStorageNamespace,
  saveShellStorageNamespace,
} from "../../web-v3/shell/device-store";
import { until } from "../helpers";

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "botling-shell-storage-"));
  dirs.push(dir);
  return dir;
}

function makeFrame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: any[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  return { element, posted };
}

function sendFromFrame(frame: HTMLIFrameElement, data: unknown, origin = "null") {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame.contentWindow as MessageEventSource }));
}

function memoryIdb(options: { failOpen?: Error; failWrite?: Error } = {}): IDBFactory {
  const databases = new Map<string, { version: number; stores: Map<string, Map<IDBValidKey, unknown>> }>();
  const fire = (fn: ((ev: Event) => void) | null | undefined) => { if (fn) setTimeout(() => fn(new Event("idb")), 0); };
  const makeReq = <T>(run: (req: any) => void) => {
    const req: any = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    setTimeout(() => run(req), 0);
    return req;
  };
  return {
    open(name: string, version = 1) {
      return makeReq<IDBDatabase>((req) => {
        if (options.failOpen) {
          req.error = options.failOpen;
          fire(req.onerror);
          return;
        }
        let entry = databases.get(name);
        const upgraded = !entry || entry.version < version;
        if (!entry) { entry = { version, stores: new Map() }; databases.set(name, entry); }
        entry.version = Math.max(entry.version, version);
        const dbData = entry;
        const db = {
          get objectStoreNames() { return { contains: (n: string) => dbData.stores.has(n) } as DOMStringList; },
          onversionchange: null,
          close() {},
          createObjectStore(storeName: string) {
            if (!dbData.stores.has(storeName)) dbData.stores.set(storeName, new Map());
            return {} as IDBObjectStore;
          },
          transaction(storeName: string | string[]) {
            const target = Array.isArray(storeName) ? storeName[0]! : storeName;
            let pending = 0;
            let failed = false;
            const doneOne = () => {
              pending -= 1;
              if (pending === 0 && !failed) fire(tx.oncomplete);
            };
            const tx: any = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                const map = dbData.stores.get(target)!;
                return {
                  get(k: IDBValidKey) {
                    pending += 1;
                    return makeReq((r) => { r.result = map.get(k); fire(r.onsuccess); doneOne(); });
                  },
                  put(v: unknown, k: IDBValidKey) {
                    pending += 1;
                    return makeReq((r) => {
                      if (options.failWrite) {
                        failed = true;
                        tx.error = options.failWrite;
                        r.error = options.failWrite;
                        fire(r.onerror);
                        fire(tx.onerror);
                        return;
                      }
                      map.set(k, v);
                      fire(r.onsuccess);
                      doneOne();
                    });
                  },
                  delete(k: IDBValidKey) {
                    pending += 1;
                    return makeReq((r) => { map.delete(k); fire(r.onsuccess); doneOne(); });
                  },
                };
              },
            };
            return tx;
          },
        } as unknown as IDBDatabase;
        req.result = db;
        if (upgraded) req.onupgradeneeded?.({ target: req } as unknown as IDBVersionChangeEvent);
        fire(req.onsuccess);
      });
    },
    deleteDatabase(name: string) {
      return makeReq((req) => { databases.delete(name); fire(req.onsuccess); });
    },
  } as unknown as IDBFactory;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { botling?: unknown }).botling;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("shell.storage kernel service", () => {
  it("is provided by `:shell` and persists plugin values across unload/reload without talking to any server", async () => {
    cleanups.push(configureShellStorage(createMemoryShellStorageBackend()));
    expect(rendererKernel.providerOf(SHELL_STORAGE)).toBe(SHELL_SURFACE);
    expect(() => rendererKernel.install({ name: "dup.shell.storage", provides: { services: [SHELL_STORAGE] } })).toThrow();

    const post = vi.fn();
    const client = new Client({ protocol: PROTOCOL_VERSION, subscribe: () => () => {}, post });
    expect(client).toBeTruthy();

    rendererKernel.install({ name: "plugin.alpha", requires: { services: [SHELL_STORAGE] } });
    cleanups.push(async () => {
      if (rendererKernel.state("plugin.alpha") !== "absent") await rendererKernel.requestUnload("plugin.alpha");
      rendererKernel.uninstall("plugin.alpha");
    });

    expect(await rendererKernel.load("plugin.alpha", async () => {
      await shellStorage("plugin.alpha").set("layout", { folded: true, pinned: ["b1"] });
    })).toEqual({ status: "active" });

    // Unload plugin.alpha completely, then reload it: the persisted value survives.
    await rendererKernel.requestUnload("plugin.alpha");
    expect(rendererKernel.state("plugin.alpha")).toBe("absent");

    let restored: unknown;
    expect(await rendererKernel.load("plugin.alpha", async () => {
      restored = await shellStorage("plugin.alpha").get("layout");
    })).toEqual({ status: "active" });
    expect(restored).toEqual({ folded: true, pinned: ["b1"] });
    expect(post).not.toHaveBeenCalled();

    // If `:shell` itself unloads, dependent plugins unload too and shellStorage fails closed; reloading `:shell` restores it.
    await rendererKernel.requestUnload(SHELL_SURFACE);
    expect(rendererKernel.providerOf(SHELL_STORAGE)).toBeNull();
    expect(() => shellStorage("plugin.alpha")).toThrow(ShellStorageError);
    await rendererKernel.load(SHELL_SURFACE);
    expect(rendererKernel.providerOf(SHELL_STORAGE)).toBe(SHELL_SURFACE);
    await expect(shellStorage("plugin.alpha").get("layout")).resolves.toEqual({ folded: true, pinned: ["b1"] });
  });

  it("isolates plugin namespaces and handles prototype keys and JSON edge values safely", async () => {
    const storage = createShellStorage({ backend: createMemoryShellStorageBackend() });
    const a = storage("plugin.a");
    const b = storage("plugin.b");

    await a.set("secret", "alpha-only");
    await a.set("plugin.b:secret", "colliding-name-attempt");
    await a.set("__proto__", { polluted: false });
    await a.set("constructor", "safe-ctor");
    await a.set("toString", 42);
    await a.set("explicitNull", null);
    await a.set("zero", 0);
    await a.set("falsy", false);

    // Plugin B cannot read, overwrite, or remove Plugin A's keys.
    expect(await b.get("secret")).toBeUndefined();
    expect(await b.get("__proto__")).toBeUndefined();
    await b.set("secret", "beta-value");
    await b.remove("explicitNull");
    expect(await a.get("secret")).toBe("alpha-only");
    expect(await b.get("secret")).toBe("beta-value");
    expect(await a.get("plugin.b:secret")).toBe("colliding-name-attempt");
    expect(await a.get("__proto__")).toEqual({ polluted: false });
    expect(await a.get("constructor")).toBe("safe-ctor");
    expect(await a.get("toString")).toBe(42);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(await a.get("explicitNull")).toBeNull();
    expect(await a.get("missing")).toBeUndefined();
    expect(await a.get("zero")).toBe(0);
    expect(await a.get("falsy")).toBe(false);

    await a.remove("secret");
    expect(await a.get("secret")).toBeUndefined();

    // Invalid namespaces, keys, and non-JSON values fail closed.
    expect(() => storage(".")).toThrow(ShellStorageError);
    expect(() => storage("..")).toThrow(ShellStorageError);
    expect(() => storage("a..b")).toThrow(ShellStorageError);
    expect(() => storage("../plugin.b")).toThrow(ShellStorageError);
    await expect(a.get("")).rejects.toThrow(ShellStorageError);
    await expect(a.get("k".repeat(257))).rejects.toThrow(ShellStorageError);
    await expect(a.set("bad", undefined)).rejects.toThrow(ShellStorageError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(a.set("circ", circular)).rejects.toThrow(ShellStorageError);
  });

  it("isolates frames through FrameBroker and exposes ccb.storage in panelPage", async () => {
    cleanups.push(configureShellStorage(createMemoryShellStorageBackend()));
    const broker = new FrameBroker(window, { name: "shell storage broker" });
    cleanups.push(() => broker.dispose());

    const client = { request: vi.fn(), onEvent: () => () => {} } as unknown as Client;
    const host = pluginFrameHost({ client, components: () => ({}), bots: () => [] as BotView[], ask: (_v, _a, done) => done(false) });

    const frameA = makeFrame();
    const frameB = makeFrame();
    registerPluginFrame(broker, host, { frame: frameA.element, plugin: "plugin.a" });
    registerPluginFrame(broker, host, { frame: frameB.element, plugin: "plugin.b" });

    sendFromFrame(frameA.element, { ccb: "storage", id: 1, op: "set", key: "state", value: { count: 7 } });
    await until(() => frameA.posted.length === 1);
    expect(frameA.posted[0]).toEqual({ ccb: "reply", id: 1, ok: true, value: undefined });

    sendFromFrame(frameA.element, { ccb: "storage", id: 2, op: "get", key: "state" });
    await until(() => frameA.posted.length === 2);
    expect(frameA.posted[1]).toEqual({ ccb: "reply", id: 2, ok: true, value: { count: 7 } });

    // Frame B cannot read Frame A's key.
    sendFromFrame(frameB.element, { ccb: "storage", id: 10, op: "get", key: "state" });
    await until(() => frameB.posted.length === 1);
    expect(frameB.posted[0]).toEqual({ ccb: "reply", id: 10, ok: true, value: undefined });

    // Frame B trying to name Frame A in the message is refused by the broker.
    sendFromFrame(frameB.element, { ccb: "storage", id: 11, op: "get", key: "state", plugin: "plugin.a" });
    sendFromFrame(frameB.element, { ccb: "storage", id: 12, op: "get", key: "state", namespace: "plugin.a" });
    expect(broker.refusals).toHaveLength(2);
    expect(frameB.posted).toHaveLength(1);

    // Frame A can remove its own key; Frame B removing "state" does not affect Frame A before removal.
    sendFromFrame(frameA.element, { ccb: "storage", id: 3, op: "remove", key: "state" });
    sendFromFrame(frameA.element, { ccb: "storage", id: 4, op: "get", key: "state" });
    await until(() => frameA.posted.length === 4);
    expect(frameA.posted[2]).toEqual({ ccb: "reply", id: 3, ok: true, value: undefined });
    expect(frameA.posted[3]).toEqual({ ccb: "reply", id: 4, ok: true, value: undefined });

    // A refusal thrown at once (a plugin name that is no namespace) is still answered, never left hanging.
    const odd = makeFrame();
    registerPluginFrame(broker, host, { frame: odd.element, plugin: "plugin..odd" });
    sendFromFrame(odd.element, { ccb: "storage", id: 30, op: "get", key: "state" });
    await until(() => odd.posted.length === 1);
    expect(odd.posted[0]).toMatchObject({ ccb: "reply", id: 30, ok: false });
    expect(String(odd.posted[0].value)).toMatch(/invalid shell storage namespace/);

    // A broker host without storage fails closed.
    const minimal = makeFrame();
    registerPluginFrame(broker, { call: async () => null, command: async () => null }, { frame: minimal.element, plugin: "plugin.c" });
    sendFromFrame(minimal.element, { ccb: "storage", id: 20, op: "get", key: "x" });
    await until(() => minimal.posted.length === 1);
    expect(minimal.posted[0]).toEqual({ ccb: "reply", id: 20, ok: false, value: "This page does not answer ccb.storage." });

    // parseFrameRequest accepts valid storage requests and rejects malformed or scope-spoofing ones.
    expect(parseFrameRequest({ ccb: "storage", id: 1, op: "get", key: "layout" })).toEqual({ ccb: "storage", id: 1, op: "get", key: "layout" });
    expect(parseFrameRequest({ ccb: "storage", id: 2, op: "set", key: "layout", value: { ok: true } })).toEqual({ ccb: "storage", id: 2, op: "set", key: "layout", value: { ok: true } });
    expect(parseFrameRequest({ ccb: "storage", id: 3, op: "remove", key: "layout" })).toEqual({ ccb: "storage", id: 3, op: "remove", key: "layout" });
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "get", key: "" })).toBeNull();
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "get", key: "k".repeat(257) })).toBeNull();
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "get", key: "k", value: 1 })).toBeNull();
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "remove", key: "k", value: null })).toBeNull();
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "set", key: "k" })).toBeNull();
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "clear", key: "k" })).toBeNull();
    expect(parseFrameRequest({ ccb: "storage", id: 4, op: "get", key: "k", plugin: "other" })).toBeNull();

    // panelPage exposes ccb.storage RPC.
    const html = panelPage("plugin.a", "panel", "export function activate() {}", {});
    expect(html).toContain('ccb: "storage"');
  });

  it("enforces the 1 MiB per-plugin UTF-8 JSON byte quota with a clear error and preserves existing data", async () => {
    const backend = createMemoryShellStorageBackend();
    const storage = createShellStorage({ backend });
    const a = storage("plugin.a");
    const b = storage("plugin.b");

    await a.set("keep", "still-here");

    // Multi-byte CJK characters: < 500k JS chars, but > 1 MiB in UTF-8 JSON bytes!
    const cjkTooBig = "\u4e2d".repeat(400_000);
    expect(cjkTooBig.length).toBeLessThan(SHELL_STORAGE_QUOTA_BYTES);
    await expect(a.set("cjk", cjkTooBig)).rejects.toThrow(ShellStorageQuotaError);
    await expect(a.set("cjk", cjkTooBig)).rejects.toThrow(/QuotaExceeded/);

    // Escaped newlines count as 2 bytes each in JSON.
    const newlinesTooBig = "\n".repeat(600_000);
    await expect(a.set("nl", newlinesTooBig)).rejects.toThrow(ShellStorageQuotaError);

    // Existing key was not corrupted or evicted.
    expect(await a.get("keep")).toBe("still-here");

    // Largest legal write under 1 MiB succeeds, cumulative overflow refuses, remove frees quota.
    const almostFull = "a".repeat(SHELL_STORAGE_QUOTA_BYTES - 100);
    await a.set("big", almostFull);
    expect(await a.get("big")).toBe(almostFull);
    await expect(a.set("extra", "x".repeat(200))).rejects.toThrow(ShellStorageQuotaError);

    // Plugin B has its own independent 1 MiB quota.
    await b.set("big", almostFull);
    expect(await b.get("big")).toBe(almostFull);

    // Removing frees space for Plugin A.
    await a.remove("big");
    await a.set("extra", "x".repeat(200));
    expect(await a.get("extra")).toBe("x".repeat(200));
  });

  it("persists to <dataDir>/shell-storage.json on desktop, checks IPC & symlinks, and bridges via window.botling", async () => {
    const dataDir = tempDir();
    const handlers = new Map<string, (event: any, raw: unknown) => unknown>();
    const ipc = { handle: (channel: string, fn: (event: any, raw: unknown) => unknown) => { handlers.set(channel, fn); } };
    const fromAppFrame = vi.fn((event: { sender: { id: number }; senderFrame: { url: string } }) => event.sender.id === 1 && event.senderFrame.url === "app://botling/index.html");

    const disk = installShellStorageIpc(ipc as any, dataDir, fromAppFrame as any);
    expect(disk.file).toBe(join(dataDir, SHELL_STORAGE_FILE));

    // Untrusted frame and malformed requests are rejected.
    const handle = handlers.get(SHELL_STORAGE_CHANNEL)!;
    expect(() => handle({ sender: { id: 99 }, senderFrame: { url: "https://evil.example" } }, { op: "load", namespace: "plugin.a" }))
      .toThrow(/untrusted frame/);
    expect(() => handle({ sender: { id: 1 }, senderFrame: { url: "app://botling/index.html" } }, { op: "load", namespace: "../bad" }))
      .toThrow(/malformed/);
    expect(parseShellStorageRequest({ op: "save", namespace: "plugin.a", json: "{}", extra: 1 })).toBeNull();

    // Wire window.botling.shellStorage to the IPC handler and verify round-trip persistence.
    (globalThis as { botling?: unknown }).botling = {
      shellStorage: {
        load: async (namespace: string) => handle({ sender: { id: 1 }, senderFrame: { url: "app://botling/index.html" } }, { op: "load", namespace }),
        save: async (namespace: string, json: string | null) => handle({ sender: { id: 1 }, senderFrame: { url: "app://botling/index.html" } }, { op: "save", namespace, json }),
      },
    };
    cleanups.push(configureShellStorage(undefined)); // auto-detect window.botling.shellStorage

    if (rendererKernel.state(SHELL_SURFACE) === "absent") await rendererKernel.load(SHELL_SURFACE);
    await shellStorage("plugin.desk").set("panel", { width: 320 });
    expect(JSON.parse(readFileSync(join(dataDir, SHELL_STORAGE_FILE), "utf8"))).toEqual({
      "plugin.desk": { panel: { width: 320 } },
    });

    // Fresh instance reads from disk (survives window restart).
    const second = createShellStorage();
    expect(await second("plugin.desk").get("panel")).toEqual({ width: 320 });

    // Main-process storage enforces quota independently.
    expect(() => new DesktopShellStorage(dataDir).save("plugin.desk", JSON.stringify({ x: "a".repeat(SHELL_STORAGE_QUOTA_BYTES) })))
      .toThrow(/QuotaExceeded/);

    // Symlink-safe (L-002): symlink at shell-storage.json is refused without reading/following target.
    const secretFile = join(dataDir, "secret.txt");
    writeFileSync(secretFile, JSON.stringify({ "plugin.desk": { secret: "nope" } }));
    rmSync(disk.file);
    symlinkSync(secretFile, disk.file);
    expect(() => disk.load("plugin.desk")).toThrow(/not a regular file/);
    expect(() => disk.save("plugin.desk", JSON.stringify({ a: 1 }))).toThrow(/not a regular file/);
  });

  it("persists to IndexedDB (`botling3-shell-storage`) via device-store.ts and clears on forgetDevice", async () => {
    expect(SHELL_STORAGE_DB).toBe("botling3-shell-storage");
    const idb = memoryIdb();
    const backend = createWebShellStorageBackend(idb);
    const first = createShellStorage({ backend });
    await first("plugin.web").set("rail", { collapsed: true });
    await first("plugin.other").set("theme", "dark");

    // Survives reload (new createShellStorage reading the same IndexedDB).
    const second = createShellStorage({ backend: createWebShellStorageBackend(idb) });
    expect(await second("plugin.web").get("rail")).toEqual({ collapsed: true });
    expect(await second("plugin.other").get("theme")).toBe("dark");
    expect(await loadShellStorageNamespace("plugin.web", idb)).toBe('{"rail":{"collapsed":true}}');

    // Removing all keys cleans the namespace record.
    await second("plugin.web").remove("rail");
    expect(await loadShellStorageNamespace("plugin.web", idb)).toBeNull();

    // forgetDevice wipes both DEVICE_DB and SHELL_STORAGE_DB.
    await saveShellStorageNamespace("plugin.other", '{"theme":"dark"}', idb);
    await forgetDevice([DEVICE_DB], idb);
    expect(await loadShellStorageNamespace("plugin.other", idb)).toBeNull();
  });

  it("degrades to memory with a logged warning (no crash, no value leak) on private-window or backend quota failures", async () => {
    const warnings: string[] = [];
    // Case 1: private browsing / IndexedDB unavailable or SecurityError.
    const privateStorage = createShellStorage({
      backend: createWebShellStorageBackend(memoryIdb({ failOpen: new DOMException("The operation is insecure.", "SecurityError") })),
      warn: (msg) => warnings.push(msg),
    });
    await privateStorage("plugin.priv").set("secretKey", "super-secret-value");
    expect(await privateStorage("plugin.priv").get("secretKey")).toBe("super-secret-value");
    await privateStorage("plugin.priv").remove("secretKey");
    expect(await privateStorage("plugin.priv").get("secretKey")).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("degrading to memory");
    expect(warnings[0]).not.toContain("super-secret-value");

    // Case 2: IndexedDB write throws browser QuotaExceededError for a legal (< 1 MiB) write.
    const quotaWarnings: string[] = [];
    const quotaStorage = createShellStorage({
      backend: createWebShellStorageBackend(memoryIdb({ failWrite: new DOMException("Storage quota full", "QuotaExceededError") })),
      warn: (msg) => quotaWarnings.push(msg),
    });
    await quotaStorage("plugin.q").set("k1", "value-kept-in-memory");
    expect(await quotaStorage("plugin.q").get("k1")).toBe("value-kept-in-memory");
    expect(quotaWarnings).toHaveLength(1);
    expect(quotaWarnings[0]).toContain("Storage quota full");
    expect(quotaWarnings[0]).not.toContain("value-kept-in-memory");

    // Case 3: Desktop backend throws disk error.
    const diskWarnings: string[] = [];
    const failingDisk: ShellStorageBackend = {
      async load() { throw new Error("EACCES: permission denied"); },
      async save() { throw new Error("ENOSPC: no space left on device"); },
    };
    const diskStorage = createShellStorage({ backend: failingDisk, warn: (msg) => diskWarnings.push(msg) });
    await diskStorage("plugin.disk").set("draft", "kept-in-ram");
    expect(await diskStorage("plugin.disk").get("draft")).toBe("kept-in-ram");
    expect(diskWarnings).toHaveLength(1);
    expect(diskWarnings[0]).toContain("degrading to memory");
  });
});
