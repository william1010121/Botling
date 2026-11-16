// The Plugins page's Explore and Updates (plugins/catalog.ts for the index and the download): what the public catalog
// offers next to what is installed, and installing or updating one of its plugins. An install never happens here: the
// downloaded folder is checked (its hash against the index, the plugin checks, the app version) and handed to the
// install card Maintainer already uses for outside plugins (maintainer.ts `offerInstall`), in the main bot's chat; only
// "Install" there puts it into the library. Exception, the Update button (`direct`): an update of a plugin that is already
// running (installed or built in) is installed at once, no card and no comparison of what it asks for (plugins are open
// source and trusted after the first install). This file never reads or writes a grant.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginStoreEntryView, PluginStoreView } from "../contract";
import { Catalog, catalogSource, HashMismatch, OFFICIAL_INDEX_URL, type CatalogEntry, type CatalogSource, type Fetch } from "./plugins/catalog";
import { compatible, title } from "./plugins/manifest";
import { compareVersions } from "./plugins/versions";
import type { PluginRegistry } from "./plugins/registry";
import { readProposal, type MaintainerDesk } from "./maintainer";

export type StoreStatus = PluginStoreEntryView["status"];

export interface PluginStoreDeps {
  root: string;
  desk: MaintainerDesk;
  registry: () => PluginRegistry | null;
  /** settings.json `pluginIndexURL` now (testing only). */
  indexOverride: () => unknown;
  /** This Botling's version (BOTLING_APP_VERSION); null when unknown (then only engines.ccb is checked). */
  appVersion: string | null;
  fetcher?: Fetch;
  now?: () => number;
  /** The store's view changed (an install moved on, the index came in). */
  changed: (view: PluginStoreView) => void;
  log: (line: string) => void;
}

/** How long a fetched index counts as fresh for the check at startup. */
export const DAY_MS = 24 * 60 * 60 * 1000;

export class PluginStore {
  private catalogFor: { key: string; catalog: Catalog } | null = null;
  private sourceProblem: string | null = null;
  private status = new Map<string, NonNullable<StoreStatus>>();

  constructor(private readonly deps: PluginStoreDeps) {}

  /** The catalog for the source settings name now (a new one when the setting changed). */
  private get catalog(): Catalog {
    const override = this.deps.indexOverride();
    const key = typeof override === "string" ? override.trim() : "";
    if (this.catalogFor?.key !== key) {
      let source: CatalogSource;
      try {
        source = catalogSource(override);
        this.sourceProblem = null;
      } catch (error) {
        source = catalogSource(null);
        this.sourceProblem = `${(error as Error).message} Using the official catalog.`;
      }
      this.catalogFor = { key, catalog: new Catalog(source, join(this.deps.root, "plugin-index.json"), this.deps.fetcher, this.deps.now) };
    }
    return this.catalogFor.catalog;
  }

  /** At startup: fetch the index when the last copy is older than a day (only the real app does this; tests never). */
  startup() {
    if (this.catalog.fresh(DAY_MS)) return;
    void this.refresh().catch((error) => this.deps.log(`plugin catalog: ${(error as Error).message}`));
  }

  /** Fetches index.json again; the view says how it went (an error with the cached entries, offline). */
  async refresh(): Promise<PluginStoreView> {
    const pending = this.catalog.refresh();
    this.deps.changed(this.view());
    await pending;
    const view = this.view();
    this.deps.changed(view);
    return view;
  }

  private announce() { this.deps.changed(this.view()); }

  private setStatus(name: string, status: StoreStatus) {
    if (status) this.status.set(name, status);
    else this.status.delete(name);
    this.announce();
  }

  /** What one entry is to this Botling: installable, installed, an update, built in, the library's own copy, too new for it… */
  stateOf(entry: CatalogEntry): { state: PluginStoreEntryView["state"]; installedVersion: string | null } {
    const plugin = this.deps.registry()?.plugin(entry.name);
    const installedVersion = plugin?.manifest.version ?? null;
    if (!entry.commit) return { state: "unreleased", installedVersion };
    // The library's own copy (Maintainer built it, or a developer keeps one there): never replaced from outside.
    if (plugin && !plugin.builtIn && !plugin.installedFrom) return { state: "devCopy", installedVersion };
    const newer = plugin ? (compareVersions(entry.version, plugin.manifest.version) ?? 0) > 0 : true;
    if (plugin && !newer) return { state: plugin.builtIn ? "builtIn" : "installed", installedVersion };
    if (this.tooOld(entry)) return { state: "tooOld", installedVersion };
    return { state: plugin ? "update" : "available", installedVersion };
  }

  /** Why this Botling can't run `entry` (its minimum app version or its engines.ccb range), or null. */
  tooOld(entry: CatalogEntry): string | null {
    const app = this.deps.appVersion;
    if (entry.minAppVersion && app && (compareVersions(app, entry.minAppVersion) ?? 0) < 0) return `"${entry.displayName}" needs Botling ${entry.minAppVersion} or newer; this is ${app}.`;
    if (entry.engines && !compatible(entry.engines)) return `"${entry.displayName}" needs a newer Botling (its engines.ccb is "${entry.engines}").`;
    return null;
  }

