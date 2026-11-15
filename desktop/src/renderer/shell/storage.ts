// Per-device shell storage service (`shell.storage`, M7-05c; protocol v1 §13.2):
//   - Key/value storage per plugin namespace (`get` / `set` / `remove`), surviving plugin unloads and app reloads.
//   - Desktop: persisted as a JSON file in the window's own data folder via preload IPC (`window.botling.shellStorage`).
//   - Web page (`web-v3`): persisted in IndexedDB through `web-v3/shell/device-store.ts`.
//   - Quota: 1 MiB (`SHELL_STORAGE_QUOTA_BYTES`) of JSON-serialized UTF-8 bytes per plugin namespace; refused with a clear error.
//   - Never shared between plugins; never sent to any server.
//   - Storage failures (private browsing, blocked/full IndexedDB, disk errors) log a warning and degrade to memory, never crashing.

export const SHELL_STORAGE = "shell.storage";
export const SHELL_STORAGE_QUOTA_BYTES = 1024 * 1024;
export const SHELL_STORAGE_KEY_MAX = 256;

const NAMESPACE_RE = /^(?:[a-z0-9][a-z0-9._-]{0,213}|:[a-z0-9][a-z0-9._-]{0,62})$/;

export class ShellStorageError extends Error {
  constructor(
    readonly code: "validation" | "quota" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ShellStorageError";
  }
}

export class ShellStorageQuotaError extends ShellStorageError {
  constructor(namespace: string, readonly bytes: number, readonly quotaBytes: number) {
    super("quota", `QuotaExceeded: shell storage for ${JSON.stringify(namespace)} would use ${bytes} bytes (limit ${quotaBytes} bytes).`);
    this.name = "ShellStorageQuotaError";
  }
}

export interface ShellStorageBackend {
  load(namespace: string): Promise<string | null>;
  save(namespace: string, json: string | null): Promise<void>;
}

export interface PluginShellStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type ShellStorageService = ((namespace: string) => PluginShellStorage) & {
  get<T = unknown>(namespace: string, key: string): Promise<T | undefined>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
};

export interface ShellStorageOptions {
  backend?: ShellStorageBackend;
  quotaBytes?: number;
  warn?: (message: string) => void;
}

export interface ShellStorageKernelLike {
  provide(plugin: string, service: string, impl: unknown): unknown;
  call<R = unknown>(caller: string, service: string, ...args: unknown[]): { absent: true } | { absent: false; value: R };
}

/** Validates a plugin namespace before any lookup or persistence (no `.`, `..`, slashes, or control chars). */
export function validateShellStorageNamespace(namespace: unknown): string {
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace) || namespace.includes("..")) {
    throw new ShellStorageError("validation", `Validation: invalid shell storage namespace ${JSON.stringify(typeof namespace === "string" ? cleanLogText(namespace) : String(namespace))}.`);
  }
  return namespace;
}

/** Validates a storage key (non-empty string up to `SHELL_STORAGE_KEY_MAX` characters). */
export function validateShellStorageKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > SHELL_STORAGE_KEY_MAX) {
    throw new ShellStorageError("validation", "Validation: shell storage key must be a non-empty string.");
  }
  return key;
}

function cleanLogText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === undefined) {
    throw new ShellStorageError("validation", "Validation: shell storage value must be JSON-serializable (not undefined).");
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ShellStorageError("validation", "Validation: shell storage value must be JSON-serializable.");
  }
  if (encoded === undefined) {
    throw new ShellStorageError("validation", "Validation: shell storage value must be JSON-serializable.");
  }
  return JSON.parse(encoded);
}

/** Serializes a `Map` without prototype interactions so `"__proto__"`, `"constructor"`, `"toString"` are ordinary keys. */
export function serializeNamespaceMap(entries: ReadonlyMap<string, unknown>): string {
  const object: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return JSON.stringify(object);
}

