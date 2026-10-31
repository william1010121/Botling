// Released versions. electron-updater finds, downloads and installs them from the GitHub Releases feed that
// electron-builder writes (latest.yml, latest-mac.yml, latest-linux.yml, signed by the platform's own
// certificate), the same way on macOS, Windows and Linux (AppImage). A Linux .deb cannot update itself, so
// there it only says a newer version exists and opens the release page. Developer builds are a different
// path (core/app-swap.ts).
import type { ReleaseView, UpdateView } from "../contract";

export const REPOSITORY = "william1010121/Botling";
export const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases/`;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

export interface Version { major: number; minor: number; patch: number; pre: string[] }

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,60}))?(?:\+[0-9A-Za-z.-]*)?$/.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split(".") : [] };
}

/** Semver's order: <0 when a is older than b. A prerelease is older than its release. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] - b[key];
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx - ny;
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** What electron-updater says about a release (the fields read). */
export interface UpdateInfoLike {
  version: string;
  releaseName?: string | null;
  releaseDate?: string;
  files?: { url: string }[];
  path?: string;
}
/** The part of electron-updater's AppUpdater this file uses, so tests can stand in for it. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "update-downloaded", listener: (info: UpdateInfoLike) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
}

export interface UpdaterOptions {
  current: string;
  updater: UpdaterLike;
  /** Whether Settings has the check on (asked each time: the core keeps settings.json). */
  enabled: () => Promise<boolean>;
  /** Null: this install can update itself; else why not (a development run, a Linux .deb). */
  unavailable: () => string | null;
  /** The last result, kept across starts (`<data>/updates.json`). */
  load: () => { checkedAt: number; newer: ReleaseView | null } | null;
  save: (state: { checkedAt: number; newer: ReleaseView | null }) => void;
  now?: () => number;
}

/** The release page for a version (always one of this repository's own). */
export const releaseUrl = (version: string) => `${RELEASE_PAGE}tag/v${version}`;

/** A release as the Settings page and the update notice show it. */
export function releaseView(info: UpdateInfoLike): ReleaseView {
  const asset = info.files?.[0]?.url ?? info.path ?? null;
  return {
    version: info.version.slice(0, 100),
    name: (info.releaseName?.trim() || `Botling ${info.version}`).slice(0, 400),
    url: releaseUrl(info.version),
    publishedAt: info.releaseDate ? String(info.releaseDate).slice(0, 100) : null,
    asset: asset ? asset.slice(0, 400) : null,
  };
}

export class Updater {
  private running: Promise<UpdateView> | null = null;
  private error: string | null = null;
  private downloading: Promise<UpdateView> | null = null;
  private downloaded: string | null = null;
  private percent: number | null = null;

  constructor(private readonly options: UpdaterOptions) {
    const updater = options.updater;
    updater.autoDownload = false;            // Downloading is the user's click.
    updater.autoInstallOnAppQuit = false;    // A normal quit never installs.
    updater.allowDowngrade = false;
    // A prerelease build (a trial) follows prereleases; a stable one does not.
    updater.allowPrerelease = (parseVersion(options.current)?.pre.length ?? 0) > 0;
    updater.on("update-downloaded", (info) => { this.downloaded = info.version; });
    updater.on("download-progress", (progress) => {
      this.percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null;
    });
  }

  /** The state as last known, without fetching. */
  view(enabled: boolean): UpdateView {
    const saved = this.options.load();
    const newer = saved?.newer && this.stillNewer(saved.newer) ? saved.newer : null;
    return {
      current: this.options.current, enabled, newer, checkedAt: saved?.checkedAt ?? null, error: this.error,
      installError: this.options.unavailable(), readyVersion: this.downloaded,
      downloadPercent: this.percent,
    };
  }

  /** Checks when on and due (or always when `manual`); one check at a time. */
  async check(manual: boolean): Promise<UpdateView> {
    const enabled = await this.options.enabled();
    if (!manual && !enabled) return this.view(false);
    const saved = this.options.load();
    const now = (this.options.now ?? Date.now)();
    if (!manual && saved && now - saved.checkedAt < CHECK_EVERY_MS && now >= saved.checkedAt) return this.view(enabled);
    this.running ??= (async () => {
      try {
        const result = await this.options.updater.checkForUpdates();
        const available = !!result && result.isUpdateAvailable !== false;
        const info = result?.updateInfo;
        const newer = available && info && this.stillNewer({ version: info.version }) ? releaseView(info) : null;
        this.error = null;
        this.options.save({ checkedAt: (this.options.now ?? Date.now)(), newer });
      } catch (failure) {
        this.error = `Could not check for updates: ${String((failure as Error)?.message ?? failure).slice(0, 300)}`;
      }
      return this.view(enabled);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Downloads the newer release (electron-updater verifies it against the feed's checksum and the platform signature). */
  async download(): Promise<UpdateView> {
    const enabled = await this.options.enabled();
    const why = this.options.unavailable();
    if (why) throw new Error(why);
    const newer = this.options.load()?.newer;
    if (!newer || !this.stillNewer(newer)) throw new Error("There is no newer release.");
    this.downloading ??= (async () => {
      this.percent = null;
      try { if (this.downloaded !== newer.version) await this.options.updater.downloadUpdate(); this.error = null; }
      catch (failure) { this.error = `Download failed: ${String((failure as Error)?.message ?? failure).slice(0, 300)}`; throw failure; }
      finally { this.percent = null; }
      return this.view(enabled);
    })().finally(() => { this.downloading = null; this.percent = null; });
    return this.downloading;
  }

  /** The version downloaded and ready to install, or null. */
  get ready(): string | null { return this.downloaded; }

  /** Quits and installs the downloaded release (the caller has saved running work first). */
  restart() {
    if (!this.downloaded) throw new Error("Nothing is downloaded yet.");
    this.options.updater.quitAndInstall(true, true);
  }

  /** The page to open for the newer release, or null. */
  releasePage(): string | null {
    const newer = this.options.load()?.newer;
    return newer && this.stillNewer(newer) && newer.url.startsWith(RELEASE_PAGE) ? newer.url : null;
  }

  private stillNewer(release: { version: string }): boolean {
    const mine = parseVersion(this.options.current);
    const theirs = parseVersion(release.version);
    return !!mine && !!theirs && compareVersions(theirs, mine) > 0;
  }
}
