// Old app copies the self-update leaves behind: backups in core/self-update/backups (keep the newest 2) and the
// leftovers in ~/Applications after an update succeeded. Everything here runs in temp folders; nothing real is touched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import { DevBuilds } from "../src/desk";
import { KEEP_BACKUPS, pruneBackups, pruneUpdateLeftovers } from "../src/prune";
import { prepareInstall, type BuildInfo } from "../src/swap";

afterEach(() => { vi.useRealTimers(); });

function folder(path: string, bytes = "x") {
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents", "blob"), bytes);
  return path;
}
const backupName = (version: string, epoch: number) => `Botling-2-${version}-2026-11-0${epoch % 9}-${epoch}.app`;
const names = (dir: string) => readdirSync(dir).sort();

describe("backups: keep the newest two", () => {
  it("removes older ones, ordered by the stamp in the name (not by modified time)", () => {
    const dir = tempDir("prune-backups");
    const all = [100, 300, 200, 500, 400].map((epoch) => backupName("2.0.1", epoch));
    for (const name of all) folder(join(dir, name));
    const result = pruneBackups(dir);
    expect(KEEP_BACKUPS).toBe(2);
    expect(names(dir)).toEqual([backupName("2.0.1", 400), backupName("2.0.1", 500)].sort());
    expect(result.removed).toHaveLength(3);
  });

  it("changes nothing when there are two or fewer, or the folder is missing", () => {
    const dir = tempDir("prune-backups");
    folder(join(dir, backupName("2.0.1", 1)));
    expect(pruneBackups(dir).removed).toEqual([]);
    expect(names(dir)).toHaveLength(1);
    expect(pruneBackups(join(dir, "nope")).removed).toEqual([]);
  });

  it("never removes a protected one (the in-flight rollback, the running app), even when old", () => {
    const dir = tempDir("prune-backups");
    const oldest = join(dir, backupName("2.0.0", 100));
    const middle = join(dir, backupName("2.0.0", 200));
    for (const name of [oldest, middle, join(dir, backupName("2.0.1", 300)), join(dir, backupName("2.0.1", 400))]) folder(name);
    const result = pruneBackups(dir, { protect: [oldest, `${middle}/`] });
    expect(existsSync(oldest)).toBe(true);
    expect(existsSync(middle)).toBe(true);
    expect(result.removed).toEqual([]);
    // A protected path inside a backup (the app was reopened from there) protects the whole backup.
    const outcome = pruneBackups(dir, { keep: 1, protect: [join(oldest, "Contents")] });
    expect(existsSync(oldest)).toBe(true);
    expect(outcome.removed.sort()).toEqual([middle, join(dir, backupName("2.0.1", 300))].sort());
    expect(names(dir)).toEqual([backupName("2.0.0", 100), backupName("2.0.1", 400)].sort());
  });

  it("touches only Botling-2-*-<date>-<epoch>.app folders: other files, odd names and symlinks stay", () => {
    const dir = tempDir("prune-backups");
    const outside = tempDir("prune-outside");
    folder(join(outside, "precious.app"));
    for (const epoch of [1, 2, 3, 4]) folder(join(dir, backupName("2.0.1", epoch)));
    writeFileSync(join(dir, "notes.txt"), "keep");
    folder(join(dir, "Botling-2-hand-made.app"));
    folder(join(dir, "Other.app"));
    symlinkSync(join(outside, "precious.app"), join(dir, backupName("2.0.1", 0)));
    pruneBackups(dir);
    expect(names(dir)).toEqual([backupName("2.0.1", 0), backupName("2.0.1", 3), backupName("2.0.1", 4), "Botling-2-hand-made.app", "Other.app", "notes.txt"].sort());
    expect(existsSync(join(outside, "precious.app", "Contents", "blob"))).toBe(true);
  });
});

describe("~/Applications leftovers", () => {
  it("removes only .botling-update-*, update-after-* and .botling-hot-* direct children", () => {
    const apps = tempDir("prune-apps");
    const gone = [".botling-update-123", "update-after-2.0.2", ".botling-hot-9.app"];
    for (const name of gone) folder(join(apps, name));
    writeFileSync(join(apps, ".botling-update-file"), "a plain file leftover");
    const stay = ["Botling 2.app", "Botling 2.app.failed", ".botling-updater", "botling-update-1", ".update-after-1", "my-update-after-x", "Other.app", ".botling-hot", "update-after-"];
    for (const name of stay) folder(join(apps, name));
    // Matching names deeper down are not direct children.
    folder(join(apps, "Other.app", ".botling-hot-inner"));
    const result = pruneUpdateLeftovers(apps);
    expect(result.removed.sort()).toEqual([...gone, ".botling-update-file"].sort().map((name) => join(apps, name)));
    expect(names(apps)).toEqual([...stay].sort());
    expect(existsSync(join(apps, "Other.app", ".botling-hot-inner"))).toBe(true);
  });

  it("skips symlinks (and never follows them), and anything in use or protected", () => {
    const apps = tempDir("prune-apps");
    const outside = tempDir("prune-outside");
    folder(join(outside, "target"));
    symlinkSync(join(outside, "target"), join(apps, ".botling-update-link"));
    folder(join(apps, ".botling-hot-running"));
    folder(join(apps, "update-after-installed"));
    folder(join(apps, "update-after-parent"));
    folder(join(apps, ".botling-update-old"));
    const result = pruneUpdateLeftovers(apps, {
      protect: [join(apps, ".botling-hot-running"), join(apps, "update-after-installed", "Contents"), join(apps, "update-after-parent", "Contents", "blob", "..", "..")],
    });
    expect(result.removed).toEqual([join(apps, ".botling-update-old")]);
    expect(names(apps)).toEqual([".botling-hot-running", ".botling-update-link", "update-after-installed", "update-after-parent"]);
    expect(existsSync(join(outside, "target", "Contents", "blob"))).toBe(true);
  });

  it("a missing folder is fine, and a protected path that contains the leftover protects it", () => {
    const apps = tempDir("prune-apps");
    expect(pruneUpdateLeftovers(join(apps, "none")).removed).toEqual([]);
    folder(join(apps, ".botling-update-x", "Botling 2.app"));
    expect(pruneUpdateLeftovers(apps, { protect: [join(apps, ".botling-update-x", "Botling 2.app")] }).removed).toEqual([]);
  });
});

