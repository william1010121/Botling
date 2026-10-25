// GitHub Releases 2.x discovery. Verification and installation live in update-install.ts.
import type { ReleaseView, UpdateView } from "../contract";

export const REPOSITORY = "william1010121/Botling";
export const FEED = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
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

/** A release as GitHub's API gives it (only what is read). */
interface RawRelease { tag_name?: unknown; name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; assets?: unknown }

/** The artifact name electron-builder gives this platform's download (electron-builder.config.cjs). */
export function assetPattern(platform: string, arch: string): RegExp {
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
  return new RegExp(`^Botling-2-.+-${os}-${arch === "x64" ? "(?:x64|x86_64|amd64)" : arch === "arm64" ? "(?:arm64|aarch64)" : arch}\\.`);
}

/**
 * The newest release newer than `current` that this build may take, or null. Anything that does not
 * look like one of the repository's release pages is skipped, so a page link is always one of its own.
 */
export function pickUpdate(releases: unknown, current: string, platform: string, arch: string): ReleaseView | null {
  const mine = parseVersion(current);
  if (!mine || !Array.isArray(releases)) return null;
  const pattern = assetPattern(platform, arch);
  let best: { version: Version; view: ReleaseView } | null = null;
  for (const raw of releases.slice(0, 100) as RawRelease[]) {
    if (!raw || typeof raw !== "object" || raw.draft === true) continue;
    if (typeof raw.tag_name !== "string" || typeof raw.html_url !== "string") continue;
    const version = parseVersion(raw.tag_name);
    if (!version || version.major !== 2) continue;
    if ((raw.prerelease === true || version.pre.length) && !mine.pre.length) continue;
    if (!raw.html_url.startsWith(RELEASE_PAGE) || raw.html_url.length > 2_000) continue;
    if (compareVersions(version, mine) <= 0) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    const assets = Array.isArray(raw.assets) ? raw.assets as { name?: unknown }[] : [];
    const asset = assets.map((entry) => entry?.name).find((name): name is string => typeof name === "string" && pattern.test(name) && (platform !== "darwin" || name.endsWith(".zip"))) ?? null;
    best = {
      version,
      view: {
        version: raw.tag_name.replace(/^v/, "").slice(0, 100),
        name: (typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.tag_name).slice(0, 400),
        url: raw.html_url,
        publishedAt: typeof raw.published_at === "string" ? raw.published_at.slice(0, 100) : null,
        asset: asset ? asset.slice(0, 400) : null,
      },
    };
  }
  return best?.view ?? null;
}

export interface UpdaterOptions {
  current: string;
  platform: string;
  arch: string;
  /** Whether Settings has the check on (asked each time: the core keeps settings.json). */
  enabled: () => Promise<boolean>;
  /** Reads the feed (GitHub's JSON); throws on failure. */
  fetchFeed: () => Promise<unknown>;
  /** The last result, kept across starts (`<data>/updates.json`). */
  load: () => { checkedAt: number; newer: ReleaseView | null } | null;
  save: (state: { checkedAt: number; newer: ReleaseView | null }) => void;
  now?: () => number;
  installStatus?: () => { installError: string | null; readyVersion: string | null; recoveryError?: string | null; recoveryId?:string|null };
}

export class Updater {
  private running: Promise<UpdateView> | null = null;
  private error: string | null = null;

  constructor(private readonly options: UpdaterOptions) {}

  /** The state as last known, without fetching. */
  view(enabled: boolean): UpdateView {
    const saved = this.options.load();
    const newer = saved?.newer && this.stillNewer(saved.newer) ? saved.newer : null;
    return { current: this.options.current, enabled, newer, checkedAt: saved?.checkedAt ?? null, error: this.error, ...this.options.installStatus?.() };
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
        const feed = await this.options.fetchFeed();
        const newer = pickUpdate(feed, this.options.current, this.options.platform, this.options.arch);
        this.error = null;
        this.options.save({ checkedAt: (this.options.now ?? Date.now)(), newer });
      } catch (failure) {
        this.error = `Could not reach GitHub Releases: ${String((failure as Error)?.message ?? failure).slice(0, 300)}`;
      }
      return this.view(enabled);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** The page to open for the newer release, or null. */
  releasePage(): string | null {
    const newer = this.options.load()?.newer;
    return newer && this.stillNewer(newer) && newer.url.startsWith(RELEASE_PAGE) ? newer.url : null;
  }

  private stillNewer(release: ReleaseView): boolean {
    const mine = parseVersion(this.options.current);
    const theirs = parseVersion(release.version);
    return !!mine && !!theirs && compareVersions(theirs, mine) > 0;
  }
}
