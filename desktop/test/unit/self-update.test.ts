// What the core keeps of the app replacing itself (core/self-update.ts): the `healthy` handshake the install script waits for,
// and the notice of a newer signed release in the main bot's chat. The rest of self-update is botling.dev's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { ReleaseNotices, confirmHealthy, updateFolder, type NoticeBot } from "../../src/core/self-update";

class FakeBot implements NoticeBot {
  notices: { text: string; choices?: { label: string; recommended?: boolean }[]; onPick?: (index: number) => void }[] = [];
  appNotice(text: string, choices?: { label: string; recommended?: boolean }[], onPick?: (index: number) => void) {
    this.notices.push({ text, ...(choices ? { choices } : {}), ...(onPick ? { onPick } : {}) });
    return `n${this.notices.length}`;
  }
}

function desk(root: string, over: Partial<ConstructorParameters<typeof ReleaseNotices>[0]> = {}) {
  const main = new FakeBot();
  const builds = { announceRelease: (release: Parameters<ReleaseNotices["announce"]>[0]) => notices.announce(release) };
  const notices = new ReleaseNotices({ root: join(root, "core"), developerMode: () => true, mainBot: () => main, log: () => {}, ...over });
  return { builds, main, notices };
}

afterEach(() => { vi.useRealTimers(); });

describe("the healthy handshake", () => {
  const install = (root: string, extra: Record<string, string> = {}) => {
    mkdirSync(updateFolder(root), { recursive: true });
    writeFileSync(join(updateFolder(root), "state.json"), JSON.stringify({ from: { path: "/a.app" }, to: { path: "/b.app" }, requesterID: "DEV", note: "" }));
    for (const [name, text] of Object.entries(extra)) writeFileSync(join(updateFolder(root), name), text);
  };

  it("a build that ran long enough writes `healthy`, and leaves the install state for botling.dev", () => {
    vi.useFakeTimers();
    const root = tempDir("self-update");
    install(root);
    expect(confirmHealthy(root, 8_000)).not.toBeNull();
    vi.advanceTimersByTime(7_999);
    expect(existsSync(join(updateFolder(root), "healthy"))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(existsSync(join(updateFolder(root), "healthy"))).toBe(true);
    expect(existsSync(join(updateFolder(root), "state.json"))).toBe(true);
  });

  it("does nothing without an install under way, after a roll-back, or with a state it cannot read", () => {
    const none = tempDir("self-update");
    expect(confirmHealthy(none, 1)).toBeNull();
    const rolled = tempDir("self-update");
    install(rolled, { "rolled-back": "could not copy the new build\n" });
    expect(confirmHealthy(rolled, 1)).toBeNull();
    const broken = tempDir("self-update");
    install(broken);
    writeFileSync(join(updateFolder(broken), "state.json"), "{ not json");
    expect(confirmHealthy(broken, 1)).toBeNull();
  });
});

describe("a newer release", () => {
  const release = { version: "2.0.2", name: "Botling 2.0.2", url: "https://github.com/william1010121/Botling/releases/tag/v2.0.2", current: "2.0.1", unavailable: null };

  it("is an update notice in the main bot's chat; Install and restart installs it, once per version and run", async () => {
    const root = tempDir("self-update");
    const asks: string[] = [];
    let answer: { ok: boolean; error?: string } = { ok: false, error: "No compatible macOS ZIP in this release" };
    const { builds, main } = desk(root, { installRelease: async () => { asks.push("install"); return answer; } });
    builds.announceRelease(release);
    const card = main.notices.at(-1)!;
    expect(card.text).toContain("**Botling 2.0.2** is available (running 2.0.1).");
    expect(card.text).toContain("[Botling 2.0.2](https://github.com/william1010121/Botling/releases/tag/v2.0.2)");
    expect(card.choices!.map((choice) => choice.label)).toEqual(["Install and restart", "Not now"]);
    expect(asks).toEqual([]);
    builds.announceRelease(release);
    expect(main.notices).toHaveLength(1);
    card.onPick!(0);
    await vi.waitFor(() => expect(main.notices.at(-1)!.text).toBe("Couldn't install Botling 2.0.2: No compatible macOS ZIP in this release"));
    expect(asks).toEqual(["install"]);
    // A failed install may be offered again.
    answer = { ok: true };
    builds.announceRelease(release);
    main.notices.at(-1)!.onPick!(0);
    await vi.waitFor(() => expect(asks).toEqual(["install", "install"]));
    expect(main.notices.at(-1)!.choices).toBeDefined();
  });

  it("shows in the main bot's chat only while developer mode is on; otherwise the sidebar entry is the way to update", () => {
    const root = tempDir("self-update");
    let developerMode = false;
    const { builds, main } = desk(root, { developerMode: () => developerMode, installRelease: async () => ({ ok: true }) });
    expect(builds.announceRelease(release)).toBeNull();
    expect(main.notices).toHaveLength(0);
    // Not remembered as announced or declined: turning developer mode on shows it at the next check.
    developerMode = true;
    expect(builds.announceRelease(release)).not.toBeNull();
    expect(main.notices).toHaveLength(1);
    developerMode = false;
    expect(builds.announceRelease({ ...release, version: "2.0.3" })).toBeNull();
    expect(main.notices).toHaveLength(1);
  });

  it("Not now is remembered for that version; one that cannot be installed here says why, with no button", () => {
    const root = tempDir("self-update");
    const { builds, main } = desk(root, { installRelease: async () => ({ ok: true }) });
    builds.announceRelease(release);
    main.notices.at(-1)!.onPick!(1);
    const again = desk(root, { installRelease: async () => ({ ok: true }) });
    expect(again.builds.announceRelease(release)).toBeNull();
    expect(again.main.notices).toHaveLength(0);
    expect(again.builds.announceRelease({ ...release, version: "2.0.3", unavailable: "Update trust is not configured" })).not.toBeNull();
    expect(again.main.notices.at(-1)!.text).toMatch(/It can't be installed from here: Update trust is not configured$/);
    expect(again.main.notices.at(-1)!.choices).toBeUndefined();
  });
});

