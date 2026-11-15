// Botling 3 M5-18a: a plugin's server (program) part runs only for a built-in at its shipped hash
// or a plugin whose current code hash has a `write` grant on this server (D56, §18.3, §4.1 check 4).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginsView } from "../../src/contract";
import { Plugins } from "../../src/core/plugins";
import { folderHash } from "../../src/core/plugins/catalog";
import { WorkspaceSource } from "../../src/core/workspace";
import { PluginsPanel } from "../../src/renderer/Plugins";
import type { Client } from "../../src/renderer/client";
import { ResAssembler, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { Botlingd } from "../../src/server/botlingd";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";

const HELD_BACK_NOTICE = "Its program part is off until you allow it to change its own data on this server.";

let largeReqCounter = 0;
async function reqLarge(client: ScriptClient, cmd: unknown, timeout = 30_000): Promise<MessageOf<"res">> {
  const req = `large-${++largeReqCounter}`;
  const from = client.received.length;
  client.send({ t: "req", req, cmd } as Message);
  const assembler = new ResAssembler();
  let seen = from;
  return until(() => {
    for (; seen < client.received.length; seen++) {
      const m = client.received[seen]!;
      if (m.t === "res" && m.req === req) return m;
      if (m.t === "res.part" && m.req === req) {
        const pushed = assembler.push(m, { local: true });
        if (!pushed.ok) throw new Error(pushed.detail);
        if (pushed.message) return pushed.message;
      }
    }
    if (client.closed) throw new Error(`session closed while waiting for ${req}`);
    return null;
  }, { timeout, what: `large res ${req}` });
}

async function runPluginCommand(client: ScriptClient, inc: string, originEpoch: string, n: number, id: string): Promise<MessageOf<"cmd.result">> {
  const slot: Slot = { origin: "script", originEpoch, target: client.srv, n };
  client.cmd(slot, { type: "plugins.command", id }, inc);
  return client.wait(isResult(slot), `cmd ${id} (slot ${n})`);
}

function okResult<T>(res: MessageOf<"res">): T {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error.message);
  return res.result as T;
}

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

function writePlugin(
  root: string,
  name: string,
  options: {
    version?: string;
    permissions?: string[];
    host?: string | null;
    web?: string | null;
    commands?: Array<{ id: string; title: string }>;
    panels?: Array<{ id: string; title: string }>;
  } = {},
): string {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  const ccb: Record<string, unknown> = {
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.web !== null ? { web: "dist/web.js" } : {}),
    ...(options.host !== null ? { host: "dist/host.mjs" } : {}),
    contributes: {
      ...(options.commands ? { commands: options.commands } : {}),
      ...(options.panels ? { panels: options.panels } : {}),
    },
  };
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name,
    version: options.version ?? "1.0.0",
    engines: { ccb: "^2.0.0" },
    ccb,
  }));
  if (options.web !== null) {
    writeFileSync(join(folder, "dist", "web.js"), options.web ?? `export function activate() { return "${name}"; }\n`);
  }
  if (options.host !== null) {
    writeFileSync(
      join(folder, "dist", "host.mjs"),
      options.host ?? `export function activate(ccb) { ccb.commands.register("${name}.ping", () => "pong:${name}"); }\n`,
    );
  }
  return folder;
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

