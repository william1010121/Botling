// The left column's per-device layout (M7-05a): whether the column is folded, the bots pinned to its top and the bots sent to Idle.
// Plugin-kernel design §13.2: state that is not server data lives in the shell's per-device storage (`shell.storage`, M7-05c), under
// the plugin's own namespace, never only in a page's memory or a `settings` key. Today the page keeps these three in settings.json
// (`railCollapsed`, `pinnedBots`, `idleBots`); the sidebar plugin (plugins/sidebar/index.ts) attaches its storage handle here while it is
// loaded, and from then on:
//   - the layout is read from the storage; the first time (nothing stored yet) the old settings keys are read and copied into it, once.
//     The old keys are never deleted or rewritten by the migration (a later card removes them);
//   - a change made in the column is written to the storage and also to the old key, because the core still reads them (a message to
//     an idle bot takes it out of Idle, core/server/send.ts; the waiting list orders by pinnedBots; the phone page's snapshot);
//   - a change that arrives in the old key from someone else (that same send, another window) is taken over into the storage; a value this
//     store wrote itself coming back is not a change. The storage also keeps the old keys as this store last took them in (`seen`, inside
//     the stored value), so a change made while no store was watching (the window was closed, the sidebar was unloaded) is told from the
//     stored layout at the next start and taken over then too. A layout stored without that record (an older run) is trusted as it is;
//   - when no plugin is attached (a page without the shell, the sidebar unloaded or refused, the storage unreadable) the old keys are the
//     layout, as they were before. A page of Botling Web keeps them too: its layout is the bridge's (phone layout), not this store's.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { LAYOUT_STORAGE_KEY } from "./sidebar-names";

export interface RailLayout { railCollapsed: boolean; pinnedBots: string[]; idleBots: string[] }
export type LayoutKey = keyof RailLayout;
export const LAYOUT_KEYS: readonly LayoutKey[] = ["railCollapsed", "pinnedBots", "idleBots"];
/** The most bots a list holds (the settings contract's own limit). */
export const LAYOUT_LIST_MAX = 200;
const ID_MAX = 100;

/** What the store needs of a plugin's shell storage handle (`shellStorage(plugin)`, shell/storage.ts). */
export interface LayoutStorage { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
type Storage = LayoutStorage;
/** Writes one key to where the core reads it (`settings.set`). */
export type Mirror = (key: LayoutKey, value: RailLayout[LayoutKey]) => void;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > LAYOUT_LIST_MAX) return null;
  if (!value.every((id) => typeof id === "string" && id.length > 0 && id.length <= ID_MAX)) return null;
  return [...new Set<string>(value)];
}

/** What the storage held, if it is a layout: an object with exactly the right kinds of values. Anything else is not a layout (null). */
export function readLayout(value: unknown): RailLayout | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!LAYOUT_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  const record = value as Record<string, unknown>;
  const pinnedBots = idList(record.pinnedBots);
  const idleBots = idList(record.idleBots);
  if (typeof record.railCollapsed !== "boolean" || !pinnedBots || !idleBots) return null;
  return { railCollapsed: record.railCollapsed, pinnedBots, idleBots };
}

/** The layout the old settings keys hold (what the page used before): a missing or wrong key is the default. */
export function layoutOfSettings(settings: Partial<Record<LayoutKey, unknown>> | null | undefined): RailLayout {
  return { railCollapsed: settings?.railCollapsed === true, pinnedBots: idList(settings?.pinnedBots) ?? [], idleBots: idList(settings?.idleBots) ?? [] };
}

/** The old keys as the store last took them in, which the storage keeps beside the layout (`seen` in the stored value); null when absent. */
export function readSeen(value: unknown): RailLayout | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "seen")) return null;
  return readLayout((value as { seen: unknown }).seen);
}

export class RailLayoutStore {
  private storage: Storage | null = null;
  private layout: RailLayout | null = null;
  /** What the storage held: undefined until it answered, null when it held no layout. */
  private stored: RailLayout | null | undefined;
  /** The `seen` record that came with the stored layout (null: none). */
  private storedSeen: RailLayout | null = null;
  private failed = false;
  /** The old keys as the page has them now, and as this store last took them in. */
  private legacy: RailLayout | null = null;
  private seen: RailLayout | null = null;
  /** The values this store wrote to an old key that have not come back yet (JSON), in the order written. */
  private readonly mine = new Map<LayoutKey, string[]>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private warned = false;

  constructor(private readonly warn: (message: string) => void = (message) => console.warn(message)) {}

  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly version = (): number => this.counter;
  private notify(): void { this.counter += 1; for (const listener of [...this.listeners]) listener(); }

  /** The layout while a storage is attached and has answered (null: use the old keys). */
  current(): RailLayout | null { return this.layout; }

  /** The sidebar plugin loaded: read what the storage holds, then settle against the old keys. */
  attach(storage: Storage): void {
    this.reset();
    this.storage = storage;
    storage.get(LAYOUT_STORAGE_KEY).then((value) => {
      if (this.storage !== storage) return;
      this.stored = readLayout(value);
      this.storedSeen = this.stored ? readSeen(value) : null;
      this.settle();
    }, (error: unknown) => {
      if (this.storage !== storage) return;
      this.failed = true;
      this.problem("read", error);
    });
  }

  /** The plugin unloaded (`storage`: only if that handle is still the attached one). The old keys are the layout again. */
  detach(storage?: Storage): void {
    if (storage && this.storage !== storage) return;
    const had = this.layout !== null;
    this.reset();
    if (had) this.notify();
  }

