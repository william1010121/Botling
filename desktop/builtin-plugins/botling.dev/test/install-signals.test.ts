// 2026-11-16: the install script wrote its first log line and was gone, with no word of why and nothing to open the old app
// again (63 s later the user opened it by hand). The script now logs every signal it gets, ignores a hangup, and a script that
// ends before it finished puts things back and opens the old app at once. These tests signal the real scripts.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import { installOutcome, prepareInstall, readBuild } from "../src/swap";

const BUNDLE_ID = "io.github.william1010121.Botling3";
const live: ChildProcess[] = [];
afterEach(() => { for (const child of live.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } try { child.kill("SIGKILL"); } catch { /* gone */ } } });

function fakeApp(dir: string, name: string, commit: string, executable = "Botling 3"): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleShortVersionString</key><string>3.0.1</string>
  <key>BotlingGitCommit</key><string>${commit}</string>
</dict></plist>`);
  writeFileSync(join(app, "Contents", "MacOS", executable), "#!/bin/sh\nexit 0\n");
  chmodSync(join(app, "Contents", "MacOS", executable), 0o755);
  return app;
}

/** A stand-in for botlingd (a process that lives for `seconds`). */
function botlingd(seconds: number): ChildProcess {
  const child = spawn("/bin/sleep", [String(seconds)], { detached: true, stdio: "ignore" });
  live.push(child);
  return child;
}

/** A stand-in for the old window: a process whose program is the old bundle's executable and that ignores SIGTERM. */
function stubbornWindow(app: string): ChildProcess {
  const sleepPath = spawn("/bin/sh", ["-c", "command -v sleep"], { stdio: ["ignore", "pipe", "ignore"] });
  void sleepPath;
  const bin = join(app, "Contents", "MacOS", "Botling 3");
  const child = spawn("/bin/sh", ["-c", `cp "$(command -v sleep)" "${bin}"; chmod 755 "${bin}"; trap '' TERM; exec "${bin}" 60`], { detached: true, stdio: "ignore" });
  live.push(child);
  return child;
}

function rig(dir: string, v3 = true) {
  const from = readBuild(fakeApp(join(dir, "home", "Applications"), "Botling 3", "aaaaaaa1111"))!;
  const to = readBuild(fakeApp(join(dir, "dist"), "Botling 3", "bbbbbbb2222"))!;
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const opened = join(dir, "opened.log");
  const tool = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755); return file; };
  const tools = {
    BOTLING_TEST_OPEN: tool("open", `echo "$*" >> "${opened}"\n[ -n "$MAKE_HEALTHY" ] && touch "$MAKE_HEALTHY"\nexit 0`),
    // SLOW_DITTO: the copy takes a second, as a real one does.
    BOTLING_TEST_DITTO: tool("ditto", `[ -n "$SLOW_DITTO" ] && sleep 1\ncp -R "$1" "$2"`),
    BOTLING_TEST_CODESIGN: tool("codesign", "exit 0"),
    BOTLING_TEST_XATTR: tool("xattr", "exit 0"),
  };
  const make = (pid: number) => {
    const args = prepareInstall(join(dir, "server"), from, to, "DEV", "", pid, "/data", new Date(), from.path, v3 ? "/srv" : undefined).slice(3);
    args[6] = "2";
    return args;
  };
  /** Starts the script; `signal` waits for `waitFor` in its output, then sends the signal. */
  const start = (args: string[], env: Record<string, string> = {}) => {
    const child = spawn("/bin/bash", [join(dir, "server", "self-update", "install.sh"), ...args], {
      detached: true, env: { ...process.env, ...tools, BOTLING_TEST_QUIT_WAIT: "20", BOTLING_TEST_APP_WAIT: "1", ...env },
    });
    live.push(child);
    let out = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { out += chunk; });
    const closed = new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)));
    const until = async (text: string) => { for (let i = 0; i < 200 && !out.includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 50)); expect(out).toContain(text); };
    return { child, closed, out: () => out, until };
  };
  const openedLines = () => (existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : []);
  return { from, to, make, start, openedLines, server: join(dir, "server") };
}

describe("the Botling 3 install script is not ended unseen", () => {
  it("a SIGTERM while it waits for the old app to quit is logged, and the old app is opened again at once", async () => {
    const dir = tempDir("install-signals");
    const r = rig(dir);
    const window = stubbornWindow(r.from.path);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(window.exitCode).toBeNull();
    const script = r.start(r.make(botlingd(0).pid!), { BOTLING_TEST_APP_WAIT: "20" });
    await script.until("waiting for the old app to quit");
    await script.until("still running from");
    process.kill(script.child.pid!, "SIGTERM");
    await script.closed;
    const out = script.out();
    expect(out).toContain("got SIGTERM at step: waiting for the old app to quit");
    expect(out).toContain("opening the old app again");
    expect(r.openedLines()).toEqual([`-n ${r.from.path} --env BOTLING_DATA_DIR=/data --env BOTLING_SERVER_DATA_DIR=/srv`]);
    expect(readBuild(r.from.path)?.commit).toBe("aaaaaaa1111");
    expect(installOutcome(r.server)).toMatchObject({ kind: "rolledBack", reason: "the install script ended early at step: waiting for the old app to quit" });
  });

  it("a SIGTERM while botlingd is still stopping is logged; the old app is not opened over it", async () => {
    const dir = tempDir("install-signals");
    const r = rig(dir);
    const script = r.start(r.make(botlingd(30).pid!));
    await script.until("waiting for botlingd");
    process.kill(script.child.pid!, "SIGTERM");
    await script.closed;
    expect(script.out()).toContain("got SIGTERM at step: waiting for botlingd to stop");
    expect(script.out()).toContain("is still stopping; the old app is not opened over it");
    expect(r.openedLines()).toEqual([]);
    expect(installOutcome(r.server)).toMatchObject({ kind: "rolledBack" });
  });

  it("a hangup is ignored and logged: the install goes on and finishes", async () => {
    const dir = tempDir("install-signals");
    const r = rig(dir);
    const args = r.make(botlingd(2).pid!);
    const script = r.start(args, { MAKE_HEALTHY: args[4]! });
    await script.until("waiting for botlingd");
    process.kill(script.child.pid!, "SIGHUP");
    expect(await script.closed).toBe(0);
    expect(script.out()).toContain("got SIGHUP (ignored) at step: waiting for botlingd to stop");
    expect(script.out()).toContain("the new build is up");
    expect(readBuild(r.from.path)?.commit).toBe("bbbbbbb2222");
  });

  it("a SIGTERM during the copy puts the old app back, never deletes it, and opens it again", async () => {
    const dir = tempDir("install-signals");
    const r = rig(dir);
    const args = r.make(botlingd(0).pid!);
    const script = r.start(args, { SLOW_DITTO: "1", MAKE_HEALTHY: join(dir, "never") });
    await script.until("copying the new build");
    process.kill(script.child.pid!, "SIGTERM");
    await script.closed;
    expect(script.out()).toContain("got SIGTERM at step: copying the new build");
    expect(script.out()).toContain("putting the old app back");
    expect(readBuild(r.from.path)?.commit).toBe("aaaaaaa1111");
    expect(r.openedLines()).toEqual([`-n ${r.from.path} --env BOTLING_DATA_DIR=/data --env BOTLING_SERVER_DATA_DIR=/srv`]);
    expect(installOutcome(r.server)).toMatchObject({ kind: "rolledBack", reason: "the install script ended early at step: copying the new build" });
  });

  it("a signal before the old app was moved never touches it", async () => {
    const dir = tempDir("install-signals");
    const r = rig(dir);
    const script = r.start(r.make(botlingd(30).pid!));
    await script.until("waiting for botlingd");
    process.kill(script.child.pid!, "SIGINT");
    await script.closed;
    expect(readBuild(r.from.path)?.commit).toBe("aaaaaaa1111");
    expect(existsSync(join(r.server, "self-update", "backups"))).toBe(true);
  });
});

describe("the Botling 2 install script is not ended unseen either", () => {
  it("a SIGTERM is logged and a hangup is ignored", async () => {
    const dir = tempDir("install-signals-2");
    const r = rig(dir, false);
    const script = r.start(r.make(botlingd(30).pid!));
    await script.until("waiting for Botling 2");
    process.kill(script.child.pid!, "SIGHUP");
    await script.until("got SIGHUP (ignored) at step: waiting for Botling 2 to quit");
    process.kill(script.child.pid!, "SIGTERM");
    await script.closed;
    expect(script.out()).toContain("got SIGTERM at step: waiting for Botling 2 to quit");
    expect(script.out()).toContain("is still quitting; the old app is not opened over it");
    expect(readBuild(r.from.path)?.commit).toBe("aaaaaaa1111");
  });
});
