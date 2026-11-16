// The shell's trusted in-page loader (M7-10a; plan-change D56, C14, check 7).
//
// A plugin's web part runs in the page itself only when the FE build shipped it: its name and the hash of its whole folder
// are in `fe-build-manifest.json` (written by the build, desktop/fe-build-manifest.mjs, from the folder
// src/renderer/plugins/*). Any other web part, and a built-in whose folder a bot has edited (its hash no longer matches),
// is refused here and offered to the frame host, which runs it in an opaque-origin sandboxed frame.
//
// Nothing here evaluates text. In-page code is only ever a module the build bundled (`InPageSource`), and the loader
// calls it after the check, so the page's CSP can stay without `unsafe-eval` (web-v3/shell/no-eval.ts stays too).
// Every check fails closed: a manifest that cannot be read or parsed lists nothing, so nothing runs in the page.

export const FE_MANIFEST_FILE = "fe-build-manifest.json";

export interface FeManifestEntry { name: string; codeHash: string }
export interface FeManifest { plugins: readonly FeManifestEntry[] }
export const EMPTY_FE_MANIFEST: FeManifest = { plugins: [] };

/** What an in-page plugin module exports: `activate` registers its contributions and may return its undo. */
export interface InPageModule { activate(api: unknown): void | (() => void) | Promise<void | (() => void)> }
/** The modules the build bundled, by plugin name; undefined for a name the build did not bundle. Never evaluates anything. */
export type InPageSource = (name: string) => Promise<InPageModule | undefined> | InPageModule | undefined;

export type LoadResult =
  | { status: "loaded"; name: string; codeHash: string }
  /** `offered`: the frame host was asked to run it in a frame instead (false when the request itself was malformed). */
  | { status: "refused"; name: string; codeHash: string; reason: "not-in-manifest" | "hash-changed" | "bad-request"; offered: boolean }
  | { status: "failed"; name: string; codeHash: string; message: string };

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;

