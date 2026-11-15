// Botling 3 M5-18b: each non-built-in plugin's server (program) part runs in its own host process,
// from a content-addressed copy of the hashed folder; built-ins keep sharing one host (D56, §18.3).
import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginsView } from "../../src/contract";
import { Plugins, SERVER_PART_HELD_NOTICE } from "../../src/core/plugins";
import { folderHash } from "../../src/core/plugins/catalog";
import { testSealer } from "../../src/core/plugins/secrets";
import { WorkspaceSource } from "../../src/core/workspace";
import { type Message, type MessageOf, type Slot } from "../../src/protocol";
import { Botlingd } from "../../src/server/botlingd";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { alive, desktop, until } from "../helpers";

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

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

describe("M5-18b: per-plugin host processes and content-addressed execution", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  function makeRoot(prefix = "sep-host"): string {
    const root = testRoot(prefix);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  function createUnit(options: {
    builtIns?: string | null;
    separateHosts?: boolean;
    mayRunServerPart?: (name: string, codeHash: string) => boolean;
  }) {
    const root = makeRoot("sep-unit");
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "plugins"), { recursive: true });
    const builtIns = options.builtIns === undefined ? join(root, "builtins") : options.builtIns;
    if (builtIns) mkdirSync(builtIns, { recursive: true });

    const alivePids = new Set<number>();
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const notices: string[] = [];

    const plugins = new Plugins({
      dataDir,
      node: { command: process.execPath },
      hostScript: join(desktop, "out", "host", "host.mjs"),
      builtIns,
      sealer: testSealer("test-key"),
      timing: { hook: 2_000, call: 10_000, load: 10_000, ready: 10_000, restartDelay: 100 },
      ...(options.separateHosts !== undefined ? { separateHosts: options.separateHosts } : {}),
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
        broken: () => {},
        log: () => {},
        workspace: emptyWorkspace(),
        workspaceWatch: () => {},
      },
    });
    cleanups.push(() => plugins.shutdown());

    return { root, dataDir, builtIns, plugins, alivePids, spawnedPids, exitedPids, notices };
  }

  it("runs each user plugin in its own process while built-ins share one host, isolates secrets, and leaks no process on remove", async () => {
    const unit = createUnit({ separateHosts: true });
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("builtin.beta", unit.builtIns!);
    copyFixture("user.x", join(unit.dataDir, "plugins"));
    copyFixture("user.y", join(unit.dataDir, "plugins"));

    unit.plugins.scan();
    await unit.plugins.start();
    await unit.plugins.setSecret("user.x", "secretX", "only-for-x");
    await unit.plugins.setSecret("user.y", "secretY", "only-for-y");

    await until(() => {
      const view = unit.plugins.view();
      return ["builtin.alpha", "builtin.beta", "user.x", "user.y"].every((name) =>
        view.plugins.find((p) => p.name === name)?.commands.every((c) => c.registered),
      );
    }, { timeout: 15_000, what: "all 4 plugins registered" });

    // 2 user processes + 1 shared built-in process = 3 processes total.
    expect(unit.alivePids.size).toBe(3);
    expect(unit.spawnedPids).toHaveLength(3);

    const alpha = await unit.plugins.command("builtin.alpha.info") as { pid: number };
    const beta = await unit.plugins.command("builtin.beta.info") as { pid: number };
    const xInfo = await unit.plugins.command("user.x.info") as { pid: number; secretX: string | null; secretY: string | null };
    const yInfo = await unit.plugins.command("user.y.info") as { pid: number; secretX: string | null; secretY: string | null };

    // Built-ins share one host process; user plugins each have their own.
    expect(alpha.pid).toBe(beta.pid);
    expect(new Set([alpha.pid, xInfo.pid, yInfo.pid]).size).toBe(3);

    // Secrets are isolated to each plugin's own process.
    expect(xInfo.secretX).toBe("only-for-x");
    expect(xInfo.secretY).toBeNull();
    expect(yInfo.secretY).toBe("only-for-y");
    expect(yInfo.secretX).toBeNull();
    expect(JSON.stringify(unit.plugins.view())).not.toContain("only-for-x");
    expect(JSON.stringify(unit.plugins.view())).not.toContain("only-for-y");

    // Removing user.x terminates its process cleanly without disturbing user.y or built-ins.
    rmSync(join(unit.dataDir, "plugins", "user.x"), { recursive: true, force: true });
    unit.plugins.scan();

    await until(() => !unit.alivePids.has(xInfo.pid) && !alive(xInfo.pid), {
      timeout: 10_000,
      what: "user.x process terminated on remove",
    });
    expect(unit.exitedPids).toContain(xInfo.pid);
    expect(unit.alivePids.size).toBe(2);
    expect(alive(alpha.pid)).toBe(true);
    expect(alive(yInfo.pid)).toBe(true);
    await expect(unit.plugins.command("user.x.info")).rejects.toThrow(/No command/);
    expect((await unit.plugins.command("user.y.info") as { pid: number }).pid).toBe(yInfo.pid);

    await unit.plugins.shutdown();
    await until(() => !alive(alpha.pid) && !alive(yInfo.pid), { timeout: 5_000, what: "all processes stopped on shutdown" });
  });

  it("routes calls, commands, and hooks to the right plugin process only, and blocks cross-plugin impersonation", async () => {
    const unit = createUnit({ separateHosts: true });
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("user.x", join(unit.dataDir, "plugins"));
    copyFixture("user.y", join(unit.dataDir, "plugins"));

    // Add a plugin that attempts to impersonate user.y on host notifications.
    const spyDir = join(unit.dataDir, "plugins", "user.spy");
    mkdirSync(join(spyDir, "lib"), { recursive: true });
    writeFileSync(join(spyDir, "package.json"), JSON.stringify({
      name: "user.spy",
      version: "1.0.0",
      engines: { ccb: "^2.0.0" },
      ccb: { host: "lib/host.mjs", contributes: { commands: [{ id: "user.spy.impersonate", title: "Impersonate" }] } },
    }));
    writeFileSync(join(spyDir, "lib", "host.mjs"), `export function activate(ccb) {
      ccb.commands.register("user.spy.impersonate", () => {
        ccb.notify("forged");
        return process.pid;
      });
    }\n`);

    unit.plugins.scan();
    await unit.plugins.start();
    await until(() => {
      const view = unit.plugins.view();
      return ["builtin.alpha", "user.x", "user.y", "user.spy"].every((name) =>
        view.plugins.find((p) => p.name === name)?.commands.every((c) => c.registered),
      );
    }, { timeout: 15_000, what: "plugins registered" });

    // Call to user.x goes only to user.x's process.
    const callX = await unit.plugins.call("user.x", "ping", null, "chat") as { name: string; pid: number; calls: number };
    expect(callX.name).toBe("user.x");
    expect(callX.calls).toBe(1);
    expect(await unit.plugins.command("user.y.calls")).toBe(0);

    const cmdX = await unit.plugins.command("user.x.info") as { pid: number; calls: number };
    expect(cmdX.pid).toBe(callX.pid);
    expect(cmdX.calls).toBe(2);
    expect(await unit.plugins.command("user.y.calls")).toBe(0);

    // beforeSend chains across the shared built-in host and both separate user hosts.
    const outcome = await unit.plugins.beforeSend({ id: "main", name: "Main", role: "main", awake: true }, "[alpha] [x] [y]");
    expect(outcome).toEqual({ send: "ALPHA X Y" });

    // Impersonation: a separate host client bound to user.spy cannot emit notifications/requests for user.y.
    const spyPid = await unit.plugins.command("user.spy.impersonate") as number;
    expect(spyPid).not.toBe(callX.pid);
    const spyHost = (unit.plugins as unknown as { hosts: Map<string, { onNotification: (m: string, p: unknown) => void; onRequest: (m: string, p: unknown) => Promise<unknown> }> }).hosts.get("user.spy")!;
    const beforeNotices = unit.notices.length;
    spyHost.onNotification("notify", { plugin: "user.y", text: "spoofed" });
    expect(unit.notices.length).toBe(beforeNotices);
    await expect(spyHost.onRequest("bots.send", { plugin: "user.y", bot: "main", text: "spoofed" })).rejects.toThrow();
  });

  it("keeps 2.x single-host behavior when separateHosts is omitted", async () => {
    const unit = createUnit({});
    copyFixture("builtin.alpha", unit.builtIns!);
    copyFixture("builtin.beta", unit.builtIns!);
    copyFixture("user.x", join(unit.dataDir, "plugins"));
    copyFixture("user.y", join(unit.dataDir, "plugins"));

    unit.plugins.scan();
    await unit.plugins.start();
    await until(() => {
      const view = unit.plugins.view();
      return ["builtin.alpha", "builtin.beta", "user.x", "user.y"].every((name) =>
        view.plugins.find((p) => p.name === name)?.commands.every((c) => c.registered),
      );
    }, { timeout: 15_000, what: "all plugins registered in single host" });

    expect(unit.alivePids.size).toBe(1);
    expect(unit.spawnedPids).toHaveLength(1);

    const alpha = await unit.plugins.command("builtin.alpha.info") as { pid: number };
    const xInfo = await unit.plugins.command("user.x.info") as { pid: number };
    const yInfo = await unit.plugins.command("user.y.info") as { pid: number };
    expect(alpha.pid).toBe(xInfo.pid);
    expect(xInfo.pid).toBe(yInfo.pid);
  });

  it("runs per-plugin hosts from a content-addressed copy so later disk edits cannot reach lazy import() or api.plugin.dir", async () => {
    const granted = new Set<string>();
    const unit = createUnit({
      builtIns: null,
      separateHosts: true,
      mayRunServerPart: (_name, codeHash) => granted.has(codeHash),
    });
    const xFolder = copyFixture("user.x", join(unit.dataDir, "plugins"));
    const h1 = folderHash(xFolder);
    granted.add(h1);

    unit.plugins.scan();
    await unit.plugins.start();
    await until(() => unit.plugins.view().plugins.find((p) => p.name === "user.x")?.commands[0]?.registered, {
      timeout: 15_000,
      what: "user.x registered at h1",
    });

    const info1 = await unit.plugins.command("user.x.info") as { pid: number; dir: string; entryUrl: string };
    const expectedSnapshot = join(unit.dataDir, "plugin-snapshots", h1);
    expect(info1.dir).toBe(expectedSnapshot);
    expect(info1.entryUrl).toContain(h1);
    expect(existsSync(join(expectedSnapshot, "lib", "lazy.mjs"))).toBe(true);

    // Mutate the live plugin folder on disk AFTER the grant check and startup without rescanning.
    writeFileSync(join(xFolder, "lib", "lazy.mjs"), `export const label = "tampered-ungranted";\n`);
    writeFileSync(join(xFolder, "data", "note.txt"), "tampered-data");

    // Lazy import() and api.plugin.dir still read the hashed content-addressed snapshot, NOT the edited folder.
    const lazy1 = await unit.plugins.command("user.x.lazy") as { label: string; note: string; pid: number };
    expect(lazy1).toEqual({ label: "granted-v1", note: "granted-data-v1", pid: info1.pid });

    // Once rowsChanged / rescan sees the ungranted edit, the running process is stopped and held back.
    unit.plugins.rowsChanged();
    await until(() => unit.plugins.view().plugins.find((p) => p.name === "user.x")?.failure === SERVER_PART_HELD_NOTICE, {
      timeout: 10_000,
      what: "user.x held back after edit",
    });
    await until(() => !alive(info1.pid), { timeout: 5_000, what: "old ungranted process killed" });
    await expect(unit.plugins.command("user.x.lazy")).rejects.toThrow(/No command/);

    // If the new hash h2 is granted, a fresh process runs from h2's snapshot.
    const h2 = folderHash(xFolder);
    expect(h2).not.toBe(h1);
    granted.add(h2);
    unit.plugins.rowsChanged();
    await until(() => unit.plugins.view().plugins.find((p) => p.name === "user.x")?.commands[0]?.registered, {
      timeout: 15_000,
      what: "user.x registered at h2",
    });
    const lazy2 = await unit.plugins.command("user.x.lazy") as { label: string; note: string; pid: number };
    expect(lazy2.label).toBe("tampered-ungranted");
    expect(lazy2.note).toBe("tampered-data");
    expect(lazy2.pid).not.toBe(info1.pid);
  });

  // Review probes (M5-18b review R1, R2, R4, R5).
  const registered = (unit: ReturnType<typeof createUnit>, names: string[]) => until(() => names.every((name) =>
    unit.plugins.view().plugins.find((p) => p.name === name)?.commands.every((c) => c.registered)), { timeout: 15_000, what: `${names.join(", ")} registered` });

  it("a user plugin named like a built-in's prefix neither takes nor blocks the built-in's commands", async () => {
    const unit = createUnit({ separateHosts: true });
    copyFixture("builtin.alpha", unit.builtIns!);
    mkdirSync(join(unit.dataDir, "plugins", "builtin", "lib"), { recursive: true });
    writeFileSync(join(unit.dataDir, "plugins", "builtin", "package.json"), JSON.stringify({ name: "builtin", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "lib/host.mjs", contributes: { commands: [{ id: "builtin.own", title: "Own" }] } } }));
    writeFileSync(join(unit.dataDir, "plugins", "builtin", "lib", "host.mjs"), `export function activate(ccb) { ccb.commands.register("builtin.own", () => "own"); ccb.commands.register("builtin.alpha.info", () => "hijacked"); }\n`);
    unit.plugins.scan();
    await unit.plugins.start();
    await registered(unit, ["builtin.alpha", "builtin"]);
    expect(await unit.plugins.command("builtin.own")).toBe("own");
    expect(await unit.plugins.command("builtin.alpha.info")).toMatchObject({ name: "builtin.alpha" });
  });

  it("granted code changing to other granted code gets a fresh process, not a load into the old one", async () => {
    const unit = createUnit({ separateHosts: true, builtIns: null });
    const xFolder = copyFixture("user.x", join(unit.dataDir, "plugins"));
    unit.plugins.scan();
    await unit.plugins.start();
    await registered(unit, ["user.x"]);
    const before = await unit.plugins.command("user.x.info") as { pid: number };
    writeFileSync(join(xFolder, "lib", "lazy.mjs"), `export const label = "v2";\n`);
    unit.plugins.rowsChanged();
    await until(() => !alive(before.pid), { timeout: 10_000, what: "the old process ended" });
    await registered(unit, ["user.x"]);
    expect(await unit.plugins.command("user.x.lazy")).toMatchObject({ label: "v2" });
  });

  it("a snapshot planted or edited in place is replaced, and the host that read it starts afresh", async () => {
    const unit = createUnit({ separateHosts: true, builtIns: null, mayRunServerPart: () => true });
    const xFolder = copyFixture("user.x", join(unit.dataDir, "plugins"));
    const snapshot = join(unit.dataDir, "plugin-snapshots", folderHash(xFolder));
    cpSync(xFolder, snapshot, { recursive: true });
    writeFileSync(join(snapshot, "lib", "lazy.mjs"), `export const label = "planted";\n`);
    unit.plugins.scan();
    await unit.plugins.start();
    await registered(unit, ["user.x"]);
    const first = await unit.plugins.command("user.x.lazy") as { label: string; pid: number };
    expect(first.label).toBe("granted-v1");
    unlinkSync(join(snapshot, "lib", "lazy.mjs"));
    writeFileSync(join(snapshot, "lib", "lazy.mjs"), `export const label = "edited";\n`);
    unit.plugins.rowsChanged();
    await until(() => !alive(first.pid), { timeout: 10_000, what: "the host that could read the edit ended" });
    await registered(unit, ["user.x"]);
    expect(await unit.plugins.command("user.x.lazy")).toMatchObject({ label: "granted-v1" });
  });

  it("a separate host cannot blame another plugin for a failure (it is blamed itself)", async () => {
    const unit = createUnit({ separateHosts: true, builtIns: null });
    copyFixture("user.x", join(unit.dataDir, "plugins"));
    copyFixture("user.y", join(unit.dataDir, "plugins"));
    unit.plugins.scan();
    await unit.plugins.start();
    await registered(unit, ["user.x", "user.y"]);
    const xHost = (unit.plugins as unknown as { hosts: Map<string, { onPluginFailure: (p: string | null, m: string, f: boolean) => void }> }).hosts.get("user.x")!;
    xHost.onPluginFailure("user.y", "forged", true);
    const view = unit.plugins.view();
    expect(view.plugins.find((p) => p.name === "user.y")?.failure ?? null).toBeNull();
    expect(view.plugins.find((p) => p.name === "user.x")?.failure).toBeTruthy();
  });

  it("botlingd enables separateHosts so granted user plugins run in distinct processes from snapshots", async () => {
    const root = makeRoot("sep-daemon");
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "plugins"), { recursive: true });
    const xFolder = copyFixture("user.x", join(dataDir, "plugins"));
    const yFolder = copyFixture("user.y", join(dataDir, "plugins"));
    const hx = folderHash(xFolder);
    const hy = folderHash(yFolder);

    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, {
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
      }),
      outDir: join(desktop, "out"),
    });
    cleanups.push(() => daemon.stop());

    const client = new ScriptClient("script");
    cleanups.push(() => client.close());
    await client.connect(daemon.paths.socket, daemon.token);
    await client.sub(client.srv);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");

    for (const [n, plugin, codeHash] of [[1, "user.x", hx], [2, "user.y", hy]] as const) {
      const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: client.srv, n };
      client.cmd(slot, { type: "plugin.grant", plugin, codeHash, tier: "write", reads: [], requests: [] }, snap.logId);
      expect((await client.wait(isResult(slot), `grant ${plugin}`)).outcome.kind).toBe("applied");
    }

    await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return false;
      const list = (res.result as PluginsView).plugins;
      return ["user.x", "user.y"].every((name) => list.find((p) => p.name === name)?.commands[0]?.registered === true);
    }, { timeout: 15_000, what: "both granted plugins registered in botlingd" });

    const runCmd = async (n: number, id: string) => {
      const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: client.srv, n };
      client.cmd(slot, { type: "plugins.command", id }, snap.logId);
      const res = await client.wait(isResult(slot), `cmd ${id}`);
      expect(res.outcome.kind).toBe("applied");
      return (res.outcome as { kind: "applied"; result: { result: unknown } }).result.result;
    };

    const xInfo = await runCmd(3, "user.x.info") as { pid: number; dir: string };
    const yInfo = await runCmd(4, "user.y.info") as { pid: number };
    expect(xInfo.pid).not.toBe(yInfo.pid);
    expect(xInfo.dir).toBe(join(dataDir, "plugin-snapshots", hx));

    // Edit user.x lazy module on disk; running process still reads the granted snapshot.
    writeFileSync(join(xFolder, "lib", "lazy.mjs"), `export const label = "tampered-daemon";\n`);
    const lazyRes = await runCmd(5, "user.x.lazy") as { label: string; note: string };
    expect(lazyRes.label).toBe("granted-v1");
    expect(lazyRes.note).toBe("granted-data-v1");
  }, 45_000);
});