  view(): PluginStoreView {
    const catalog = this.catalog;
    const state = catalog.current;
    const entries = state.entries.slice(0, 500).map((entry): PluginStoreEntryView => {
      const { state: kind, installedVersion } = this.stateOf(entry);
      return {
        name: entry.name, title: entry.displayName, description: entry.description, version: entry.version, license: entry.license,
        permissions: entry.permissions, parts: entry.parts, minAppVersion: entry.minAppVersion, size: entry.size, files: entry.files,
        commit: entry.commit, page: entry.commit ? catalog.source.folderPage(entry.commit, entry.path).slice(0, 2_000) : null,
        state: kind, installedVersion, status: this.status.get(entry.name) ?? null,
      };
    });
    return {
      url: state.url.slice(0, 2_000), official: state.official && state.url === OFFICIAL_INDEX_URL, fetchedAt: state.fetchedAt, fromCache: state.fromCache,
      error: (this.sourceProblem ?? state.error)?.slice(0, 2_000) ?? null, offline: state.offline, loading: catalog.busy, appVersion: this.deps.appVersion,
      entries, updates: entries.filter((entry) => entry.state === "update").length,
    };
  }

  /**
   * Install (or update) `name` from the index: download its folder at the recorded commit, check it, and ask on the
   * install card. Returns once the card is up (or why not, in the entry's status); the answer comes later.
   * `direct` (the Update button): an update of a plugin already running is installed now, no card.
   */
  async install(name: string, options: { direct?: boolean } = {}): Promise<PluginStoreView> {
    const catalog = this.catalog;
    const entry = catalog.entry(name);
    if (!entry) { this.setStatus(name, { kind: "failed", message: `"${name}" is not in the plugin index.` }); return this.view(); }
    const busy = this.status.get(name)?.kind;
    if (busy === "checking" || busy === "asking") return this.view();
    const { state, installedVersion } = this.stateOf(entry);
    const refuse = (message: string) => { this.setStatus(name, { kind: "failed", message }); return this.view(); };
    if (state === "devCopy") return refuse(`Your plugin library has its own "${name}" (a development copy). It stays as it is; the published one is not installed over it.`);
    if (state === "tooOld") return refuse(this.tooOld(entry) ?? "This Botling is too old for it.");
    if (state === "unreleased") return refuse(`"${entry.displayName}" has no released commit in the index yet.`);
    if (state === "installed" || state === "builtIn") return refuse(`"${entry.displayName}" ${entry.version} is already installed.`);
    this.setStatus(name, { kind: "checking", message: null });
    let staged: { work: string; folder: string };
    try {
      staged = await catalog.download(entry, join(this.deps.root, "install-staging"));
    } catch (error) {
      return refuse(error instanceof HashMismatch ? error.message : `Couldn't download "${entry.displayName}": ${(error as Error).message}`);
    }
    const proposal = readProposal(staged.folder, staged.work, catalog.source.folderPage(entry.commit, entry.path));
    const cleanup = () => rmSync(staged.work, { recursive: true, force: true });
    if (proposal.problems.length) { cleanup(); return refuse(`"${title(proposal.manifest)}" failed the checks and was not installed: ${proposal.problems.join("; ")}`); }
    if (proposal.manifest.name !== entry.name || proposal.manifest.version !== entry.version) {
      cleanup();
      return refuse(`The downloaded folder is "${proposal.manifest.name}" ${proposal.manifest.version}, not "${entry.name}" ${entry.version} as the index says. It was not installed.`);
    }
    proposal.verified = `its files match the index (sha256 ${entry.sha256.slice(0, 12)}…) at commit ${entry.commit.slice(0, 7)}${catalog.source.official ? " of the official botling-plugins repo" : ` of ${catalog.source.indexURL}`}.`;
    proposal.verifiedSha256 = entry.sha256;
    if (state === "update" && installedVersion) proposal.replacing = installedVersion;
    if (options.direct && state === "update" && installedVersion) {
      const problem = this.deps.desk.installNow(proposal);
      this.setStatus(name, problem ? { kind: "failed", message: problem } : { kind: "installed", message: null });
      return this.view();
    }
    this.setStatus(name, { kind: "asking", message: null });
    this.deps.desk.offerInstall(proposal, (installed, problem) => {
      this.setStatus(name, installed ? { kind: "installed", message: null } : problem ? { kind: "failed", message: problem } : { kind: "declined", message: null });
    });
    return this.view();
  }

  /** The page was told how an install ended: the note goes (installed / declined / failed). */
  dismiss(name: string) {
    const kind = this.status.get(name)?.kind;
    if (kind && kind !== "checking" && kind !== "asking") this.setStatus(name, null);
    return this.view();
  }
}