describe("after an update succeeds (DevBuilds.check)", () => {
  function setup() {
    vi.useFakeTimers();
    const root = tempDir("prune-desk");
    const apps = join(root, "Applications");
    mkdirSync(apps, { recursive: true });
    folder(join(apps, "Botling 2.app", "Contents", "MacOS"));
    const info = (path: string): BuildInfo => ({ path, bundleID: "id", version: "2.0.1", commit: "a".repeat(10), dirty: false });
    const running = info(join(apps, "Botling 2.app"));
    const to = info(join(root, "dist", "Botling 2.app"));
    const core = join(root, "core");
    const notices: string[] = [];
    const bot = { id: "DEV", profile: { name: "botling", folder: root }, appNotice: (text: string) => { notices.push(text); return ""; }, relay: () => ({}), queueNote: () => {} };
    const builds = new DevBuilds({
      root: core, runningBuild: () => running, developer: () => bot, mainBot: () => bot, bot: () => bot, appPid: 1, appDataDir: null,
      launchInstaller: () => {}, captureWindow: async () => null, log: () => {}, applicationsDir: () => apps,
    });
    return { root, apps, running, to, core, builds };
  }

  it("prunes backups to two (keeping this install's rollback copy) and clears Applications leftovers", () => {
    const { apps, running, to, core, builds } = setup();
    prepareInstall(core, running, to, "DEV", "", 1, "", new Date("2026-11-04T00:00:00Z"));
    const backups = join(core, "self-update", "backups");
    for (const epoch of [10, 20, 30, 40]) folder(join(backups, backupName("2.0.0", epoch)));
    // This install's own backup, as the script made it (it is also the newest by name).
    const current = (JSON.parse(readFileSync(join(core, "self-update", "state.json"), "utf8")) as { backup: string }).backup;
    folder(current);
    for (const name of [".botling-update-a", "update-after-b", ".botling-hot-c"]) folder(join(apps, name));
    folder(join(apps, "Keep.app"));
    builds.check(8_000);
    // Nothing happens before the new build has run for a while.
    expect(readdirSync(backups)).toHaveLength(5);
    vi.advanceTimersByTime(8_000);
    expect(names(backups)).toEqual([backupName("2.0.0", 40), current.split("/").pop()!].sort());
    expect(names(apps)).toEqual(["Botling 2.app", "Keep.app"]);
  });

  it("does nothing to either folder when the new build rolled back", () => {
    const { apps, running, to, core, builds } = setup();
    prepareInstall(core, running, to, "DEV", "", 1, "");
    const backups = join(core, "self-update", "backups");
    for (const epoch of [10, 20, 30]) folder(join(backups, backupName("2.0.0", epoch)));
    folder(join(apps, ".botling-hot-c"));
    writeFileSync(join(core, "self-update", "rolled-back"), "did not come up\n");
    builds.check();
    vi.advanceTimersByTime(60_000);
    expect(readdirSync(backups)).toHaveLength(3);
    expect(existsSync(join(apps, ".botling-hot-c"))).toBe(true);
  });

  it("leaves ~/Applications alone when no folder is configured", () => {
    const { apps, running, to, core } = setup();
    const bot = { id: "DEV", profile: { name: "b", folder: "" }, appNotice: () => "", relay: () => ({}), queueNote: () => {} };
    const builds = new DevBuilds({ root: core, runningBuild: () => running, developer: () => bot, mainBot: () => bot, bot: () => bot, appPid: 1, appDataDir: null, launchInstaller: () => {}, captureWindow: async () => null, log: () => {} });
    prepareInstall(core, running, to, "DEV", "", 1, "");
    folder(join(apps, ".botling-hot-c"));
    builds.check(1);
    vi.advanceTimersByTime(10);
    expect(existsSync(join(apps, ".botling-hot-c"))).toBe(true);
  });
});