/** Parses a JSON object string into a `Map`, safely handling prototype property names. */
export function parseNamespaceJson(json: string | null): Map<string, unknown> {
  if (json === null || json === "") return new Map();
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Shell storage namespace is not a JSON object.");
  }
  const map = new Map<string, unknown>();
  for (const key of Object.keys(parsed)) {
    map.set(key, (parsed as Record<string, unknown>)[key]);
  }
  return map;
}

function cloneMap(source: ReadonlyMap<string, unknown>): Map<string, unknown> {
  const next = new Map<string, unknown>();
  for (const [key, value] of source) next.set(key, value);
  return next;
}

function isNonDegradingError(error: unknown): boolean {
  if (error instanceof ShellStorageError) return error.code !== "unavailable";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("QuotaExceeded:") || message.includes("Validation:");
}

function desktopBridgeBackend(): ShellStorageBackend | null {
  const bridge = (globalThis as { botling?: { shellStorage?: ShellStorageBackend } }).botling?.shellStorage;
  if (!bridge || typeof bridge.load !== "function" || typeof bridge.save !== "function") return null;
  return bridge;
}

export function createMemoryShellStorageBackend(): ShellStorageBackend {
  const store = new Map<string, string>();
  return {
    async load(namespace) {
      return store.get(namespace) ?? null;
    },
    async save(namespace, json) {
      if (json === null) store.delete(namespace);
      else store.set(namespace, json);
    },
  };
}

class ShellStorageController {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly memory = new Map<string, Map<string, unknown>>();
  private degraded = false;
  private warned = false;
  private explicitBackend: ShellStorageBackend | null | undefined;
  private readonly quotaBytes: number;
  private readonly warn: (message: string) => void;

