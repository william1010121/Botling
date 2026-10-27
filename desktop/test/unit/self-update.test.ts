// Developer mode's builds (1.x's SelfUpdate.swift / Workspace+Developer.swift, core/self-update.ts): reading a
// bundle, the confirm card, starting the install, how it went at the next start, and the app screenshot.
// Nothing here runs the install script (it would open an app); its syntax is checked with bash -n.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { packagedDataDir } from "../../src/main/main-environment";
import {
  DevBuilds, FAILURE_LIMIT, INSTALL_SCRIPT, buildLabel, devWorkRoot, failures, installOutcome, installTarget, localDataMove, prepareInstall, readBuild, sensitiveChanges, setFailures,
  type BuildInfo, type DeskBot,
} from "../../src/core/self-update";

const BUNDLE_ID = "io.github.william1010121.Botling2";

function fakeApp(dir: string, name: string, info: Record<string, string> = {}): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const all = { CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: "Botling 2", CFBundleShortVersionString: "2.0.1", ...info };
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${Object.entries(all).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join("\n")}
  <key>LSUIElement</key><false/>
</dict></plist>`);
  writeFileSync(join(app, "Contents", "MacOS", all.CFBundleExecutable), "#!/bin/sh\n");
  chmodSync(join(app, "Contents", "MacOS", all.CFBundleExecutable), 0o755);
  return app;
}

class FakeBot implements DeskBot {
  notices: { text: string; choices?: { label: string; recommended?: boolean }[]; onPick?: (index: number) => void }[] = [];
  notes: string[] = [];
  relays: { text: string; files?: string[] }[] = [];
  constructor(readonly id: string, readonly profile: { name: string; folder: string }) {}
  appNotice(text: string, choices?: { label: string; recommended?: boolean }[], onPick?: (index: number) => void) {
    this.notices.push({ text, ...(choices ? { choices } : {}), ...(onPick ? { onPick } : {}) });
    return `n${this.notices.length}`;
  }
  relay(text: string, more: { files?: string[] } = {}) { this.relays.push({ text, ...more }); return {}; }
  queueNote(note: string) { this.notes.push(note); }
}

function desk(root: string, over: Partial<ConstructorParameters<typeof DevBuilds>[0]> = {}) {
  const main = new FakeBot("MAIN", { name: "Main bot", folder: join(root, "main") });
  const dev = new FakeBot("DEV", { name: "botling", folder: join(root, "repo") });
  const other = new FakeBot("OTHER", { name: "garden", folder: join(root, "garden") });
  const running = readBuild(fakeApp(join(root, "Applications"), "Botling 2", { BotlingGitCommit: "aaaaaaa1111" }));
  const launched: string[][] = [];
  const builds = new DevBuilds({
    root: join(root, "core"), runningBuild: () => running, developer: () => dev, mainBot: () => main,
    bot: (id) => [main, dev, other].find((bot) => bot.id === id) ?? null,
    appPid: 4242, appDataDir: join(root, "data"),
    launchInstaller: (command) => { launched.push(command); },
    captureWindow: async () => join(root, "shot.png"),
    log: () => {},
    ...over,
  });
  return { builds, main, dev, other, running: running!, launched };
}

afterEach(() => { vi.useRealTimers(); });

describe("a build", () => {
  it("is read from its Info.plist: id, version, commit; anything else is no app", () => {
    const dir = tempDir("self-update");
    const build = readBuild(fakeApp(dir, "Botling 2", { BotlingGitCommit: "0123456789abcdef", BotlingGitDirty: "1" }))!;
    expect(build).toMatchObject({ bundleID: BUNDLE_ID, version: "2.0.1", commit: "0123456789abcdef", dirty: true });
    expect(buildLabel(build)).toBe("2.0.1 (0123456, uncommitted changes)");
    expect(buildLabel({ ...build, commit: null, dirty: false })).toBe("2.0.1");
    expect(readBuild(join(dir, "missing.app"))).toBeNull();
    mkdirSync(join(dir, "not-an-app"));
    expect(readBuild(join(dir, "not-an-app"))).toBeNull();
    const noExec = fakeApp(dir, "Broken");
    chmodSync(join(noExec, "Contents", "MacOS", "Botling 2"), 0o644);
    expect(readBuild(noExec)).toBeNull();
  });

  it("the install script is valid bash and takes 1.x's arguments plus the data folder", () => {
    const dir = tempDir("self-update");
    const from = readBuild(fakeApp(join(dir, "a"), "Botling 2"))!;
    const to = readBuild(fakeApp(join(dir, "b"), "Botling 2"))!;
    const command = prepareInstall(join(dir, "core"), from, to, "DEV", "faster", 4242, "/data");
    expect(command.slice(0, 3)).toEqual(["/usr/bin/nohup", "/bin/bash", join(dir, "core", "self-update", "install.sh")]);
    expect(command.slice(3)).toEqual(["4242", from.path, to.path, expect.stringMatching(/backups\/Botling-2-2\.0\.1-.*\.app$/), join(dir, "core", "self-update", "healthy"), join(dir, "core", "self-update", "rolled-back"), "90", "/data", from.path]);
    expect(readFileSync(command[2]!, "utf8")).toBe(INSTALL_SCRIPT);
    expect(spawnSync("/bin/bash", ["-n", command[2]!]).status).toBe(0);
    expect(installOutcome(join(dir, "core"))).toMatchObject({ kind: "installed", state: { requesterID: "DEV", note: "faster" } });
    writeFileSync(join(dir, "core", "self-update", "rolled-back"), "the new build did not come up in 90 seconds\n");
    expect(installOutcome(join(dir, "core"))).toMatchObject({ kind: "rolledBack", reason: "the new build did not come up in 90 seconds" });
  });

  it("names the changes that alter what bots may do", () => {
    const repo = tempDir("self-update-git");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
    git("init", "-q");
    mkdirSync(join(repo, "desktop", "src", "core"), { recursive: true });
    writeFileSync(join(repo, "desktop", "src", "core", "prompts.ts"), "a\n");
    writeFileSync(join(repo, "README.md"), "a\n");
    git("add", "-A"); git("commit", "-qm", "one");
    const one = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "desktop", "src", "core", "prompts.ts"), "b\nc\n");
    writeFileSync(join(repo, "README.md"), "b\n");
    writeFileSync(join(repo, "other.ts"), "const alwaysAllowed = [];\n");
    git("add", "-A"); git("commit", "-qm", "two");
    const two = git("rev-parse", "HEAD");
    expect(sensitiveChanges(repo, one, two)).toEqual([
      { file: "desktop/src/core/prompts.ts", added: 2, removed: 1 },
      { file: "other.ts", added: 1, removed: 0 },
    ]);
    expect(sensitiveChanges(repo, "nope", two)).toBeNull();
  });
});

describe("<install-build>", () => {
  it("only the developer project may ask; a bad path, another app or the running build is refused", () => {
    const root = tempDir("self-update");
    const { builds, main, dev, other, running } = desk(root);
    builds.propose(join(root, "x.app"), "", other);
    expect(other.notes.at(-1)).toMatch(/needs developer mode/);
    expect(main.notices).toHaveLength(0);
    builds.propose(join(root, "missing.app"), "", dev);
    expect(main.notices.at(-1)!.text).toMatch(/there is no app bundle at/);
    expect(dev.notes.at(-1)).toMatch(/^\(App: The build was not installed:/);
    builds.propose(fakeApp(root, "Other", { CFBundleIdentifier: "com.example.other" }), "", dev);
    expect(main.notices.at(-1)!.text).toMatch(/is not Botling 2 \(com\.example\.other\)/);
    builds.propose(running.path, "", dev);
    expect(main.notices.at(-1)!.text).toMatch(/that is the build running now/);
    setFailures(join(root, "core"), FAILURE_LIMIT);
    builds.propose(fakeApp(join(root, "dist"), "Botling 2"), "", dev);
    expect(main.notices.at(-1)!.text).toMatch(/installing is paused/);
    const { builds: unbundled, main: main2, dev: dev2 } = desk(tempDir("self-update"), { runningBuild: () => null });
    unbundled.propose("/x/Botling 2.app", "", dev2);
    expect(main2.notices.at(-1)!.text).toMatch(/not running from an app bundle/);
  });

  it("a card in the main bot's chat; Install starts the script, Not now tells the bot", () => {
    const root = tempDir("self-update");
    const { builds, main, dev, launched } = desk(root);
    const built = fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" });
    builds.propose(built, "Faster startup.", dev);
    const card = main.notices.at(-1)!;
    expect(card.text).toContain("**botling** wants to install a new Botling build and restart.");
    expect(card.text).toContain("- New: 2.0.1 (bbbbbbb)\n- Running: 2.0.1 (aaaaaaa)\n\nFaster startup.");
    expect(card.text).toMatch(/within 90 seconds, the running one comes back by itself/);
    expect(card.choices!.map((choice) => choice.label)).toEqual(["Install and restart", "Not now"]);
    expect(dev.notes.at(-1)).toMatch(/sees a card asking to install 2\.0\.1 \(bbbbbbb\)/);
    card.onPick!(1);
    expect(launched).toHaveLength(0);
    expect(dev.notes.at(-1)).toBe("(App: The user chose not to install 2.0.1 (bbbbbbb) now.)");
    builds.propose(built, "Faster startup.", dev);
    main.notices.at(-1)!.onPick!(0);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.slice(3, 6)).toEqual(["4242", join(root, "Applications", "Botling 2.app"), join(root, "dist", "Botling 2.app")]);
    expect(launched[0]!.slice(-2)).toEqual([join(root, "data"), join(root, "Applications", "Botling 2.app")]);
  });

  it("after the restart: up counts as up after a while, and the asker hears it; a roll-back is told and counted", () => {
    vi.useFakeTimers();
    const root = tempDir("self-update");
    const { builds, main, dev, running } = desk(root);
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" }))!;
    prepareInstall(join(root, "core"), running, to, "DEV", "Faster startup.", 1, "");
    setFailures(join(root, "core"), 1);
    builds.check(8_000);
    expect(main.notices).toHaveLength(0);
    vi.advanceTimersByTime(8_000);
    expect(existsSync(join(root, "core", "self-update", "healthy"))).toBe(true);
    expect(installOutcome(join(root, "core"))).toBeNull();
    expect(failures(join(root, "core"))).toBe(0);
    expect(main.notices.at(-1)!.text).toBe("Botling restarted on 2.0.1 (bbbbbbb) (was 2.0.1 (aaaaaaa)), installed for botling.");
    expect(dev.relays.at(-1)!.text).toMatch(/^\(App\) Botling restarted on 2\.0\.1 \(bbbbbbb\), the build you asked to install \(Faster startup\.\)/);

    prepareInstall(join(root, "core"), running, to, "DEV", "", 1, "");
    writeFileSync(join(root, "core", "self-update", "rolled-back"), "the new build did not come up in 90 seconds\n");
    builds.check();
    expect(main.notices.at(-1)!.text).toBe("The new build 2.0.1 (bbbbbbb) did not come up (the new build did not come up in 90 seconds); 2.0.1 (aaaaaaa) is running again.");
    expect(failures(join(root, "core"))).toBe(1);
    prepareInstall(join(root, "core"), running, to, "DEV", "", 1, "");
    writeFileSync(join(root, "core", "self-update", "rolled-back"), "could not copy the new build\n");
    builds.check();
    expect(main.notices.at(-1)!.text).toMatch(/That is 2 in a row: installing is paused/);
    expect(dev.relays.at(-1)!.text).toMatch(/Botling 2\.app\.failed\. Find out why before trying again\./);
    expect(installOutcome(join(root, "core"))).toBeNull();
    builds.developerModeOn();
    expect(failures(join(root, "core"))).toBe(0);
  });
});

describe("where a build is installed", () => {
  it("on this Mac's disk: in place when the running app is local, ~/Applications when it runs from an external volume", () => {
    expect(installTarget("/Volumes/My-SSD/botling-work/installed/trial/Botling 2.app", "/Users/me")).toBe("/Users/me/Applications/Botling 2.app");
    expect(installTarget("/Volumes/Other Disk/Botling 2.app", "/Users/me")).toBe("/Users/me/Applications/Botling 2.app");
    expect(installTarget("/Users/me/Applications/Botling 2.app", "/Users/me")).toBe("/Users/me/Applications/Botling 2.app");
    expect(installTarget("/Applications/Botling 2.app", "/Users/me")).toBe("/Applications/Botling 2.app");
  });

  it("a build replacing one on an external volume always restarts into ~/Applications; the drive's copy is the one reopened on failure", async () => {
    const root = tempDir("self-update");
    const local = join(root, "home", "Applications", "Botling 2.app");
    let planned = 0;
    const { builds, main, dev, running, launched } = desk(root, {
      installTarget: () => local,
      planBuild: async () => { planned++; return { mode: "hot", parts: ["core"] }; },
    });
    const built = fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" });
    await builds.propose(built, "", dev);
    const card = main.notices.at(-1)!;
    expect(planned).toBe(0);
    expect(card.text).toContain("wants to install a new Botling build and restart.");
    expect(card.text).toContain(`- Installed to: ${local} (this Mac's own disk).`);
    await card.onPick!(0);
    expect(launched).toHaveLength(1);
    const command = launched[0]!;
    expect(command[4]).toBe(local);
    expect(command[5]).toBe(built);
    expect(command.at(-1)).toBe(running.path);
  });

  it("the script installs to the new place and leaves the running copy; a build that does not come up is set aside and the old copy reopened", () => {
    const dir = tempDir("self-update-script");
    const running = readBuild(fakeApp(join(dir, "drive"), "Botling 2", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const build = readBuild(fakeApp(join(dir, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" }))!;
    const target = join(dir, "home", "Applications", "Botling 2.app");
    const opened = join(dir, "opened.log");
    const fakeOpen = join(dir, "open.sh");
    writeFileSync(fakeOpen, `#!/bin/sh\necho "$2" >> "${opened}"\n[ -n "$MAKE_HEALTHY" ] && touch "$MAKE_HEALTHY"\nexit 0\n`);
    chmodSync(fakeOpen, 0o755);
    const gone = spawnSync("/usr/bin/true").pid!;
    const run = (healthy: boolean) => {
      const command = prepareInstall(join(dir, "core"), running, build, "DEV", "", gone, "/data", new Date(), undefined, target);
      const args = command.slice(3);
      args[6] = "1"; // seconds to come up
      return spawnSync("/bin/bash", [command[2]!, ...args], { encoding: "utf8", env: { ...process.env, BOTLING_TEST_OPEN: fakeOpen, ...(healthy ? { MAKE_HEALTHY: args[4]! } : {}) } });
    };

    expect(run(true).status).toBe(0);
    expect(readBuild(target)?.commit).toBe("bbbbbbb2222");
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(readFileSync(opened, "utf8").trim().split("\n")).toEqual([target]);
    expect(installOutcome(join(dir, "core"))).toMatchObject({ kind: "installed" });

    // Again with nothing at the target (it was put aside), and the new build never says it is up.
    execFileSync("/bin/rm", ["-rf", target, opened]);
    expect(run(false).status).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(`${target}.failed`, "Contents", "Info.plist"), "utf8")).toContain("bbbbbbb2222");
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(readFileSync(opened, "utf8").trim().split("\n")).toEqual([target, running.path]);
    expect(installOutcome(join(dir, "core"))).toMatchObject({ kind: "rolledBack", reason: "the new build did not come up in 1 seconds" });
  });

  it("an existing build at the target is backed up and put back if the new one does not come up", () => {
    const dir = tempDir("self-update-script");
    const running = readBuild(fakeApp(join(dir, "home", "Applications"), "Botling 2", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const build = readBuild(fakeApp(join(dir, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" }))!;
    const fakeOpen = join(dir, "open.sh");
    writeFileSync(fakeOpen, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeOpen, 0o755);
    const command = prepareInstall(join(dir, "core"), running, build, "DEV", "", spawnSync("/usr/bin/true").pid!, "/data");
    const args = command.slice(3);
    args[6] = "1";
    expect(spawnSync("/bin/bash", [command[2]!, ...args], { env: { ...process.env, BOTLING_TEST_OPEN: fakeOpen } }).status).toBe(1);
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(readFileSync(join(`${running.path}.failed`, "Contents", "Info.plist"), "utf8")).toContain("bbbbbbb2222");
  });
});

describe("the data moves with a build that moves off an external volume", () => {
  const drive = "/Volumes/My-SSD/botling-work/installed/trial";
  const local = "/Users/me/Library/Application Support/Botling 2 Dev Trial";

  it("goes to the folder the app opens with from Finder, only when the data is on an external volume and the build moves", () => {
    // What main hands the core is what it opens with when no BOTLING_DATA_DIR is set.
    expect(packagedDataDir("/Users/me/Library/Application Support", true)).toBe(local);
    const running = `${drive}/Botling 2.app`, target = "/Users/me/Applications/Botling 2.app";
    expect(localDataMove(`${drive}/development-data`, running, target, local)).toBe(local);
    expect(localDataMove(`${drive}/development-data`, target, target, local)).toBeNull(); // installed in place
    expect(localDataMove("/Users/me/data", running, target, local)).toBeNull(); // already on this disk
    expect(localDataMove(`${drive}/development-data`, running, target, null)).toBeNull(); // not packaged
    expect(localDataMove(`${drive}/development-data`, running, target, "/Volumes/Other/data")).toBeNull();
    expect(localDataMove(`${drive}/development-data`, running, "/Volumes/X/Botling 2.app", local)).toBeNull();
    expect(localDataMove(null, running, target, local)).toBeNull();
  });

  it("the card says where the data goes, and the script is handed that folder", async () => {
    const root = tempDir("self-update");
    const target = "/Users/me/Applications/Botling 2.app"; // this Mac's own disk (the test folder may be on a drive)
    const { builds, main, dev, launched } = desk(root, {
      installTarget: () => target, appDataDir: `${drive}/development-data`, localDataDir: local,
      // The running build is on the drive.
      runningBuild: () => ({ path: `${drive}/Botling 2.app`, bundleID: BUNDLE_ID, version: "2.0.1", commit: "aaaaaaa1111", dirty: false }),
    });
    const built = fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" });
    await builds.propose(built, "", dev);
    const card = main.notices.at(-1)!;
    expect(card.text).toContain(`- Data: copied to ${local} if this Mac's disk has room for it (else it stays on the drive). The data on /Volumes/My-SSD is left as it is`);
    await card.onPick!(0);
    const command = launched[0]!;
    expect(command.slice(-3)).toEqual([`${drive}/development-data`, `${drive}/Botling 2.app`, local]);
  });

  /** A data folder on "the drive", an install of a build to "this Mac's disk", and a fake `open` (no app is opened). */
  function moving(dir: string) {
    const running = readBuild(fakeApp(join(dir, "drive"), "Botling 2", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const build = readBuild(fakeApp(join(dir, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" }))!;
    const target = join(dir, "home", "Applications", "Botling 2.app");
    const data = join(dir, "drive", "development-data");
    const localData = join(dir, "home", "Library", "Application Support", "Botling 2 Dev Trial");
    const core = join(data, "core");
    mkdirSync(join(core, "codex-threads"), { recursive: true });
    mkdirSync(join(core, "self-update", "backups", "Botling-2-old.app"), { recursive: true });
    writeFileSync(join(core, "self-update", "backups", "Botling-2-old.app", "big"), "x".repeat(4096));
    mkdirSync(join(data, "electron"), { recursive: true });
    symlinkSync("host-123", join(data, "electron", "SingletonLock"));
    writeFileSync(join(core, "approved-commands.json"), JSON.stringify({ main: [`cat ${core}/main/memory.md`] }));
    writeFileSync(join(core, "codex-threads", "t.workers.json"), JSON.stringify({ instructions: `Update only ${core}/main/memory.md` }));
    writeFileSync(join(core, "binary.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(core)]));
    const opened = join(dir, "opened.log");
    const fakeOpen = join(dir, "open.sh");
    // Logs what it was asked to open; MAKE_HEALTHY: the new build comes up, saying so where its data is.
    writeFileSync(fakeOpen, `#!/bin/sh\necho "$*" >> "${opened}"\ncase "$2" in "${target}") [ -n "$MAKE_HEALTHY" ] && mkdir -p "$(dirname "$MAKE_HEALTHY")" && touch "$MAKE_HEALTHY";; esac\nexit 0\n`);
    chmodSync(fakeOpen, 0o755);
    const run = (healthyAt: string | null, freeKb?: number) => {
      const command = prepareInstall(core, running, build, "DEV", "", spawnSync("/usr/bin/true").pid!, data, new Date(), undefined, target, localData);
      const args = command.slice(3);
      args[6] = "1";
      const env: Record<string, string | undefined> = { ...process.env, BOTLING_TEST_OPEN: fakeOpen, ...(healthyAt ? { MAKE_HEALTHY: healthyAt } : {}), ...(freeKb !== undefined ? { BOTLING_TEST_FREE_KB: String(freeKb) } : {}) };
      return spawnSync("/bin/bash", [command[2]!, ...args], { encoding: "utf8", env });
    };
    const openedLines = () => readFileSync(opened, "utf8").trim().split("\n");
    return { running, target, data, core, localData, run, openedLines };
  }

  it("copies the data to this Mac's disk without old builds, rewrites its path, and opens the new build with no data folder named", () => {
    const dir = tempDir("self-update-data");
    const { running, target, data, core, localData, run, openedLines } = moving(dir);
    const result = run(join(localData, "core", "self-update", "healthy"));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // Opened as from Finder: no BOTLING_DATA_DIR, so the build finds the copy at its own default.
    expect(openedLines()).toEqual([`-n ${target}`]);
    const newCore = join(localData, "core");
    expect(JSON.parse(readFileSync(join(newCore, "approved-commands.json"), "utf8"))).toEqual({ main: [`cat ${newCore}/main/memory.md`] });
    expect(readFileSync(join(newCore, "codex-threads", "t.workers.json"), "utf8")).toContain(`Update only ${newCore}/main/memory.md`);
    expect(readFileSync(join(newCore, "binary.bin")).includes(Buffer.from(core))).toBe(true); // binary files are left alone
    expect(existsSync(join(newCore, "self-update", "backups"))).toBe(false);
    expect(existsSync(join(localData, "electron", "SingletonLock"))).toBe(false);
    expect(existsSync(`${localData}.partial`)).toBe(false);
    // The new build reads the install's state from the copy.
    expect(installOutcome(newCore)).toMatchObject({ kind: "installed", state: { backup: expect.stringContaining(newCore) } });
    // The drive's data is as it was (but for its finished install state and a note), and the build there too.
    expect(readFileSync(join(core, "approved-commands.json"), "utf8")).toContain(`cat ${core}/main/memory.md`);
    expect(existsSync(join(core, "self-update", "backups", "Botling-2-old.app", "big"))).toBe(true);
    expect(installOutcome(core)).toBeNull();
    expect(readFileSync(join(data, "MOVED-TO-LOCAL-DISK.txt"), "utf8")).toContain(localData);
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(result.stdout).toContain("rewrote the data folder's path in core/approved-commands.json");
  });

  it("without room on this Mac's disk the data stays on the drive and the new build opens with it", () => {
    const dir = tempDir("self-update-data");
    const { target, data, core, localData, run, openedLines } = moving(dir);
    const result = run(join(core, "self-update", "healthy"), 1024);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("not enough room for the data");
    expect(openedLines()).toEqual([`-n ${target} --env BOTLING_DATA_DIR=${data}`]);
    expect(existsSync(localData)).toBe(false);
    expect(existsSync(join(data, "MOVED-TO-LOCAL-DISK.txt"))).toBe(false);
  });

  it("a new build that does not come up: the copy is set aside, data already there put back, and the drive's build reopened with the drive's data", () => {
    const dir = tempDir("self-update-data");
    const { running, target, data, core, localData, run, openedLines } = moving(dir);
    mkdirSync(localData, { recursive: true });
    writeFileSync(join(localData, "earlier.txt"), "an earlier profile");
    const result = run(null);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(openedLines()).toEqual([`-n ${target}`, `-n ${running.path} --env BOTLING_DATA_DIR=${data}`]);
    expect(readFileSync(join(localData, "earlier.txt"), "utf8")).toBe("an earlier profile");
    const parent = join(localData, "..");
    expect(readdirSync(parent).filter((name) => name.startsWith("Botling 2 Dev Trial.failed-"))).toHaveLength(1);
    expect(readdirSync(parent).filter((name) => name.startsWith("Botling 2 Dev Trial.before-"))).toHaveLength(0);
    expect(installOutcome(core)).toMatchObject({ kind: "rolledBack" });
    expect(readFileSync(join(core, "approved-commands.json"), "utf8")).toContain(`cat ${core}/main/memory.md`);
    expect(existsSync(join(data, "MOVED-TO-LOCAL-DISK.txt"))).toBe(false);
  });
});

describe("developer work", () => {
  it("goes on the work drive when it is there, else beside the project", () => {
    const dir = tempDir("self-update");
    expect(devWorkRoot({ BOTLING_DEV_WORK_DIR: dir })).toBe(dir);
    expect(devWorkRoot({ BOTLING_DEV_WORK_DIR: join(dir, "missing") })).toBeNull();
    expect(devWorkRoot({ BOTLING_DEV_WORK_DIR: "/Volumes/No-Such-Drive-Botling/work" })).toBeNull();
    expect(devWorkRoot({}, () => false)).toBeNull();
    expect(devWorkRoot({}, () => true)).toBe("/Volumes/My-SSD/botling-work");
  });

  it("the developer briefing names the work drive's folders, or the project's own when the drive is away", () => {
    const root = tempDir("self-update");
    const onDrive = desk(root, { devWork: () => "/Volumes/Work/botling-work" });
    const text = onDrive.builds.briefing(onDrive.dev);
    expect(text).toContain("git worktree add /Volumes/Work/botling-work/<short-task> -b bot/<short-task>");
    expect(text).toContain("cd desktop && BOTLING_DIST_DIR=/Volumes/Work/botling-work/builds/dist npm run dist:dir; it is written to /Volumes/Work/botling-work/builds/dist/mac-arm64/Botling 2.app");
    const away = desk(root, { devWork: () => null });
    const local = away.builds.briefing(away.dev);
    expect(local).toContain(`git worktree add ${join(root, "repo", ".bot", "worktrees")}/<short-task>`);
    expect(local).toContain("cd desktop && npm run dist:dir; it is written to desktop/dist/mac-arm64/Botling 2.app");
  });
});

describe("<install-build> without a restart", () => {
  const hotPlan = { mode: "hot" as const, parts: ["core" as const, "chat" as const] };
  const restartPlan = { mode: "restart" as const, reasons: ["kernel changed: main process"] };

  function hotDesk(plans: unknown[]) {
    const root = tempDir("self-update");
    const asked: unknown[] = [];
    const queue = [...plans];
    const desk_ = desk(root, {
      planBuild: async () => queue.shift() as never,
      hotInstall: async (request) => { asked.push(request); return { ok: true }; },
    });
    const built = fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" });
    return { ...desk_, root, asked, built };
  }

  it("the card says the expected mode before you confirm: hot-apply and which parts, or restart and why", async () => {
    const hot = hotDesk([hotPlan]);
    await hot.builds.propose(hot.built, "Faster startup.", hot.dev);
    const card = hot.main.notices.at(-1)!;
    expect(card.text).toContain("**botling** wants to install a new Botling build without restarting.");
    expect(card.text).toContain("- Expected: hot-apply: core, chat page");
    expect(card.text).toMatch(/If the new core fails its self-check, the running one stays and the app on disk is put back\./);
    expect(card.choices!.map((choice) => choice.label)).toEqual(["Install and hot-apply", "Not now"]);
    expect(hot.dev.notes.at(-1)).toMatch(/\(hot-apply: core, chat page\)\. Nothing happens until they pick\.\)$/);

    const restart = hotDesk([restartPlan]);
    await restart.builds.propose(restart.built, "", restart.dev);
    const restartCard = restart.main.notices.at(-1)!;
    expect(restartCard.text).toContain("wants to install a new Botling build and restart.");
    expect(restartCard.text).toContain("- Expected: restart (kernel changed: main process)");
    expect(restartCard.choices!.map((choice) => choice.label)).toEqual(["Install and restart", "Not now"]);
  });

  it("Install on a hot card asks main to install in place; nothing is launched and the app does not quit", async () => {
    const hot = hotDesk([hotPlan, hotPlan]);
    await hot.builds.propose(hot.built, "Faster startup.", hot.dev);
    await hot.main.notices.at(-1)!.onPick!(0);
    expect(hot.asked).toEqual([{ path: join(hot.root, "dist", "Botling 2.app"), requester: "DEV", note: "Faster startup.", from: "2.0.1 (aaaaaaa)", to: "2.0.1 (bbbbbbb)" }]);
    expect(hot.launched).toHaveLength(0);
  });

  it("Install on a restart card restarts as before and the report afterwards says why", async () => {
    vi.useFakeTimers();
    const restart = hotDesk([restartPlan, restartPlan]);
    await restart.builds.propose(restart.built, "", restart.dev);
    await restart.main.notices.at(-1)!.onPick!(0);
    expect(restart.asked).toHaveLength(0);
    expect(restart.launched).toHaveLength(1);
    expect(installOutcome(join(restart.root, "core"))).toMatchObject({ kind: "installed", state: { mode: "restart (kernel changed: main process)" } });
    restart.builds.check(8_000);
    vi.advanceTimersByTime(8_000);
    expect(restart.main.notices.at(-1)!.text).toBe("Botling restarted on 2.0.1 (bbbbbbb) (was 2.0.1 (aaaaaaa)), installed for botling — restarted (kernel changed: main process).");
    expect(restart.dev.relays.at(-1)!.text).toMatch(/the build you asked to install — restarted \(kernel changed: main process\)\. Read your memory file/);
  });

  it("a build that changed since the card (now needs a restart) is not installed; the bot is told to ask again", async () => {
    const hot = hotDesk([hotPlan, restartPlan]);
    await hot.builds.propose(hot.built, "", hot.dev);
    await hot.main.notices.at(-1)!.onPick!(0);
    expect(hot.asked).toHaveLength(0);
    expect(hot.launched).toHaveLength(0);
    expect(hot.main.notices.at(-1)!.text).toBe("2.0.1 (bbbbbbb) changed since the card was shown (it now means restart (kernel changed: main process)), so nothing was installed. Ask again to see it.");
    expect(hot.dev.notes.at(-1)).toMatch(/Ask again with <install-build>/);
  });

  it("main's report: hot-applied parts, or a failure with the old build kept and the disk put back (or a restart required)", () => {
    const { builds, main, dev, root } = hotDesk([]);
    setFailures(join(root, "core"), 1);
    const base = { requester: "DEV", note: "Faster startup.", from: "2.0.1 (aaaaaaa)", to: "2.0.1 (bbbbbbb)" };
    builds.hotOutcome({ ...base, ok: true, applied: ["core", "chat"], disk: "installed" });
    expect(main.notices.at(-1)!.text).toBe("Botling installed 2.0.1 (bbbbbbb) (was 2.0.1 (aaaaaaa)) for botling without restarting — hot-applied: core, chat page. The kernel is unchanged; the next launch starts this build too.");
    expect(dev.relays.at(-1)!.text).toBe("(App) Botling installed 2.0.1 (bbbbbbb), the build you asked to install (Faster startup.), without restarting — hot-applied: core, chat page. Check that your change works (<app-screenshot/> shows the window), then say in one sentence whether it does.");
    expect(failures(join(root, "core"))).toBe(0);

    builds.hotOutcome({ ...base, ok: false, applied: [], disk: "restored", error: "the new core failed its self-check (it exited (1))" });
    expect(main.notices.at(-1)!.text).toBe("The new build 2.0.1 (bbbbbbb) could not be hot-applied: the new core failed its self-check (it exited (1)). 2.0.1 (aaaaaaa) keeps running. The app on disk was put back to 2.0.1 (aaaaaaa).");
    expect(dev.relays.at(-1)!.text).toMatch(/^\(App\) The build you asked to install, 2\.0\.1 \(bbbbbbb\), could not be hot-applied: the new core failed its self-check/);
    expect(failures(join(root, "core"))).toBe(1);

    builds.hotOutcome({ ...base, ok: false, applied: ["core"], disk: "stuck", error: "the new shell did not come up" });
    expect(main.notices.at(-1)!.text).toMatch(/Still running from the new build: core\. The app on disk could not be put back, so it is now the new build while the old one runs: restart required \(the next launch starts 2\.0\.1 \(bbbbbbb\)\)\. That is 2 in a row: installing is paused/);
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

describe("<app-screenshot/>", () => {
  it("the developer project gets a picture of the window; another project is told it needs developer mode", async () => {
    const root = tempDir("self-update");
    const { builds, dev, other } = desk(root);
    builds.screenshot(dev);
    await vi.waitFor(() => expect(dev.relays.at(-1)).toEqual({ text: "(App) The app's window right now.", files: [join(root, "shot.png")] }));
    builds.screenshot(other);
    expect(other.notes.at(-1)).toMatch(/need developer mode/);
    const { builds: blind, dev: dev2 } = desk(tempDir("self-update"), { captureWindow: async () => null });
    blind.screenshot(dev2);
    await vi.waitFor(() => expect(dev2.relays.at(-1)!.text).toBe("(App) Couldn't take a screenshot of the app's window."));
  });

  it("the developer project's briefing tells it how; other bots hear nothing", () => {
    const root = tempDir("self-update");
    const { builds, dev, other } = desk(root);
    expect(builds.briefing(dev)).toMatch(/<install-build path=/);
    expect(builds.briefing(dev)).toMatch(/<app-screenshot\/>/);
    expect(builds.briefing(other)).toBe("");
  });
});

void ({} as BuildInfo);
