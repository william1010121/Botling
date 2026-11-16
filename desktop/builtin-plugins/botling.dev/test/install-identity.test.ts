// An install must be judged by the build that is really running, not by what the install asked for (2026-11-16: the
// script died after its first log line, the old app was opened again, its core wrote `healthy` because state.json was
// still there, and the old build told the bot "Botling restarted on <the requested build>" while ~/Applications still
// held the old app). These tests pin: (b) the report names the running bundle and says when nothing was installed;
// (a) the script does not take a stale `healthy` for the new build and leaves its pid for the next start to check.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import { DevBuilds, type DeskBot } from "../src/desk";
import { installOutcome, prepareInstall, readBuild, type BuildInfo } from "../src/swap";

const BUNDLE_ID = "io.github.william1010121.Botling3";

function fakeApp(dir: string, name: string, info: Record<string, string> = {}, asarSeconds = 1_800_000_000): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  const all = { CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: "Botling 3", CFBundleShortVersionString: "3.0.1", ...info };
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${Object.entries(all).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join("\n")}
</dict></plist>`);
  writeFileSync(join(app, "Contents", "MacOS", all.CFBundleExecutable), "#!/bin/sh\nexit 0\n");
  chmodSync(join(app, "Contents", "MacOS", all.CFBundleExecutable), 0o755);
  writeFileSync(join(app, "Contents", "Resources", "app.asar"), `asar ${asarSeconds}`);
  utimesSync(join(app, "Contents", "Resources", "app.asar"), asarSeconds, asarSeconds);
  return app;
}

class FakeBot implements DeskBot {
  notices: string[] = [];
  relays: string[] = [];
  notes: string[] = [];
  constructor(readonly id: string, readonly profile: { name: string; folder: string }) {}
  appNotice(text: string) { this.notices.push(text); return "n"; }
  relay(text: string) { this.relays.push(text); return {}; }
  queueNote(note: string) { this.notes.push(note); }
}

/** A Botling 3 desk whose running bundle can be swapped, as the bundle on disk is by a real install. */
function rig(root: string, first: BuildInfo | null) {
  let current = first;
  const main = new FakeBot("MAIN", { name: "Main bot", folder: join(root, "main") });
  const dev = new FakeBot("DEV", { name: "botling", folder: join(root, "repo") });
  const builds = new DevBuilds({
    root: join(root, "server"), runningBuild: () => current, developer: () => dev, mainBot: () => main,
    bot: (id) => [main, dev].find((bot) => bot.id === id) ?? null,
    appPid: 5151, appDataDir: join(root, "data"), serverDir: join(root, "server"),
    launchInstaller: () => {}, captureWindow: async () => null, log: () => {},
  });
  return { builds, main, dev, setRunning: (build: BuildInfo | null) => { current = build; } };
}

const folder = (root: string) => join(root, "server", "self-update");
const server = (root: string) => join(root, "server");

const scripts: ChildProcess[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const child of scripts.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
});

describe("an install is judged by the build that is running", () => {
  function setup(extraFrom: Record<string, string> = { BotlingGitCommit: "aaaaaaa1111" }, extraTo: Record<string, string> = { BotlingGitCommit: "bbbbbbb2222" }, fromAsar = 1_800_000_000, toAsar = 1_800_100_000) {
    vi.useFakeTimers();
    const root = tempDir("install-identity");
    const from = readBuild(fakeApp(join(root, "Applications"), "Botling 3", extraFrom, fromAsar))!;
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 3", extraTo, toAsar))!;
    prepareInstall(server(root), from, to, "DEV", "Faster startup.", 5151, "", new Date(), from.path, server(root));
    return { root, from, to, ...rig(root, from) };
  }
  const settle = () => vi.advanceTimersByTime(60_000);

  it("the old build that comes back after the script died says nothing was installed, not that it restarted on the new build", () => {
    const { root, from, to, builds, main, dev } = setup();
    mkdirSync(folder(root), { recursive: true });
    writeFileSync(join(folder(root), "install.log"), "2026-11-16 13:38:15 waiting for botlingd (72534) to stop; it stops once the Botling 3 window quit\n");
    // What happened: no rolled-back marker, and the old build's core wrote `healthy` because state.json was still there.
    writeFileSync(join(folder(root), "healthy"), "ok\n");
    expect(builds.check(8_000)).not.toBeNull();
    settle();
    const told = main.notices.at(-1)!;
    expect(told).not.toMatch(/restarted on/);
    expect(told).toMatch(/not installed/i);
    expect(told).toContain("3.0.1 (aaaaaaa)");
    expect(told).toContain("3.0.1 (bbbbbbb)");
    expect(told).toContain("waiting for botlingd (72534)");
    expect(dev.relays.at(-1)!).not.toMatch(/restarted on/);
    expect(dev.relays.at(-1)!).toMatch(/still running/);
    expect(dev.relays.at(-1)!).toContain(to.path);
    // Told once; the state is done with, and the next start does not tell again.
    expect(installOutcome(server(root))).toBeNull();
    expect(from.path).not.toBe(to.path);
  });

  it("a build that is neither the old one nor the requested one is named as it is", () => {
    const { root, builds, main, dev, setRunning } = setup();
    setRunning(readBuild(fakeApp(join(root, "else"), "Botling 3", { BotlingGitCommit: "ccccccc3333" }))!);
    writeFileSync(join(folder(root), "healthy"), "ok\n");
    builds.check(8_000);
    settle();
    expect(main.notices.at(-1)!).not.toMatch(/restarted on/);
    expect(main.notices.at(-1)!).toContain("3.0.1 (ccccccc)");
    expect(dev.relays.at(-1)!).toContain("3.0.1 (ccccccc)");
  });

  it("the new build that really came up is reported with the label read from the running bundle", () => {
    const { root, to, builds, main, dev, setRunning } = setup();
    // The copy on disk is the new build; its Info.plist, not the request, says what it is.
    const copy = readBuild(fakeApp(join(root, "Installed"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222", CFBundleShortVersionString: "3.0.1" }, 1_800_100_000))!;
    setRunning(copy);
    writeFileSync(join(folder(root), "healthy"), "ok\n");
    builds.check(8_000);
    settle();
    expect(main.notices.at(-1)!).toBe("Botling restarted on 3.0.1 (bbbbbbb) (was 3.0.1 (aaaaaaa)), installed for botling.");
    expect(dev.relays.at(-1)!).toMatch(/^\(App\) Botling restarted on 3\.0\.1 \(bbbbbbb\), the build you asked to install/);
    expect(installOutcome(server(root))).toBeNull();
    expect(to.commit).toBe("bbbbbbb2222");
  });

  it("two builds of one commit (dirty rebuilds) are told apart by when they were built", () => {
    const same = { BotlingGitCommit: "c1b17be20025", BotlingGitDirty: "1" };
    const { root, from, to, builds, main, setRunning } = setup(same, same, 1_800_000_000, 1_800_100_000);
    expect((from as { builtAt?: number | null }).builtAt).toBeTypeOf("number");
    expect((to as { builtAt?: number | null }).builtAt).toBeGreaterThan((from as { builtAt?: number }).builtAt!);
    writeFileSync(join(folder(root), "healthy"), "ok\n");
    builds.check(8_000);
    settle();
    expect(main.notices.at(-1)!).toMatch(/not installed/i);
    expect(main.notices.at(-1)!).not.toMatch(/restarted on/);
    void setRunning;
  });

  it("while the install script is still alive the old build decides nothing; once it is gone, it reports", () => {
    const { root, builds, main } = setup();
    // A real process whose command line names install.sh (the check must not take any live pid for the script).
    const script = spawn("/bin/bash", ["-c", "sleep 30; true", "install.sh"], { stdio: "ignore", detached: true });
    scripts.push(script);
    writeFileSync(join(folder(root), "script.pid"), `${script.pid}\n`);
    writeFileSync(join(folder(root), "healthy"), "ok\n");
    builds.check(8_000);
    settle();
    expect(main.notices).toHaveLength(0);
    expect(installOutcome(server(root))).toMatchObject({ kind: "installed" });
    // A script that died (its pid is gone): the next look reports it.
    process.kill(-script.pid!, "SIGKILL");
    spawnSync("/bin/sleep", ["0.2"]);
    // A pid that another program took over is no script either.
    writeFileSync(join(folder(root), "script.pid"), `${process.pid}\n`);
    vi.advanceTimersByTime(60_000);
    expect(main.notices.at(-1)!).toMatch(/not installed/i);
  });

  it("2.x style (no window gate): the old build coming back is also reported as not installed", () => {
    vi.useFakeTimers();
    const root = tempDir("install-identity");
    const from = readBuild(fakeApp(join(root, "Applications"), "Botling 3", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" }))!;
    const main = new FakeBot("MAIN", { name: "Main bot", folder: "" });
    const dev = new FakeBot("DEV", { name: "botling", folder: "" });
    const builds = new DevBuilds({
      root: join(root, "core"), runningBuild: () => from, developer: () => dev, mainBot: () => main, bot: () => dev,
      appPid: 1, appDataDir: null, launchInstaller: () => {}, captureWindow: async () => null, log: () => {},
    });
    prepareInstall(join(root, "core"), from, to, "DEV", "", 1, "");
    builds.check(8_000);
    vi.advanceTimersByTime(8_000);
    expect(main.notices.at(-1)!).not.toMatch(/restarted on/);
    expect(main.notices.at(-1)!).toMatch(/not installed/i);
  });
});

describe("the Botling 3 install script keeps what the next start needs", () => {
  /** The script with fake macOS tools (as swap-v3.test.ts), enough to follow one run to its end. */
  function run(dir: string, args: string[], env: Record<string, string> = {}) {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const tool = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755); return file; };
    const opened = join(dir, "opened.log");
    const tools = {
      BOTLING_TEST_OPEN: tool("open", `echo "$*" >> "${opened}"; exit 0`),
      BOTLING_TEST_DITTO: tool("ditto", `cp -R "$1" "$2"`),
      BOTLING_TEST_CODESIGN: tool("codesign", "exit 0"),
      BOTLING_TEST_XATTR: tool("xattr", "exit 0"),
    };
    return new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn("/bin/bash", [join(dir, "server", "self-update", "install.sh"), ...args], { env: { ...process.env, ...tools, BOTLING_TEST_QUIT_WAIT: "5", BOTLING_TEST_APP_WAIT: "1", ...env } });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      child.on("close", (status) => resolve({ status, out }));
    });
  }

  function prepare(dir: string) {
    const from = readBuild(fakeApp(join(dir, "home", "Applications"), "Botling 3", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const to = readBuild(fakeApp(join(dir, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" }))!;
    const gone = spawnSync("/usr/bin/true").pid!;
    const args = prepareInstall(join(dir, "server"), from, to, "DEV", "", gone, "/data", new Date(), from.path, "/srv").slice(3);
    args[6] = "2";
    return { from, to, args };
  }

  it("a `healthy` left from before is not taken for the new build: the script waits for its own, then rolls back", async () => {
    const dir = tempDir("install-identity-script");
    const { from, args } = prepare(dir);
    // The old build, started again by hand while the script waited, wrote it.
    writeFileSync(args[4]!, "ok\n");
    const result = await run(dir, args);
    expect(result.status, result.out).toBe(1);
    expect(result.out).not.toContain("the new build is up");
    expect(readBuild(from.path)?.commit).toBe("aaaaaaa1111");
    expect(installOutcome(join(dir, "server"))).toMatchObject({ kind: "rolledBack", reason: "the new build did not come up in 2 seconds" });
  });

  it("writes its pid before it waits, and says which step it is at", async () => {
    const dir = tempDir("install-identity-script");
    const { args } = prepare(dir);
    const result = await run(dir, args, { MAKE_HEALTHY: "" });
    expect(existsSync(join(dir, "server", "self-update", "script.pid"))).toBe(true);
    expect(readFileSync(join(dir, "server", "self-update", "script.pid"), "utf8").trim()).toMatch(/^[0-9]+$/);
    expect(result.out).toMatch(/botlingd .* stopped/);
    expect(result.out).toMatch(/copying the new build/);
  });
});

describe("a script that ended early is not a build that failed to come up", () => {
  it("does not count towards pausing installs, and says what the old build is", () => {
    vi.useFakeTimers();
    const root = tempDir("install-identity");
    const from = readBuild(fakeApp(join(root, "Applications"), "Botling 3", { BotlingGitCommit: "aaaaaaa1111" }))!;
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222" }))!;
    const { builds, main } = rig(root, from);
    for (let i = 0; i < 3; i++) {
      prepareInstall(server(root), from, to, "DEV", "", 5151, "", new Date(), from.path, server(root));
      writeFileSync(join(folder(root), "rolled-back"), "the install script ended early at step: waiting for the old app to quit\n");
      builds.check(8_000);
    }
    expect(main.notices.at(-1)!).toContain("the install script ended early at step: waiting for the old app to quit");
    expect(main.notices.at(-1)!).not.toMatch(/installing is paused/);
    expect(existsSync(join(folder(root), "failures")) ? readFileSync(join(folder(root), "failures"), "utf8").trim() : "0").toBe("0");
  });
});
