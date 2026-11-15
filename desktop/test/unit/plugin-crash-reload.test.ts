// Botling 3 M5-18c (+ M5-18b review R4): per-plugin crash blame, real module reload,
// bounded restarts when a separate host dies with nothing in flight, and 10-process RSS measurement.
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Plugins } from "../../src/core/plugins";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { SealedSecretStore, testSealer } from "../../src/core/plugins/secrets";
import { WorkspaceSource } from "../../src/core/workspace";
import { testRoot } from "../botlingd-harness";
import { alive, desktop, sleep, until } from "../helpers";

const FIXTURES = join(desktop, "test", "fixtures", "separate-hosts");

function copyFixture(fixtureName: string, targetRoot: string, targetName = fixtureName): string {
  const dest = join(targetRoot, targetName);
  cpSync(join(FIXTURES, fixtureName), dest, { recursive: true });
  return dest;
}

function emptyWorkspace(): WorkspaceSource {
  return {
    bots: () => [],
    memory: () => ({ currentStatus: [], inProgress: [], waitingOnYou: [], decided: [], raw: "", updatedAt: null }),
    tasks: () => [],
    taskHistory: () => [],
    results: () => [],
    waiting: () => ({ items: [], doing: {} }),
    ignoreWaiting: () => {},
    pendingApprovals: () => [],
    face: () => "",
  };
}

function writeInlinePlugin(
  pluginsRoot: string,
  name: string,
  commands: { id: string; title: string }[],
  hostSource: string,
  options: { web?: boolean } = {},
) {
  const dir = join(pluginsRoot, name);
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: {
        ...(options.web ? { web: "lib/web.js" } : {}),
        host: "lib/host.mjs",
        contributes: { commands },
      },
    }),
  );
  if (options.web) writeFileSync(join(dir, "lib", "web.js"), "export function activate() {}\n");
  writeFileSync(join(dir, "lib", "host.mjs"), hostSource);
  return dir;
}