describe("M5-18a: server part runs only with a write grant", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function makeRoot(prefix = "spg"): string {
    const root = testRoot(prefix);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  async function startPluginsUnit(options: {
    builtIns?: string | null;
    mayRunServerPart?: (name: string, codeHash: string) => boolean;
  }) {
    const root = makeRoot("spg-unit");
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "plugins"), { recursive: true });
    let lastView: PluginsView | null = null;
    const plugins = new Plugins({
      dataDir,
      node: { command: process.execPath },
      hostScript: join(desktop, "out", "host", "host.mjs"),
      builtIns: options.builtIns ?? null,
      sealer: null,
      timing: { hook: 1_000, call: 5_000, load: 5_000, ready: 5_000, restartDelay: 100 },
      ...(options.mayRunServerPart ? { mayRunServerPart: options.mayRunServerPart } : {}),
      world: {
        bots: () => [],
        send: () => ({ messageId: "m1" }),
        interrupt: async () => null,
        notice: () => {},
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
        changed: (view) => { lastView = view; },
        broken: () => {},
        log: () => {},
        workspace: emptyWorkspace(),
        workspaceWatch: () => {},
      },
    });
    cleanups.push(() => plugins.shutdown());
    return { root, dataDir, plugins, view: () => lastView ?? plugins.view() };
  }

  async function startDaemon(): Promise<{ dataDir: string; daemon: Botlingd; client: ScriptClient; inc: string; originEpoch: string }> {
    const root = makeRoot("spg-d");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
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
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    return { dataDir, daemon, client, inc: srvSnap.logId, originEpoch: client.originEpoch };
  }

  it("starts a built-in at its shipped hash without any user grant", async () => {
    const root = makeRoot("spg-builtin");
    const builtInsDir = join(root, "builtins");
    writePlugin(builtInsDir, "shipped.tool", {
      commands: [{ id: "shipped.tool.ping", title: "Ping" }],
      panels: [{ id: "panel", title: "Panel" }],
    });
    const shippedHash = folderHash(join(builtInsDir, "shipped.tool"));
    const allowedCalls: Array<{ name: string; codeHash: string }> = [];

    const unit = await startPluginsUnit({
      builtIns: builtInsDir,
      mayRunServerPart: (name, codeHash) => {
        allowedCalls.push({ name, codeHash });
        return name === "shipped.tool" && codeHash === shippedHash;
      },
    });
    await unit.plugins.start();

    await until(() => unit.plugins.view().plugins.find((p) => p.name === "shipped.tool")?.commands[0]?.registered === true, {
      timeout: 10_000,
      what: "built-in command registered",
    });
    expect(allowedCalls).toContainEqual({ name: "shipped.tool", codeHash: shippedHash });
    expect(unit.plugins.view().plugins.find((p) => p.name === "shipped.tool")?.failure).toBeNull();
    expect(await unit.plugins.command("shipped.tool.ping")).toBe("pong:shipped.tool");
  });

  it("does not start a user plugin without a write grant, keeps its web part listed, and adds the notice", async () => {
    const { dataDir, client, inc, originEpoch } = await startDaemon();
    const pluginDir = writePlugin(join(dataDir, "plugins"), "user.tool", {
      permissions: ["files"],
      commands: [{ id: "user.tool.ping", title: "Ping" }],
      panels: [{ id: "main", title: "Main" }],
      host: `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export function activate(ccb) {
  writeFileSync(join(ccb.storage.dir ?? ".", "started.flag"), "ran");
  ccb.commands.register("user.tool.ping", () => "pong:user");
}
`,
    });

    const { daemon } = await (async () => {
      // Trigger a scan so the newly written plugin is picked up immediately instead of waiting for the 1.5s watch.
      const res = await client.req({ type: "plugins.list" });
      return { daemon: res };
    })();
    expect(daemon.ok).toBe(true);

    const view = await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return null;
      const v = res.result as PluginsView;
      return v.plugins.some((p) => p.name === "user.tool") ? v : null;
    }, { timeout: 10_000, what: "user.tool in plugins.list" });

    const entry = view.plugins.find((p) => p.name === "user.tool")!;
    expect(entry.enabled).toBe(true);
    expect(entry.failure).toBe(HELD_BACK_NOTICE);
    expect(entry.panels).toEqual([{ id: "main", title: "Main" }]);
    expect(entry.commands).toEqual([{ id: "user.tool.ping", title: "Ping", registered: false }]);

    // 2.x Plugins.tsx reads the core's view and shows the notice without renderer changes.
    const html = renderToStaticMarkup(createElement(PluginsPanel, {
      client: {} as Client,
      plugins: view,
      onPanel() {},
      onClose() {},
      embedded: true,
    }));
    expect(html).toContain(HELD_BACK_NOTICE);

    // Web part is still listed and served.
    const webRes = await reqLarge(client, { type: "plugins.web" });
    expect(okResult<{ specs: Array<{ name: string }> }>(webRes).specs.some((s) => s.name === "user.tool")).toBe(true);

    // Program part never started.
    const cmdRes = await runPluginCommand(client, inc, originEpoch, 1, "user.tool.ping");
    expect(cmdRes.outcome.kind).toBe("refused");
    expect(readFileSync(join(pluginDir, "package.json"), "utf8")).toContain("user.tool");
    await expect(Promise.resolve().then(() => readFileSync(join(dataDir, "plugin-data", "user.tool", "started.flag"), "utf8"))).rejects.toThrow();

    // Built-in at shipped hash in the same botlingd runs normally.
    const builtIn = view.plugins.find((p) => p.name === "botling.catchup");
    expect(builtIn?.builtIn).toBe(true);
    expect(builtIn?.failure).toBeNull();
  }, 45_000);

  it("starts the server part on write grant reload and stops it when the grant is removed", async () => {
    const { dataDir, daemon, client, inc, originEpoch } = await startDaemon();
    const pluginFolder = writePlugin(join(dataDir, "plugins"), "grantable.tool", {
      permissions: ["files", "composer"],
      commands: [{ id: "grantable.tool.ping", title: "Ping" }],
      panels: [{ id: "p", title: "P" }],
      host: `export function activate(ccb) {
  ccb.commands.register("grantable.tool.ping", () => "pong:" + process.pid);
}
`,
    });
    const codeHash = folderHash(pluginFolder);

    // Wait for plugin row to be published in server.db and plugins.list to show it held back.
    await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return false;
      const entry = (res.result as PluginsView).plugins.find((p) => p.name === "grantable.tool");
      return entry?.failure === HELD_BACK_NOTICE;
    }, { timeout: 10_000, what: "grantable.tool held back initially" });

    // Lower tier ("request") must NOT start the server part.
    const slotReq: Slot = { origin: "script", originEpoch, target: client.srv, n: 1 };
    client.cmd(slotReq, {
      type: "plugin.grant",
      plugin: "grantable.tool",
      codeHash,
      tier: "request",
      reads: [],
      requests: ["chat.send"],
    }, inc);
    expect((await client.wait(isResult(slotReq), "request grant result")).outcome.kind).toBe("applied");
    const afterRequest = okResult<PluginsView>(await client.req({ type: "plugins.list" }));
    expect(afterRequest.plugins.find((p) => p.name === "grantable.tool")?.failure).toBe(HELD_BACK_NOTICE);
    expect((await runPluginCommand(client, inc, originEpoch, 2, "grantable.tool.ping")).outcome.kind).toBe("refused");

    // Grant "write": reload runs automatically and starts the server part.
    const slotWrite: Slot = { origin: "script", originEpoch, target: client.srv, n: 3 };
    client.cmd(slotWrite, {
      type: "plugin.grant",
      plugin: "grantable.tool",
      codeHash,
      tier: "write",
      reads: [],
      requests: ["chat.send"],
    }, inc);
    expect((await client.wait(isResult(slotWrite), "write grant result")).outcome.kind).toBe("applied");

    await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return false;
      const entry = (res.result as PluginsView).plugins.find((p) => p.name === "grantable.tool");
      return entry?.failure === null && entry.commands[0]?.registered === true;
    }, { timeout: 10_000, what: "grantable.tool registered after write grant" });

    const pingRes = await runPluginCommand(client, inc, originEpoch, 4, "grantable.tool.ping");
    expect(pingRes.outcome.kind).toBe("applied");
    expect((pingRes.outcome as { kind: "applied"; result: { result: string } }).result.result).toMatch(/^pong:\d+$/);

    // Remove grant ("none"): server part stops and notice returns.
    const slotRevoke: Slot = { origin: "script", originEpoch, target: client.srv, n: 5 };
    client.cmd(slotRevoke, {
      type: "plugin.grant",
      plugin: "grantable.tool",
      codeHash,
      tier: "none",
      reads: [],
      requests: [],
    }, inc);
    expect((await client.wait(isResult(slotRevoke), "revoke grant result")).outcome.kind).toBe("applied");

    await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return false;
      const entry = (res.result as PluginsView).plugins.find((p) => p.name === "grantable.tool");
      return entry?.failure === HELD_BACK_NOTICE && entry.commands[0]?.registered === false;
    }, { timeout: 10_000, what: "grantable.tool held back after revoke" });

    const stoppedCmd = await runPluginCommand(client, inc, originEpoch, 6, "grantable.tool.ping");
    expect(stoppedCmd.outcome.kind).toBe("refused");
    expect(daemon.core.plugins.view().plugins.find((p) => p.name === "grantable.tool")?.failure).toBe(HELD_BACK_NOTICE);
  }, 45_000);

  it("does not start an edited built-in plugin (new hash, no grant)", async () => {
    const { dataDir, daemon, client, inc, originEpoch } = await startDaemon();
    const builtInName = "botling.catchup";
    const builtInPkg = JSON.parse(readFileSync(join(desktop, "builtin-plugins", builtInName, "package.json"), "utf8")) as { version: string };

    // Confirm shipped built-in is running initially.
    const initial = okResult<PluginsView>(await client.req({ type: "plugins.list" }));
    expect(initial.plugins.find((p) => p.name === builtInName)?.builtIn).toBe(true);
    expect(initial.plugins.find((p) => p.name === builtInName)?.failure).toBeNull();

    // Override the built-in in <dataDir>/plugins with the same version and a different host/web body -> new hash, no grant.
    writePlugin(join(dataDir, "plugins"), builtInName, {
      version: builtInPkg.version,
      permissions: ["messages"],
      commands: [{ id: `${builtInName}.edited`, title: "Edited" }],
      host: `export function activate(ccb) { ccb.commands.register("${builtInName}.edited", () => "should-not-run"); }\n`,
    });
    daemon.core.plugins.scan();

    await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return false;
      const entry = (res.result as PluginsView).plugins.find((p) => p.name === builtInName);
      return entry && !entry.builtIn && entry.failure === HELD_BACK_NOTICE;
    }, { timeout: 10_000, what: "edited built-in held back" });

    const after = okResult<PluginsView>(await client.req({ type: "plugins.list" }));
    const entry = after.plugins.find((p) => p.name === builtInName)!;
    expect(entry.replacesBuiltIn).toBe(builtInPkg.version);
    expect(entry.commands[0]?.registered).toBe(false);
    expect((await runPluginCommand(client, inc, originEpoch, 1, `${builtInName}.edited`)).outcome.kind).toBe("refused");
    const webRes = await reqLarge(client, { type: "plugins.web" });
    expect(okResult<{ specs: Array<{ name: string }> }>(webRes).specs.some((s) => s.name === builtInName)).toBe(true);
  }, 45_000);

  it("keeps 2.x behavior unchanged when mayRunServerPart is omitted", async () => {
    const unit = await startPluginsUnit({});
    writePlugin(join(unit.dataDir, "plugins"), "legacy.tool", {
      permissions: ["files"],
      commands: [{ id: "legacy.tool.ping", title: "Ping" }],
    });
    unit.plugins.scan();
    await unit.plugins.start();

    await until(() => unit.plugins.view().plugins.find((p) => p.name === "legacy.tool")?.commands[0]?.registered === true, {
      timeout: 10_000,
      what: "legacy plugin started without mayRunServerPart",
    });
    expect(unit.plugins.view().plugins.find((p) => p.name === "legacy.tool")?.failure).toBeNull();
    expect(await unit.plugins.command("legacy.tool.ping")).toBe("pong:legacy.tool");
  });
});
