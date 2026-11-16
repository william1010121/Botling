// Installing a Botling 3 build (`<install-build path="…/Botling 3.app">`): the same card and handshake as 2.x, but the
// app is the window plus botlingd, which runs the core (and this plugin). The script waits for botlingd to stop (it stops
// itself once the window quit), ends whatever still runs from the old bundle, swaps the app (the old one kept to roll back),
// checks its signature, opens it, and puts the old one back when the new one does not come up.
// The script tests run the real script with fake open/ditto/codesign/xattr, so they run on Linux too; the "app" is a copy
// of `sleep`, so its processes show the bundle's path as their program like a real window or botlingd.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import { DevBuilds, type DeskBot } from "../src/desk";
import {
  HEALTH_WAIT_S_V3, INSTALL_SCRIPT, INSTALL_SCRIPT_V3, installOutcome, prepareInstall, readBuild, type BuildInfo,
} from "../src/swap";

const BUNDLE_ID = "io.github.william1010121.Botling3";
const SLEEP = execFileSync("/bin/sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();

function fakeApp(dir: string, name: string, info: Record<string, string> = {}): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const all = { CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: "Botling 3", CFBundleShortVersionString: "3.0.1", ...info };
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${Object.entries(all).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join("\n")}
</dict></plist>`);
  copyFileSync(SLEEP, join(app, "Contents", "MacOS", all.CFBundleExecutable));
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
  const running = readBuild(fakeApp(join(root, "Applications"), "Botling 3", { BotlingGitCommit: "aaaaaaa1111" }));
  // What runs now: after an install it is the new build (the test says so with setRunning).
  let current = running;
  const launched: string[][] = [];
  const builds = new DevBuilds({
    root: join(root, "server"), runningBuild: () => current, developer: () => dev, mainBot: () => main,
    bot: (id) => [main, dev].find((bot) => bot.id === id) ?? null,
    appPid: 5151, appDataDir: join(root, "data"), serverDir: join(root, "server"),
    launchInstaller: (command) => { launched.push(command); },
    captureWindow: async () => null,
    log: () => {},
    ...over,
  });
  return { builds, main, dev, running: running!, launched, setRunning: (build: BuildInfo | null) => { current = build; } };
}

const children: ChildProcess[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } try { child.kill("SIGKILL"); } catch { /* gone */ } }
});

describe("a Botling 3 install", () => {
  it("writes the Botling 3 script: botlingd's pid first, the server's data folder last (thirteen words)", () => {
    const dir = tempDir("self-update-v3");
    const from = readBuild(fakeApp(join(dir, "a"), "Botling 3"))!;
    const to = readBuild(fakeApp(join(dir, "b"), "Botling 3"))!;
    mkdirSync(join(dir, "srv"));
    const command = prepareInstall(join(dir, "server"), from, to, "DEV", "faster", 5151, "/data", new Date(), from.path, join(dir, "srv"));
    expect(command).toHaveLength(13);
    expect(command.slice(0, 3)).toEqual(["/usr/bin/nohup", "/bin/bash", join(dir, "server", "self-update", "install.sh")]);
    expect(command.slice(3)).toEqual([
      "5151", from.path, to.path, expect.stringMatching(/backups\/Botling-3-3\.0\.1-.*\.app$/), join(dir, "server", "self-update", "healthy"),
      join(dir, "server", "self-update", "rolled-back"), String(HEALTH_WAIT_S_V3), "/data", from.path, join(dir, "srv"),
    ]);
    expect(readFileSync(command[2]!, "utf8")).toBe(INSTALL_SCRIPT_V3);
    expect(INSTALL_SCRIPT_V3).not.toBe(INSTALL_SCRIPT);
    expect(spawnSync("/bin/bash", ["-n", command[2]!]).status).toBe(0);
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "installed", state: { requesterID: "DEV", note: "faster" } });
    // Without the server's folder it is the 2.x script, as before.
    expect(prepareInstall(join(dir, "core"), from, to, "DEV", "", 1, "/data")).toHaveLength(12);
    expect(readFileSync(join(dir, "core", "self-update", "install.sh"), "utf8")).toBe(INSTALL_SCRIPT);
  });

  it("the card says the window and botlingd stop; another app is \"not Botling 3\"; a pick starts the Botling 3 script", async () => {
    const root = tempDir("self-update-v3");
    const { builds, main, dev, running, launched } = desk(root);
    builds.propose(fakeApp(root, "Other", { CFBundleIdentifier: "com.example.other" }), "", dev);
    expect(main.notices.at(-1)!.text).toMatch(/is not Botling 3 \(com\.example\.other\)/);
    const built = fakeApp(join(root, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" });
    builds.propose(built, "Faster startup.", dev);
    const card = main.notices.at(-1)!;
    expect(card.text).toContain(`Installed in place: ${running.path}`);
    expect(card.text).toContain("The Botling 3 window and botlingd stop for it");
    expect(card.text).toContain(`within ${HEALTH_WAIT_S_V3} seconds`);
    card.onPick!(0);
    await vi.waitFor(() => expect(launched).toHaveLength(1));
    expect(launched[0]).toHaveLength(13);
    expect(launched[0]!.slice(3, 6)).toEqual(["5151", running.path, readBuild(built)!.path]);
    expect(launched[0]!.at(-1)).toBe(join(root, "server"));
  });

  it("after the restart the asker hears it only once `healthy` is there (a window attached); without it nothing is said", () => {
    vi.useFakeTimers();
    const root = tempDir("self-update-v3");
    const { builds, main, dev, running, setRunning } = desk(root);
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" }))!;
    prepareInstall(join(root, "server"), running, to, "DEV", "Faster startup.", 1, "", new Date(), running.path, join(root, "server"));
    setRunning(to);
    expect(builds.check(8_000)).not.toBeNull();
    vi.advanceTimersByTime(20_000);
    expect(main.notices).toHaveLength(0);
    expect(installOutcome(join(root, "server"))).toMatchObject({ kind: "installed" });
    writeFileSync(join(root, "server", "self-update", "healthy"), "ok\n");
    vi.advanceTimersByTime(1_000);
    expect(main.notices.at(-1)!.text).toBe("Botling restarted on 3.0.1 (bbbbbbb) (was 3.0.1 (aaaaaaa)), installed for botling.");
    expect(dev.relays.at(-1)!.text).toMatch(/^\(App\) Botling restarted on 3\.0\.1 \(bbbbbbb\)/);
    expect(installOutcome(join(root, "server"))).toBeNull();

    // A build whose window never attaches: the asker is not told it is up (the script rolls it back; the old build tells).
    const root2 = tempDir("self-update-v3");
    const again = desk(root2);
    prepareInstall(join(root2, "server"), again.running, to, "DEV", "", 1, "", new Date(), again.running.path, join(root2, "server"));
    again.setRunning(to);
    again.builds.check(8_000);
    vi.advanceTimersByTime((HEALTH_WAIT_S_V3 + 60) * 1_000);
    expect(again.main.notices).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the rolled-back relay names the failed copy beside the app as Botling 3.app.failed", () => {
    const root = tempDir("self-update-v3");
    const { builds, dev, running } = desk(root);
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" }))!;
    prepareInstall(join(root, "server"), running, to, "DEV", "", 1, "", new Date(), running.path, join(root, "server"));
    writeFileSync(join(root, "server", "self-update", "rolled-back"), "the new build did not come up in 120 seconds\n");
    builds.check();
    expect(dev.relays.at(-1)!.text).toMatch(/kept beside the app as Botling 3\.app\.failed\./);
  });

  it("the developer briefing builds Botling 3 (--v3) and installs that Botling 3.app", () => {
    const root = tempDir("self-update-v3");
    const { builds, dev } = desk(root, { devWork: () => "/Volumes/Work/botling-work" });
    const text = builds.briefing(dev);
    expect(text).toContain("the app you are running in (Botling 3 is in desktop/");
    expect(text).toContain("cd desktop && BOTLING_DIST_DIR=/Volumes/Work/botling-work/builds/dist npm run dist:dir -- --v3; it is written to /Volumes/Work/botling-work/builds/dist/v3/mac-arm64/Botling 3.app");
    expect(text).toContain("<install-build path=\"full path of that Botling 3.app\">");
  });
});

/** The Botling 3 script with fake macOS tools; resolves with its exit status and output (async: this process keeps reaping). */
function scriptRig(dir: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const opened = join(dir, "opened.log");
  const signed = join(dir, "codesign.log");
  const started = join(dir, "started.pid");
  const copiedWhile = join(dir, "copied-while");
  const signedWhile = join(dir, "signed-while");
  const tool = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755); return file; };
  const tools = {
    // open -n <bundle> [--env K=V]…: record it; MAKE_HEALTHY: the new build says it is up; START_APP: a window runs from it.
    BOTLING_TEST_OPEN: tool("open", `echo "$*" >> "${opened}"
[ -n "$MAKE_HEALTHY" ] && touch "$MAKE_HEALTHY"
if [ -n "$START_APP" ] && [ ! -e "${started}" ]; then nohup "$2/Contents/MacOS/Botling 3" 60 >/dev/null 2>&1 & echo $! > "${started}"; fi
exit 0`),
    // DITTO_FAIL: a copy that stops halfway (part of the bundle written, then an error).
    BOTLING_TEST_DITTO: tool("ditto", `if [ -n "$BOTLINGD_PID" ]; then kill -0 "$BOTLINGD_PID" 2>/dev/null && echo running > "${copiedWhile}" || echo stopped > "${copiedWhile}"; fi
if [ -n "$DITTO_FAIL" ]; then mkdir -p "$2/Contents"; echo partial > "$2/Contents/half"; exit 1; fi
cp -R "$1" "$2"`),
    BOTLING_TEST_CODESIGN: tool("codesign", `echo "$*" >> "${signed}"
if [ -n "$BOTLINGD_PID" ]; then kill -0 "$BOTLINGD_PID" 2>/dev/null && echo running > "${signedWhile}" || echo stopped > "${signedWhile}"; fi
exit "\${CODESIGN_EXIT:-0}"`),
    BOTLING_TEST_XATTR: tool("xattr", "exit 0"),
  };
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn("/bin/bash", [join(dir, "server", "self-update", "install.sh"), ...args], {
      env: { ...process.env, ...tools, BOTLING_TEST_QUIT_WAIT: "5", BOTLING_TEST_APP_WAIT: "1", ...env },
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (status) => resolve({ status, out }));
  });
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);
  return {
    run, opened: () => lines(opened), signed: () => lines(signed), started: () => Number(lines(started)[0]),
    /** Whether botlingd (BOTLINGD_PID) was still running when the fake ditto / codesign ran. */
    copiedWhile: () => lines(copiedWhile)[0], signedWhile: () => lines(signedWhile)[0],
  };
}

/** A stand-in process (detached, own group so the test can end it). */
function standIn(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  children.push(child);
  return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe("the Botling 3 install script", () => {
  function prepare(dir: string, serverDir = "/srv") {
    const running = readBuild(fakeApp(join(dir, "home", "Applications"), "Botling 3", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const build = readBuild(fakeApp(join(dir, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" }))!;
    return { running, build, serverDir, command: (pid: number, seconds: string) => {
      const args = prepareInstall(join(dir, "server"), running, build, "DEV", "", pid, "/data", new Date(), running.path, serverDir).slice(3);
      args[6] = seconds;
      return args;
    } };
  }

  it("waits for botlingd, ends the window still running from the old app, swaps (old one kept), checks the signature and opens the new one", async () => {
    const dir = tempDir("self-update-v3-script");
    const { running, command } = prepare(dir);
    const rig = scriptRig(dir);
    const botlingd = standIn(SLEEP, ["1"]);
    const oldWindow = standIn(join(running.path, "Contents", "MacOS", "Botling 3"), ["60"]);
    const args = command(botlingd.pid!, "3");
    const result = await rig.run(args, { MAKE_HEALTHY: args[4]! });
    expect(result.status, result.out).toBe(0);
    expect(exited(botlingd)).toBe(true);
    await vi.waitFor(() => expect(exited(oldWindow)).toBe(true));
    expect(readBuild(running.path)?.commit).toBe("bbbbbbb2222");
    expect(readBuild(args[3]!)?.commit).toBe("aaaaaaa1111");
    // The copy is checked where it was staged (beside the target), before the old app was moved aside.
    expect(rig.signed()).toEqual([`--verify ${running.path}.staging`]);
    expect(existsSync(`${running.path}.staging`)).toBe(false);
    expect(rig.opened()).toEqual([`-n ${running.path} --env BOTLING_DATA_DIR=/data --env BOTLING_SERVER_DATA_DIR=/srv`]);
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "installed" });
  });

  it("copies and checks the new build while botlingd is still stopping, so the swap after it is two renames", async () => {
    const dir = tempDir("self-update-v3-script");
    const { running, command } = prepare(dir);
    const rig = scriptRig(dir);
    const botlingd = standIn(SLEEP, ["3"]);
    const args = command(botlingd.pid!, "3");
    const result = await rig.run(args, { MAKE_HEALTHY: args[4]!, BOTLINGD_PID: String(botlingd.pid) });
    expect(result.status, result.out).toBe(0);
    // The fake ditto and codesign noted whether botlingd was still running when they ran.
    expect(rig.copiedWhile()).toBe("running");
    expect(rig.signedWhile()).toBe("running");
    const at = (text: string) => result.out.indexOf(text);
    expect(at("the new build is copied")).toBeGreaterThan(-1);
    expect(at("the new build is copied")).toBeLessThan(at("moving "));
    expect(at("moving ")).toBeLessThan(at("opening the new build"));
  });

  it("a new build that does not come up is ended, set aside as .failed, the old one put back and reopened", async () => {
    const dir = tempDir("self-update-v3-script");
    const { running, command } = prepare(dir, "/data/server");
    const rig = scriptRig(dir);
    const result = await rig.run(command(standIn(SLEEP, ["0"]).pid!, "2"), { START_APP: "1" });
    expect(result.status, result.out).toBe(1);
    const newWindow = rig.started();
    expect(newWindow).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(newWindow)).toBe(false));
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(readFileSync(join(`${running.path}.failed`, "Contents", "Info.plist"), "utf8")).toContain("bbbbbbb2222");
    // The server folder is the app data folder's own (the default): no override.
    expect(rig.opened()).toEqual([`-n ${running.path} --env BOTLING_DATA_DIR=/data`, `-n ${running.path} --env BOTLING_DATA_DIR=/data`]);
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "rolledBack", reason: "the new build did not come up in 2 seconds" });
  });

  it("a copy whose signature does not check out is removed and the old app put back; the new one is never opened", async () => {
    const dir = tempDir("self-update-v3-script");
    const { running, build, command } = prepare(dir);
    const rig = scriptRig(dir);
    const result = await rig.run(command(standIn(SLEEP, ["0"]).pid!, "2"), { CODESIGN_EXIT: "1", MAKE_HEALTHY: join(dir, "never") });
    expect(result.status, result.out).toBe(1);
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(readBuild(build.path)?.commit).toBe("bbbbbbb2222");
    expect(existsSync(`${running.path}.failed`)).toBe(false);
    expect(existsSync(`${running.path}.staging`)).toBe(false);
    expect(rig.opened()).toEqual([`-n ${running.path} --env BOTLING_DATA_DIR=/data --env BOTLING_SERVER_DATA_DIR=/srv`]);
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "rolledBack", reason: "the copied build's signature does not check out" });
  });

  it("a copy that fails halfway is removed and the old app put back; the new one is never opened or signed", async () => {
    const dir = tempDir("self-update-v3-script");
    const { running, build, command } = prepare(dir);
    const rig = scriptRig(dir);
    const args = command(standIn(SLEEP, ["0"]).pid!, "2");
    const result = await rig.run(args, { DITTO_FAIL: "1", MAKE_HEALTHY: join(dir, "never") });
    expect(result.status, result.out).toBe(1);
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(existsSync(join(running.path, "Contents", "half"))).toBe(false);
    expect(existsSync(`${running.path}.staging`)).toBe(false);
    expect(existsSync(args[3]!)).toBe(false);
    expect(readBuild(build.path)?.commit).toBe("bbbbbbb2222");
    expect(rig.signed()).toEqual([]);
    expect(rig.opened()).toEqual([`-n ${running.path} --env BOTLING_DATA_DIR=/data --env BOTLING_SERVER_DATA_DIR=/srv`]);
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "rolledBack", reason: "could not copy the new build" });
  });

  it("a botlingd that does not stop (not even on SIGTERM) changes nothing; the old window is opened again", async () => {
    const dir = tempDir("self-update-v3-script");
    const { running, command } = prepare(dir);
    const rig = scriptRig(dir);
    const stuck = standIn("/bin/sh", ["-c", `trap '' TERM; ${SLEEP} 20`]);
    const args = command(stuck.pid!, "2");
    const result = await rig.run(args, { BOTLING_TEST_QUIT_WAIT: "1", MAKE_HEALTHY: args[4]! });
    expect(result.status, result.out).toBe(1);
    expect(exited(stuck)).toBe(false);
    expect(readBuild(running.path)?.commit).toBe("aaaaaaa1111");
    expect(existsSync(args[3]!)).toBe(false);
    // The copy was made and checked while botlingd was stopping; nothing was installed, so it is removed again.
    expect(rig.signed()).toEqual([`--verify ${running.path}.staging`]);
    expect(existsSync(`${running.path}.staging`)).toBe(false);
    expect(rig.opened()).toEqual([`-n ${running.path} --env BOTLING_DATA_DIR=/data --env BOTLING_SERVER_DATA_DIR=/srv`]);
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "rolledBack", reason: "botlingd did not stop; nothing changed" });
  });
});

void ({} as BuildInfo);