function psRssBytes(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const kb = Number(out.split(/\s+/)[0]);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

describe("M5-18c: per-plugin crash blame, real reload, and R4 bounded restarts", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  function makeRoot(prefix = "crash-reload"): string {
    const root = testRoot(prefix);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  function createUnit(options: {
    builtIns?: string | null;
    separateHosts?: boolean;
    mayRunServerPart?: (name: string, codeHash: string) => boolean;
    restartDelay?: number;
  } = {}) {
    const root = makeRoot("m5-18c");
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "plugins"), { recursive: true });
    const builtIns = options.builtIns === undefined ? join(root, "builtins") : options.builtIns;
    if (builtIns) mkdirSync(builtIns, { recursive: true });

    const alivePids = new Set<number>();
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const notices: string[] = [];
    const broken: { plugin: string; problem: string }[] = [];

    const plugins = new Plugins({
      dataDir,
      node: { command: process.execPath },
      hostScript: join(desktop, "out", "host", "host.mjs"),
      builtIns,
      sealer: testSealer("test-key"),
      timing: { hook: 2_000, call: 10_000, load: 10_000, ready: 10_000, restartDelay: options.restartDelay ?? 60 },
      separateHosts: options.separateHosts ?? true,
      ...(options.mayRunServerPart ? { mayRunServerPart: options.mayRunServerPart } : {}),
      onPid: (pid, isAlive) => {
        if (isAlive) {
          alivePids.add(pid);
          spawnedPids.push(pid);
        } else {
          alivePids.delete(pid);
          exitedPids.push(pid);
        }
      },
      world: {
        bots: () => [],
        send: () => ({ messageId: "m1" }),
        interrupt: async () => null,
        notice: (text) => { notices.push(text); },
        ask: async () => ({ index: 0 }),
        openPanel: () => {},
        appSettings: () => ({ language: "en", botLook: "original", workerLimit: 4 }),
        shortcutOverrides: () => ({}),
        commandApproval: () => null,
        approveCommand: () => false,
        commandRun: () => null,
        component: () => null,
        imageUrls: () => null,
        createBot: () => { throw new Error("unused"); },
        addRoutine: () => "no-bot",
        changed: () => {},
        broken: (plugin, problem) => { broken.push({ plugin, problem }); },
        log: () => {},
        workspace: emptyWorkspace(),
        workspaceWatch: () => {},
      },
    });
    cleanups.push(() => plugins.shutdown());

    return { root, dataDir, builtIns, plugins, alivePids, spawnedPids, exitedPids, notices, broken };
  }

  const waitRegistered = (unit: ReturnType<typeof createUnit>, names: string[]) =>
    until(
      () =>
        names.every((name) =>
          unit.plugins.view().plugins.find((p) => p.name === name)?.commands.every((c) => c.registered),
        ),
      { timeout: 15_000, what: `${names.join(", ")} registered` },
    );

  it("killing X's process blames and fails only X while Y and built-ins keep running", async () => {
    const unit = createUnit({ mayRunServerPart: () => true });
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("builtin.beta", unit.builtIns!);
    copyFixture("user.y", join(unit.dataDir, "plugins"));
    writeInlinePlugin(
      join(unit.dataDir, "plugins"),
      "user.x",
      [
        { id: "user.x.pid", title: "X Pid" },
        { id: "user.x.hold", title: "X Hold" },
      ],
      `export function activate(ccb) {
        ccb.commands.register("user.x.pid", () => process.pid);
        ccb.commands.register("user.x.hold", () => new Promise((resolve) => setTimeout(() => resolve("done"), 5000)));
      }\n`,
    );

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, ["builtin.alpha", "builtin.beta", "user.x", "user.y"]);

    const alpha1 = (await unit.plugins.command("builtin.alpha.info")) as { pid: number };
    const beta1 = (await unit.plugins.command("builtin.beta.info")) as { pid: number };
    const y1 = (await unit.plugins.command("user.y.info")) as { pid: number };
    const xPid1 = (await unit.plugins.command("user.x.pid")) as number;
    expect(alpha1.pid).toBe(beta1.pid);
    expect(new Set([alpha1.pid, y1.pid, xPid1]).size).toBe(3);

    // Crash 1 while a command is in flight: the command fails and X restarts, without touching Y or built-ins.
    const inFlight = unit.plugins.command("user.x.hold");
    await sleep(30);
    process.kill(xPid1, "SIGKILL");
    await expect(inFlight).rejects.toThrow(/exited/i);

    await until(() => !alive(xPid1) && unit.exitedPids.includes(xPid1), { timeout: 5_000, what: "xPid1 exited" });
    await waitRegistered(unit, ["user.x"]);
    const xPid2 = (await unit.plugins.command("user.x.pid")) as number;
    expect(xPid2).not.toBe(xPid1);

    // Y and built-ins kept their exact PIDs and still work.
    expect(((await unit.plugins.command("builtin.alpha.info")) as { pid: number }).pid).toBe(alpha1.pid);
    expect(((await unit.plugins.command("user.y.info")) as { pid: number }).pid).toBe(y1.pid);

    // Crash 2 and Crash 3 (with nothing in flight): 3rd crash turns only X off.
    process.kill(xPid2, "SIGKILL");
    await until(() => !alive(xPid2), { timeout: 5_000, what: "xPid2 exited" });
    await waitRegistered(unit, ["user.x"]);
    const xPid3 = (await unit.plugins.command("user.x.pid")) as number;
    expect(xPid3).not.toBe(xPid2);

    process.kill(xPid3, "SIGKILL");
    await until(
      () => {
        const xView = unit.plugins.view().plugins.find((p) => p.name === "user.x");
        return xView && !xView.enabled && xView.failure;
      },
      { timeout: 10_000, what: "user.x marked failed after 3 crashes" },
    );
    await until(() => !alive(xPid3), { timeout: 5_000, what: "xPid3 exited" });

    // Confirm X does not restart again.
    const spawnsAfterFail = unit.spawnedPids.length;
    await sleep(350);
    expect(unit.spawnedPids.length).toBe(spawnsAfterFail);

    // Y and built-ins remain enabled, unfailed, and on their original PIDs.
    const view = unit.plugins.view();
    for (const healthy of ["builtin.alpha", "builtin.beta", "user.y"]) {
      const entry = view.plugins.find((p) => p.name === healthy);
      expect(entry?.enabled).toBe(true);
      expect(entry?.failure).toBeNull();
    }
    expect(((await unit.plugins.command("builtin.alpha.info")) as { pid: number }).pid).toBe(alpha1.pid);
    expect(((await unit.plugins.command("builtin.beta.info")) as { pid: number }).pid).toBe(beta1.pid);
    expect(((await unit.plugins.command("user.y.info")) as { pid: number }).pid).toBe(y1.pid);
    expect(unit.broken.map((b) => b.plugin)).toEqual(["user.x"]);
  });

  it("fatal load failure turns only the failing plugin off immediately while others keep working", async () => {
    const unit = createUnit({ mayRunServerPart: () => true });
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("user.y", join(unit.dataDir, "plugins"));
    writeInlinePlugin(
      join(unit.dataDir, "plugins"),
      "user.badload",
      [{ id: "user.badload.ping", title: "Bad Load" }],
      `export function activate() { throw new Error("boom on activate"); }\n`,
    );

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, ["builtin.alpha", "user.y"]);

    await until(
      () => {
        const bad = unit.plugins.view().plugins.find((p) => p.name === "user.badload");
        return bad && !bad.enabled && bad.failure?.includes("boom on activate");
      },
      { timeout: 10_000, what: "user.badload marked failed on load" },
    );

    const spawnsAfter = unit.spawnedPids.length;
    await sleep(300);
    expect(unit.spawnedPids.length).toBe(spawnsAfter);
    expect(unit.alivePids.size).toBe(2);
    expect(((await unit.plugins.command("user.y.info")) as { name: string }).name).toBe("user.y");
    expect(((await unit.plugins.command("builtin.alpha.info")) as { name: string }).name).toBe("builtin.alpha");
  });

  it("reloading X restarts its module-level counter at 0 while Y keeps its process and counter", async () => {
    const unit = createUnit({ mayRunServerPart: () => true });
    copyFixture("builtin.alpha", unit.builtIns!);
    const xDir = copyFixture("user.x", join(unit.dataDir, "plugins"));
    copyFixture("user.y", join(unit.dataDir, "plugins"));

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, ["builtin.alpha", "user.x", "user.y"]);

    const alpha1 = (await unit.plugins.command("builtin.alpha.info")) as { pid: number };
    const x1 = (await unit.plugins.command("user.x.info")) as { pid: number; calls: number };
    await unit.plugins.command("user.x.info");
    await unit.plugins.command("user.x.info");
    expect(await unit.plugins.command("user.x.calls")).toBe(3);

    const y1 = (await unit.plugins.command("user.y.info")) as { pid: number; calls: number };
    await unit.plugins.command("user.y.info");
    expect(await unit.plugins.command("user.y.calls")).toBe(2);

    // 1) Reload via enable/disable toggle.
    unit.plugins.setEnabled("user.x", false);
    await until(() => !alive(x1.pid) && unit.exitedPids.includes(x1.pid), { timeout: 5_000, what: "x1 stopped on disable" });
    unit.plugins.setEnabled("user.x", true);
    await waitRegistered(unit, ["user.x"]);

    expect(await unit.plugins.command("user.x.calls")).toBe(0);
    const x2 = (await unit.plugins.command("user.x.info")) as { pid: number; calls: number };
    expect(x2.pid).not.toBe(x1.pid);
    expect(x2.calls).toBe(1);

    // Y and built-ins were never restarted; Y's module counter is preserved.
    expect(((await unit.plugins.command("user.y.info")) as { pid: number }).pid).toBe(y1.pid);
    expect(await unit.plugins.command("user.y.calls")).toBe(3);
    expect(((await unit.plugins.command("builtin.alpha.info")) as { pid: number }).pid).toBe(alpha1.pid);

    // 2) Reload via live code edit on disk + scan.
    const nextCode = readFileSync(join(xDir, "lib", "host.mjs"), "utf8").replaceAll(
      'name: "user.x",',
      'name: "user.x", reloaded: true,',
    );
    writeFileSync(join(xDir, "lib", "host.mjs"), nextCode);
    unit.plugins.scan();

    await until(() => !alive(x2.pid) && unit.exitedPids.includes(x2.pid), { timeout: 10_000, what: "x2 stopped on code change" });
    await waitRegistered(unit, ["user.x"]);

    expect(await unit.plugins.command("user.x.calls")).toBe(0);
    const x3 = (await unit.plugins.command("user.x.info")) as { pid: number; calls: number; reloaded?: boolean };
    expect(x3.pid).not.toBe(x2.pid);
    expect(x3.reloaded).toBe(true);
    expect(x3.calls).toBe(1);
    expect(((await unit.plugins.command("user.y.info")) as { pid: number }).pid).toBe(y1.pid);
    expect(await unit.plugins.command("user.y.calls")).toBe(4);
  });

  it("R4: a separate host dying with nothing in flight (timer exit) blames its owner and stops after 3 crashes", async () => {
    const unit = createUnit({ mayRunServerPart: () => true, restartDelay: 60 });
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("user.y", join(unit.dataDir, "plugins"));
    const crashLog = join(unit.root, "timer-crash-pids.log");
    writeInlinePlugin(
      join(unit.dataDir, "plugins"),
      "user.timercrash",
      [{ id: "user.timercrash.ping", title: "Timer Crash" }],
      `import { appendFileSync } from "node:fs";
      export function activate() {
        appendFileSync(${JSON.stringify(crashLog)}, String(process.pid) + "\\n");
        setTimeout(() => process.exit(1), 20);
      }\n`,
    );

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, ["builtin.alpha", "user.y"]);

    await until(
      () => {
        const entry = unit.plugins.view().plugins.find((p) => p.name === "user.timercrash");
        return entry && !entry.enabled && !!entry.failure;
      },
      { timeout: 10_000, what: "user.timercrash disabled after 3 idle timer crashes" },
    );

    // Wait well past several restartDelay cycles to prove there is no infinite restart loop.
    await sleep(450);

    const crashedPids = readFileSync(crashLog, "utf8").trim().split("\n").filter(Boolean).map(Number);
    expect(crashedPids).toHaveLength(3);
    // 1 shared built-in + 1 user.y + 3 user.timercrash = 5 spawns total, 2 still alive.
    expect(unit.spawnedPids).toHaveLength(5);
    expect(unit.alivePids.size).toBe(2);

    const view = unit.plugins.view();
    expect(view.plugins.find((p) => p.name === "user.timercrash")?.enabled).toBe(false);
    expect(view.plugins.find((p) => p.name === "user.y")?.enabled).toBe(true);
    expect(view.plugins.find((p) => p.name === "builtin.alpha")?.enabled).toBe(true);
    expect(((await unit.plugins.command("user.y.info")) as { name: string }).name).toBe("user.y");
    expect(((await unit.plugins.command("builtin.alpha.info")) as { name: string }).name).toBe("builtin.alpha");
  });

  it("R4: a separate host exiting during load() blames its owner and stops after 3 crashes", async () => {
    const unit = createUnit({ mayRunServerPart: () => true, restartDelay: 60 });
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("user.y", join(unit.dataDir, "plugins"));
    const crashLog = join(unit.root, "load-crash-pids.log");
    writeInlinePlugin(
      join(unit.dataDir, "plugins"),
      "user.loadcrash",
      [{ id: "user.loadcrash.ping", title: "Load Crash" }],
      `import { appendFileSync } from "node:fs";
      export function activate() {
        appendFileSync(${JSON.stringify(crashLog)}, String(process.pid) + "\\n");
        process.exit(1);
      }\n`,
    );

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, ["builtin.alpha", "user.y"]);

    await until(
      () => {
        const entry = unit.plugins.view().plugins.find((p) => p.name === "user.loadcrash");
        return entry && !entry.enabled && !!entry.failure;
      },
      { timeout: 10_000, what: "user.loadcrash disabled after 3 load crashes" },
    );

    await sleep(450);

    const crashedPids = readFileSync(crashLog, "utf8").trim().split("\n").filter(Boolean).map(Number);
    expect(crashedPids).toHaveLength(3);
    expect(unit.spawnedPids).toHaveLength(5);
    expect(unit.alivePids.size).toBe(2);
    expect(((await unit.plugins.command("user.y.info")) as { name: string }).name).toBe("user.y");
  });

  it("counts a single host crash with both a command and a web call in flight as one crash, not two", async () => {
    const unit = createUnit({ mayRunServerPart: () => true, restartDelay: 60 });
    writeInlinePlugin(
      join(unit.dataDir, "plugins"),
      "user.double",
      [
        { id: "user.double.pid", title: "Pid" },
        { id: "user.double.hold", title: "Hold" },
      ],
      `export function activate(ccb) {
        ccb.commands.register("user.double.pid", () => process.pid);
        ccb.commands.register("user.double.hold", () => new Promise((r) => setTimeout(() => r("ok"), 5000)));
        ccb.ui.expose("holdWeb", () => new Promise((r) => setTimeout(() => r("ok"), 5000)));
      }\n`,
      { web: true },
    );

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, ["user.double"]);

    const pid1 = (await unit.plugins.command("user.double.pid")) as number;
    const pendingCmd = unit.plugins.command("user.double.hold").then(
      () => { throw new Error("expected rejection"); },
      (err: Error) => err,
    );
    const pendingWeb = unit.plugins.call("user.double", "holdWeb", null, "chat").then(
      () => { throw new Error("expected rejection"); },
      (err: Error) => err,
    );
    await sleep(50);
    process.kill(pid1, "SIGKILL");
    expect((await pendingCmd).message).toMatch(/exited/i);
    expect((await pendingWeb).message).toMatch(/exited/i);

    await waitRegistered(unit, ["user.double"]);
    const pid2 = (await unit.plugins.command("user.double.pid")) as number;
    expect(pid2).not.toBe(pid1);
    expect(unit.plugins.view().plugins.find((p) => p.name === "user.double")?.enabled).toBe(true);

    // Needs 2 more crashes (total 3) to disable.
    process.kill(pid2, "SIGKILL");
    await until(() => !alive(pid2) && unit.exitedPids.includes(pid2), { timeout: 5_000, what: "pid2 exited" });
    await waitRegistered(unit, ["user.double"]);
    const pid3 = (await unit.plugins.command("user.double.pid")) as number;
    expect(pid3).not.toBe(pid2);
    expect(unit.plugins.view().plugins.find((p) => p.name === "user.double")?.enabled).toBe(true);

    process.kill(pid3, "SIGKILL");
    await until(
      () => unit.plugins.view().plugins.find((p) => p.name === "user.double")?.enabled === false,
      { timeout: 10_000, what: "user.double disabled on 3rd crash" },
    );
  });

  it("PluginRegistry.recordHostFailure turns a plugin off only on the 3rd crash within 10 minutes", () => {
    const root = makeRoot("reg-window");
    const lib = join(root, "plugins");
    mkdirSync(lib, { recursive: true });
    writeInlinePlugin(lib, "user.win", [{ id: "user.win.ok", title: "Ok" }], "export function activate() {}\n");
    const registry = new PluginRegistry(lib, join(root, "plugins.json"), new SealedSecretStore(join(root, "secrets.json"), testSealer("test-key")));

    registry.recordHostFailure("user.win", "crash 1", false, 0);
    registry.recordHostFailure("user.win", "crash 2", false, 1_000);
    expect(registry.plugin("user.win")?.enabled).toBe(true);

    // More than 10 minutes (600_000 ms) after crash 1: crash 1 expired, so only 2 crashes in window.
    registry.recordHostFailure("user.win", "crash 3 late", false, 600_500);
    expect(registry.plugin("user.win")?.enabled).toBe(true);

    // Next crash within 10 minutes of crash 2 and crash 3 hits 3 in window -> disabled.
    registry.recordHostFailure("user.win", "crash 4 in window", false, 600_800);
    expect(registry.plugin("user.win")?.enabled).toBe(false);
    expect(registry.plugin("user.win")?.failure).toBe("crash 4 in window");
  });

  it("measures RSS of ten separate plugin host processes (report only, no threshold)", async () => {
    const unit = createUnit({ builtIns: null, mayRunServerPart: () => true });
    const names = Array.from({ length: 10 }, (_, i) => `user.m${i}`);
    for (const name of names) {
      writeInlinePlugin(
        join(unit.dataDir, "plugins"),
        name,
        [{ id: `${name}.mem`, title: `${name} mem` }],
        `export function activate(ccb) {
          ccb.commands.register(${JSON.stringify(`${name}.mem`)}, () => ({
            pid: process.pid,
            rss: process.memoryUsage().rss,
          }));
        }\n`,
      );
    }

    unit.plugins.scan();
    await unit.plugins.start();
    await waitRegistered(unit, names);

    expect(unit.alivePids.size).toBe(10);
    const samples: { name: string; pid: number; rssBytes: number }[] = [];
    for (const name of names) {
      const info = (await unit.plugins.command(`${name}.mem`)) as { pid: number; rss: number };
      const rssBytes = info.rss > 0 ? info.rss : (psRssBytes(info.pid) ?? 0);
      samples.push({ name, pid: info.pid, rssBytes });
    }

    expect(new Set(samples.map((s) => s.pid)).size).toBe(10);
    for (const sample of samples) expect(sample.rssBytes).toBeGreaterThan(0);

    const totalBytes = samples.reduce((sum, s) => sum + s.rssBytes, 0);
    const minBytes = Math.min(...samples.map((s) => s.rssBytes));
    const maxBytes = Math.max(...samples.map((s) => s.rssBytes));
    const toMiB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
    console.log(
      `[M5-18c RSS] platform=${process.platform} arch=${process.arch} count=10 ` +
        `totalMiB=${toMiB(totalBytes)} meanMiB=${toMiB(totalBytes / samples.length)} ` +
        `minMiB=${toMiB(minBytes)} maxMiB=${toMiB(maxBytes)} ` +
        `samples=${JSON.stringify(samples.map((s) => ({ name: s.name, pid: s.pid, mib: Number(toMiB(s.rssBytes)) })))}`,
    );
  });
});
