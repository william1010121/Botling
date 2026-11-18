// Botling 3 finds Botling 3 releases (and 2.x never sees them): the real electron-updater GitHubProvider
// (6.8.11 `getLatestVersion`) is run against a fake releases feed, with the channel the v3 config and src/main/updates.ts
// name and the tag the release script builds. No network. This is the check behind the `v3.x.y-v3` tag rule: with a
// channel set, electron-updater only takes a release whose tag's pre-release part is that channel, so a stable-looking
// `v3.2.2` tag ends in "No published versions on GitHub".
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "../..");
const req = createRequire(import.meta.url);
const { GitHubProvider } = req("electron-updater/out/providers/GitHubProvider") as { GitHubProvider: any };
// The semver electron-updater itself loads: a SemVer made by another copy of the package is not recognized as one.
const semver = createRequire(req.resolve("electron-updater"))("semver") as { parse(version: string): unknown };
const v3Config = req(join(desktopRoot, "electron-builder.v3.config.cjs")) as { publish: { channel?: string }[] };

const atom = (tags: string[]) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/${tag}"/><title>${tag}</title><content type="html">notes</content></entry>`).join("")}</feed>`;
const feedFile = (version: string) => `version: ${version}\nfiles:\n  - url: Botling-3-${version}-mac-arm64.zip\n    sha512: abc\n    size: 1\npath: Botling-3-${version}-mac-arm64.zip\nsha512: abc\nreleaseDate: '2026-11-18T00:00:00.000Z'\n`;

/** What the app asks GitHub: the releases feed (every published release, pre-releases too) and, for a stable build,
 * the one release GitHub calls Latest (never a pre-release). */
async function lookup(options: { tags: string[]; current: string; channel: string | null; allowPrerelease: boolean; latestTag?: string }) {
  const requested: string[] = [];
  const updater = { channel: options.channel, allowPrerelease: options.allowPrerelease, currentVersion: semver.parse(options.current) };
  const executor = { request: async (request: { path: string }) => { requested.push(request.path); return feedFile("9.9.9"); } };
  const provider = new GitHubProvider({ provider: "github", owner: "o", repo: "r" }, updater, { executor, platform: "darwin" });
  provider.httpRequest = async (url: URL) => url.pathname.endsWith(".atom") ? atom(options.tags) : JSON.stringify({ tag_name: options.latestTag });
  try {
    const found = await provider.getLatestVersion();
    return { tag: found.tag as string, requested };
  } catch (failure) {
    return { error: String((failure as Error).message).split("\n")[0], requested };
  }
}

async function releaseScript(): Promise<any> {
  return await import(/* @vite-ignore */ pathToFileURL(join(desktopRoot, "scripts/release-check.mjs")).href);
}

describe("Botling 3 updates and Botling 2 updates against one releases feed", () => {
  it("the channel the app follows is the one the v3 config writes feeds for", async () => {
    const channels = v3Config.publish.map((entry) => entry.channel);
    expect(channels).toEqual(["v3"]);
    expect((await releaseScript()).V3_CHANNEL).toBe(channels[0]);
  });

  it("3.x finds the release whose tag is v<version>-v3 and reads its v3-mac.yml", async () => {
    const { v3Tag } = await releaseScript();
    const found = await lookup({ tags: [v3Tag("3.2.2"), "v2.6.0"], current: "3.2.1", channel: "v3", allowPrerelease: true });
    expect(found).toEqual({ tag: "v3.2.2-v3", requested: ["/o/r/releases/download/v3.2.2-v3/v3-mac.yml"] });
  });

  it("a stable-looking v3.x.y tag is invisible to 3.x (the failure the -v3 tag rule prevents)", async () => {
    const found = await lookup({ tags: ["v3.2.2", "v2.6.0"], current: "3.2.1", channel: "v3", allowPrerelease: true });
    expect(found).toEqual({ error: "No published versions on GitHub", requested: [] });
  });

  it("2.x follows GitHub's Latest and never reaches for a v3 release in the feed", async () => {
    const stable = await lookup({ tags: ["v3.2.2-v3", "v2.6.0"], current: "2.6.0", channel: null, allowPrerelease: false, latestTag: "v2.6.0" });
    expect(stable).toEqual({ tag: "v2.6.0", requested: ["/o/r/releases/download/v2.6.0/latest-mac.yml"] });
    // A 2.x dev trial (a pre-release build with channel `dev`) only takes a tag of its own channel.
    const trial = await lookup({ tags: ["v3.2.2-v3", "v2.6.0"], current: "2.0.0-dev.20261026.1", channel: null, allowPrerelease: true });
    expect(trial).toEqual({ error: "No published versions on GitHub", requested: [] });
  });

  it("the tag the release script makes for a version is one electron-updater accepts for channel v3, and a bare one is refused", async () => {
    const { v3Tag, releaseTrack } = await releaseScript();
    expect(releaseTrack(v3Tag("3.2.2"))).toBe("v3");
    expect(() => releaseTrack("v3.2.2")).toThrow(/v3\.x\.y-v3/);
  });
});