  constructor(options: ShellStorageOptions = {}) {
    this.explicitBackend = options.backend;
    this.quotaBytes = options.quotaBytes ?? SHELL_STORAGE_QUOTA_BYTES;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  configure(backend: ShellStorageBackend | null | undefined): void {
    this.explicitBackend = backend;
    this.degraded = false;
    this.warned = false;
    this.memory.clear();
  }

  private resolveBackend(): ShellStorageBackend | null {
    if (this.degraded) return null;
    if (this.explicitBackend !== undefined) return this.explicitBackend;
    return desktopBridgeBackend();
  }

  private degrade(namespace: string, error: unknown): void {
    this.degraded = true;
    if (this.warned) return;
    this.warned = true;
    const reason = cleanLogText(error instanceof Error ? error.message : String(error ?? "storage error"));
    this.warn(`[shell.storage] Persistent storage failed for ${JSON.stringify(namespace)} (${reason}); degrading to memory.`);
  }

  private enqueue<T>(namespace: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(namespace) ?? Promise.resolve();
    const task = previous.then(run, run);
    const tail = task.then(() => undefined, () => undefined);
    this.queues.set(namespace, tail);
    void tail.then(() => {
      if (this.queues.get(namespace) === tail) this.queues.delete(namespace);
    });
    return task;
  }

  private async readNamespace(namespace: string): Promise<Map<string, unknown>> {
    const backend = this.resolveBackend();
    if (!backend) return cloneMap(this.memory.get(namespace) ?? new Map());
    try {
      const raw = await backend.load(namespace);
      const loaded = parseNamespaceJson(raw);
      this.memory.set(namespace, cloneMap(loaded));
      return loaded;
    } catch (error) {
      if (isNonDegradingError(error)) throw error;
      this.degrade(namespace, error);
      return cloneMap(this.memory.get(namespace) ?? new Map());
    }
  }

  private async writeNamespace(namespace: string, entries: Map<string, unknown>): Promise<void> {
    const json = entries.size === 0 ? null : serializeNamespaceMap(entries);
    if (json !== null) {
      const bytes = utf8Bytes(json);
      if (bytes > this.quotaBytes) throw new ShellStorageQuotaError(namespace, bytes, this.quotaBytes);
    }
    const backend = this.resolveBackend();
    if (!backend) {
      if (entries.size === 0) this.memory.delete(namespace);
      else this.memory.set(namespace, cloneMap(entries));
      return;
    }
    try {
      await backend.save(namespace, json);
      if (entries.size === 0) this.memory.delete(namespace);
      else this.memory.set(namespace, cloneMap(entries));
    } catch (error) {
      if (isNonDegradingError(error)) throw error;
      this.degrade(namespace, error);
      if (entries.size === 0) this.memory.delete(namespace);
      else this.memory.set(namespace, cloneMap(entries));
    }
  }

  async get<T = unknown>(namespace: string, key: string): Promise<T | undefined> {
    const ns = validateShellStorageNamespace(namespace);
    const validKey = validateShellStorageKey(key);
    return this.enqueue(ns, async () => {
      const entries = await this.readNamespace(ns);
      return entries.has(validKey) ? (entries.get(validKey) as T) : undefined;
    });
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    const ns = validateShellStorageNamespace(namespace);
    const validKey = validateShellStorageKey(key);
    const normalized = normalizeJsonValue(value);
    return this.enqueue(ns, async () => {
      const entries = await this.readNamespace(ns);
      entries.set(validKey, normalized);
      await this.writeNamespace(ns, entries);
    });
  }

  async remove(namespace: string, key: string): Promise<void> {
    const ns = validateShellStorageNamespace(namespace);
    const validKey = validateShellStorageKey(key);
    return this.enqueue(ns, async () => {
      const entries = await this.readNamespace(ns);
      if (!entries.has(validKey)) return;
      entries.delete(validKey);
      await this.writeNamespace(ns, entries);
    });
  }

  forNamespace(namespace: string): PluginShellStorage {
    const ns = validateShellStorageNamespace(namespace);
    return {
      get: <T = unknown>(key: string) => this.get<T>(ns, key),
      set: (key: string, value: unknown) => this.set(ns, key, value),
      remove: (key: string) => this.remove(ns, key),
    };
  }
}

function toService(controller: ShellStorageController): ShellStorageService {
  const fn = ((namespace: string) => controller.forNamespace(namespace)) as ShellStorageService;
  fn.get = (namespace, key) => controller.get(namespace, key);
  fn.set = (namespace, key, value) => controller.set(namespace, key, value);
  fn.remove = (namespace, key) => controller.remove(namespace, key);
  return fn;
}

export function createShellStorage(options: ShellStorageOptions = {}): ShellStorageService {
  return toService(new ShellStorageController(options));
}

const defaultController = new ShellStorageController();
const defaultService = toService(defaultController);
let activeKernel: ShellStorageKernelLike | null = null;

/** Configures the persistent backend used by the `:shell` kernel's `shell.storage` service (e.g. web-v3 IndexedDB). */
export function configureShellStorage(backend: ShellStorageBackend | null | undefined): () => void {
  defaultController.configure(backend);
  return () => { defaultController.configure(undefined); };
}

/** Registers `shell.storage` on `:shell` inside the renderer kernel loader. */
export function provideShellStorage(kernel: ShellStorageKernelLike, plugin: string): unknown {
  activeKernel = kernel;
  return kernel.provide(plugin, SHELL_STORAGE, defaultService);
}

/** Returns a `PluginShellStorage` handle bound to `plugin` through the renderer kernel's `shell.storage` service. */
export function shellStorage(plugin: string): PluginShellStorage {
  const ns = validateShellStorageNamespace(plugin);
  if (!activeKernel) throw new ShellStorageError("unavailable", 'Service "shell.storage" is not registered.');
  const called = activeKernel.call<PluginShellStorage>(ns, SHELL_STORAGE, ns);
  if (called.absent) throw new ShellStorageError("unavailable", 'Service "shell.storage" is not active.');
  return called.value;
}