/** A manifest from parsed JSON. Anything that is not a manifest, and every entry that is malformed, counts as not listed. */
export function parseFeManifest(value: unknown): FeManifest {
  const plugins = (value as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return EMPTY_FE_MANIFEST;
  const entries: FeManifestEntry[] = [];
  for (const row of plugins) {
    const { name, codeHash } = (row ?? {}) as { name?: unknown; codeHash?: unknown };
    if (typeof name === "string" && NAME.test(name) && typeof codeHash === "string" && HASH.test(codeHash)) entries.push({ name, codeHash });
  }
  return { plugins: entries };
}

declare const __FE_MANIFEST__: string | undefined;

/**
 * The manifest this page's bundle was built with (esbuild `define`, fe-manifest-define.mjs): the same bytes as
 * fe-build-manifest.json, so the list and the code cannot be from different builds. Use this in the app: the desktop
 * window's CSP (`connect-src 'none'`) blocks `fetchFeManifest`. Not defined (a test, a build without it) or unreadable: empty.
 */
export function embeddedFeManifest(): FeManifest {
  try {
    return typeof __FE_MANIFEST__ === "string" ? parseFeManifest(JSON.parse(__FE_MANIFEST__)) : EMPTY_FE_MANIFEST;
  } catch {
    return EMPTY_FE_MANIFEST;
  }
}

/**
 * True when this bundle carries a manifest at all: a build said what it ships, even if the list is empty or the text is unreadable (then it
 * lists nothing, and the shell's plugins are refused: fail closed). False in a test or a build without one (the page as it was).
 */
export function feManifestEmbedded(): boolean {
  return typeof __FE_MANIFEST__ === "string";
}

/** Reads fe-build-manifest.json over HTTP (the browser page only: the desktop window's CSP blocks it; prefer `embeddedFeManifest`). Any failure gives the empty manifest. */
export async function fetchFeManifest(url: string = FE_MANIFEST_FILE, fetcher: typeof fetch = fetch): Promise<FeManifest> {
  try {
    const response = await fetcher(url, { cache: "no-store" });
    return response.ok ? parseFeManifest(await response.json()) : EMPTY_FE_MANIFEST;
  } catch {
    return EMPTY_FE_MANIFEST;
  }
}

export interface InPageLoaderOptions {
  manifest: FeManifest;
  source: InPageSource;
  /** Hands a refused plugin to the frame host (the place that runs it in a sandboxed frame). */
  offerToFrame: (name: string, codeHash: string) => void;
  /** One clean line per refusal or failure (default: console.warn). */
  log?: (line: string) => void;
  /** What the module's `activate` gets. */
  api?: unknown;
}

/** A name or text from outside as one short quoted line (control characters escaped). */
const quoted = (text: unknown) => JSON.stringify(String(text).slice(0, 120));

export class InPageLoader {
  private readonly listed = new Map<string, Set<string>>();
  private readonly active = new Map<string, { codeHash: string; dispose?: () => void }>();
  private readonly loading = new Map<string, Promise<LoadResult>>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: InPageLoaderOptions) {
    for (const { name, codeHash } of options.manifest.plugins) {
      const hashes = this.listed.get(name) ?? new Set<string>();
      hashes.add(codeHash);
      this.listed.set(name, hashes);
    }
    this.log = options.log ?? ((line) => console.warn(line));
  }

  /** The plugins running in the page now, with the hash each was loaded under. */
  loaded(): { name: string; codeHash: string }[] {
    return [...this.active].map(([name, { codeHash }]) => ({ name, codeHash }));
  }

  /**
   * Runs plugin `name` (whose folder hashes to `codeHash` now) in the page if the manifest lists exactly that pair;
   * otherwise refuses it and offers it to the frame host. Checked on every call, so a changed hash replaces or removes
   * the running copy: the old one is undone first and stays undone when the new one is refused.
   */
  load(name: string, codeHash: string): Promise<LoadResult> {
    const running = this.loading.get(name);
    const next = (running ?? Promise.resolve()).then(() => this.loadNow(name, codeHash));
    const tracked = next.finally(() => { if (this.loading.get(name) === tracked) this.loading.delete(name); });
    this.loading.set(name, tracked);
    return tracked;
  }

  /** Undoes a running plugin (its disposer runs once); true when there was one. */
  unload(name: string): boolean {
    const entry = this.active.get(name);
    if (!entry) return false;
    this.active.delete(name);
    try { entry.dispose?.(); } catch (error) { this.log(`in-page plugin ${quoted(name)} failed to unload: ${quoted((error as Error)?.message)}`); }
    return true;
  }

  private async loadNow(name: string, codeHash: string): Promise<LoadResult> {
    if (typeof name !== "string" || !NAME.test(name) || typeof codeHash !== "string" || !HASH.test(codeHash)) {
      this.log(`in-page loader refused ${quoted(name)}: not a plugin name and hash`);
      return { status: "refused", name: String(name), codeHash: String(codeHash), reason: "bad-request", offered: false };
    }
    this.unload(name);
    const hashes = this.listed.get(name);
    if (!hashes?.has(codeHash)) {
      const reason = hashes ? "hash-changed" : "not-in-manifest";
      this.log(`in-page loader refused ${quoted(name)}: ${reason === "hash-changed" ? "its code is not the code the build shipped" : "not in the build's manifest"}; offered to a frame`);
      let offered = true;
      try { this.options.offerToFrame(name, codeHash); } catch (error) { offered = false; this.log(`the frame host refused ${quoted(name)}: ${quoted((error as Error)?.message)}`); }
      return { status: "refused", name, codeHash, reason, offered };
    }
    try {
      const module = await this.options.source(name);
      if (!module || typeof module.activate !== "function") throw new Error("the build has no module for it");
      const dispose = await module.activate(this.options.api);
      this.active.set(name, { codeHash, dispose: typeof dispose === "function" ? dispose : undefined });
      return { status: "loaded", name, codeHash };
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 200);
      this.log(`in-page plugin ${quoted(name)} failed to load: ${quoted(message)}`);
      return { status: "failed", name, codeHash, message };
    }
  }
}