  /** The old keys as the page has them now (every render that changed them). The first call after the storage answered decides the migration. */
  observe(legacy: RailLayout): void {
    this.legacy = legacy;
    if (!this.layout) { this.settle(); return; }
    if (this.reconcile(legacy)) { this.persist(); this.notify(); }
  }

  /**
   * Takes in what the old keys hold that this store has not seen yet: a key that differs from `seen` is a change, unless it is this store's
   * own write coming back. True when the layout or `seen` changed (the caller stores and redraws).
   */
  private reconcile(legacy: RailLayout): boolean {
    const base = this.seen ?? legacy;
    let seen = base;
    let layout = this.layout!;
    for (const key of LAYOUT_KEYS) {
      if (same(legacy[key], base[key])) continue;
      seen = { ...seen, [key]: legacy[key] };
      // Our own write coming back is not a change; everything we wrote before it has come back too.
      const written = this.mine.get(key) ?? [];
      const at = written.indexOf(JSON.stringify(legacy[key]));
      if (at >= 0) {
        written.splice(0, at + 1);
        // Once all our writes are back the old key has the last word (a foreign write may have landed between ours and their echo).
        if (written.length === 0 && !same(legacy[key], layout[key])) layout = { ...layout, [key]: legacy[key] };
        continue;
      }
      if (!same(legacy[key], layout[key])) layout = { ...layout, [key]: legacy[key] };
    }
    const moved = seen !== base || layout !== this.layout;
    this.seen = seen;
    this.layout = layout;
    return moved;
  }

  /**
   * Applies `patch` to the layout, stores it and passes each changed key to `mirror` (the old key). False when no storage is attached
   * (nothing was done: the caller writes the old keys alone).
   */
  change(patch: Partial<RailLayout>, mirror: Mirror): boolean {
    if (!this.layout || !this.storage) return false;
    const next: RailLayout = { ...this.layout, ...patch };
    for (const key of LAYOUT_KEYS) {
      if (!(key in patch) || same(next[key], this.layout[key])) continue;
      const written = this.mine.get(key) ?? [];
      written.push(JSON.stringify(next[key]));
      this.mine.set(key, written.slice(-8));
      mirror(key, next[key]);
    }
    this.layout = next;
    this.persist();
    this.notify();
    return true;
  }

  private reset(): void {
    this.storage = null; this.layout = null; this.stored = undefined; this.storedSeen = null; this.failed = false; this.seen = null; this.mine.clear(); this.warned = false;
  }

  /**
   * The storage has answered and the page has handed its old keys: the stored layout wins, except for what the old keys changed since this
   * store last took them in (`seen`, stored beside the layout); with none stored the old keys are copied in.
   */
  private settle(): void {
    if (!this.storage || this.layout || this.failed || this.stored === undefined || !this.legacy) return;
    if (this.stored) {
      this.layout = this.stored;
      this.seen = this.storedSeen ?? this.legacy;
      if (this.storedSeen && this.reconcile(this.legacy)) this.persist();
    } else {
      this.layout = this.legacy;
      this.seen = this.legacy;
      this.persist();
    }
    this.notify();
  }

  private persist(): void {
    const { storage, layout, seen } = this;
    if (!storage || !layout) return;
    storage.set(LAYOUT_STORAGE_KEY, seen ? { ...layout, seen } : layout).catch((error: unknown) => this.problem("write", error));
  }

  /** A storage refusal (quota, a bad key) is logged once; the layout stays what it is in memory and in the old keys. */
  private problem(what: string, error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
    this.warn(`[sidebar] the layout could not be ${what === "read" ? "read from" : "written to"} the shell storage (${reason}); the settings keys are used.`);
  }
}

/** The renderer's store (plugins/sidebar attaches its storage; App reads it). */
export const railLayout = new RailLayoutStore();

/**
 * The layout the column draws, how to change it (a patch, or a function of the layout as it is right now) and how to read it right now
 * (for a handler, which may run before the next draw). `settings`: the page's settings (the old keys). `device`: false for a page of
 * Botling Web, whose layout is the bridge's. `write` sends one key to `settings.set`.
 */
export function useRailLayout(settings: Partial<Record<LayoutKey, unknown>> | null | undefined, device: boolean, write: Mirror): {
  layout: RailLayout; read: () => RailLayout; change: (patch: Partial<RailLayout> | ((now: RailLayout) => Partial<RailLayout>)) => void;
} {
  useSyncExternalStore(railLayout.subscribe, railLayout.version, railLayout.version);
  const sign = settings ? JSON.stringify(layoutOfSettings(settings)) : null;
  const legacy = useMemo(() => layoutOfSettings(settings), [sign]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (device && sign !== null) railLayout.observe(legacy); }, [device, sign, legacy]);
  const layout = (device ? railLayout.current() : null) ?? legacy;
  const writer = useRef(write);
  writer.current = write;
  const drawn = useRef(legacy);
  drawn.current = legacy;
  const read = useCallback((): RailLayout => (device ? railLayout.current() : null) ?? drawn.current, [device]);
  const change = useCallback((patch: Partial<RailLayout> | ((now: RailLayout) => Partial<RailLayout>)) => {
    const mirror: Mirror = (key, value) => writer.current(key, value);
    const next = typeof patch === "function" ? patch(read()) : patch;
    if (device && railLayout.change(next, mirror)) return;
    for (const key of LAYOUT_KEYS) if (key in next) mirror(key, next[key]!);
  }, [device, read]);
  return { layout, read, change };
}
