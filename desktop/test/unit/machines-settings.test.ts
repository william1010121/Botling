// @vitest-environment jsdom
// Settings › Machines (multi-machine phase 1, M4): the machines.* commands the core answers from RemoteWorkers, the
// page that adds an ssh host or a relay machine (install line, then the code the machine shows), checks, revokes and
// removes; a bot's default machine for its Claude workers; and the worker row that names its machine.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_COMMANDS, RENDERER_COMMANDS, parseInbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { ClaudeWorkerAdapter } from "../../src/core/agent/claude-workers";
import { RemoteWorkers } from "../../src/remote/service";
import { MachinesSettings } from "../../src/renderer/MachinesSettings";
import { machinesWords } from "../../src/renderer/machines-text";
import { RailWorkerList } from "../../src/renderer/RailWorkers";
import { railWorkers } from "../../src/renderer/rail-workers";
import type { Client } from "../../src/renderer/client";
import { tempDir } from "../helpers";

const open = (dataDir: string, remoteWorkers: RemoteWorkers | null) => new Core({ dataDir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
  routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0, remoteWorkers });
// No relay address (nothing connects) and a transport that cannot be checked (nothing is reached over ssh).
const remoteIn = (dir: string) => new RemoteWorkers({ dataDir: dir, bundle: join(dir, "no-bundle.cjs"), relayUrl: () => null, transport: () => ({}) as never });
const KEY = { fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", lines: ["ssh-ed25519 AAAAtest"], known: false };

describe("machines commands", () => {
  it("are renderer-only commands", () => {
    for (const type of ["machines.view", "machines.hosts", "machines.pair", "machines.add", "machines.approve", "machines.decline", "machines.revoke", "machines.remove", "machines.check"] as const) {
      expect(RENDERER_COMMANDS.has(type)).toBe(true); expect(MAIN_COMMANDS.has(type)).toBe(false);
    }
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "machines.add", host: "box" } }).ok).toBe(true);
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "machines.add", host: "" } }).ok).toBe(false);
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "machines.approve", id: "m", code: "ABCD-EFGH" } }).ok).toBe(true);
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "machines.view", extra: 1 } }).ok).toBe(false);
  });

  it("are off without remote workers", async () => {
    const core: any = open(tempDir("machines-off"), null);
    try {
      core.activated = true;
      const run = (cmd: any) => core.handle(cmd, new AbortController().signal);
      expect(await run({ type: "machines.view" })).toEqual({ enabled: false, relay: { url: null, state: "off" }, machines: [] });
      await expect(run({ type: "machines.pair" })).rejects.toThrow(/not available/);
      await expect(run({ type: "bot.configure", botId: MAIN_BOT_ID, workerMachine: "box" })).rejects.toThrow(/not available/);
    } finally { await core.shutdown?.(); }
  });

  it("list, approve, check, revoke and remove machines, and set a bot's workers' machine", async () => {
    const dir = tempDir("machines-core"), remote = remoteIn(join(dir, "remote-data")), core: any = open(dir, remote);
    try {
      core.activated = true;
      const run = (cmd: any) => core.handle(cmd, new AbortController().signal);
      expect(await run({ type: "machines.view" })).toEqual({ enabled: true, relay: { url: null, state: "off" }, machines: [] });
      // The relay line needs a relay address.
      await expect(run({ type: "machines.pair" })).rejects.toThrow(/relay address/);
      const asked = remote.machines.add({ name: "box", via: "ssh", host: "box.lan", hostKey: KEY });
      const listed = await run({ type: "machines.view" });
      expect(listed.machines).toEqual([{ id: asked.id, name: "box", via: "ssh", trust: "asked", host: "box.lan", fingerprint: KEY.fingerprint, known: false, waiting: false, connected: false, info: null, workers: 0 }]);
      expect(JSON.stringify(listed)).not.toContain("AAAAtest");
      // Not approved yet: no bot may default to it.
      await expect(run({ type: "bot.configure", botId: MAIN_BOT_ID, workerMachine: "box" })).rejects.toThrow(/not approved yet/);

      // Approve (ssh): the key; the check that follows cannot reach this machine (no transport here), and says why.
      const approved = await run({ type: "machines.approve", id: asked.id });
      expect(approved.machines[0]).toMatchObject({ trust: "trusted" });
      await expect(run({ type: "machines.check", id: asked.id })).rejects.toThrow(/cannot be checked/);
      // A check that ran and failed is shown in the machine's info.
      remote.machines.update(asked.id, { info: { at: 5, error: "ssh: connect to host box.lan port 22: Connection refused" } });
      expect((await run({ type: "machines.view" })).machines[0].info).toEqual({ node: null, git: null, claude: null, platform: null, at: 5, error: "ssh: connect to host box.lan port 22: Connection refused" });

      await expect(run({ type: "bot.configure", botId: MAIN_BOT_ID, workerMachine: "nowhere" })).rejects.toThrow(/No machine named "nowhere"/);
      expect((await run({ type: "bot.configure", botId: MAIN_BOT_ID, workerMachine: "BOX" })).workerMachine).toBe("box");
      expect((await run({ type: "bot.settings", botId: MAIN_BOT_ID })).workerMachine).toBe("box");
      expect((await run({ type: "bot.configure", botId: MAIN_BOT_ID, workerMachine: null })).workerMachine).toBeNull();

      expect((await run({ type: "machines.revoke", id: asked.id })).machines[0].trust).toBe("revoked");
      expect((await run({ type: "machines.remove", id: asked.id })).machines).toEqual([]);
      await expect(run({ type: "machines.approve", id: "nope" })).rejects.toThrow(/No such machine/);
      // A bad name is refused before ssh is run.
      await expect(run({ type: "machines.add", host: "box", name: "no spaces" })).rejects.toThrow(/name/);
    } finally { await core.shutdown?.(); }
  });
});

describe("a bot's workers' machine", () => {
  const host = {
    resolve: (name: string) => (name === "box" ? { id: "m1", name: "box" } : { error: `No machine named "${name}". Nothing was started.` }),
    head: () => { throw new Error("not here"); },
  };
  const adapter = (machine: string | null) => new ClaudeWorkerAdapter({ base: () => null, cwd: () => "/tmp", subagentModel: () => null, remote: () => host, defaultMachine: () => machine } as never, () => { throw new Error("no"); });
  const request = (args: Record<string, unknown>) => ({ instructions: "x", name: "W", type: null, model: null, args } as never);

  it("is used when app_handoff names none; \"local\" or another name wins; a default that cannot be used is refused", () => {
    expect((adapter("box").prepare(request({})) as any).engineData).toMatchObject({ machine: "m1", machineName: "box" });
    expect((adapter("box").prepare(request({ machine: "local" })) as any).engineData.machine).toBeUndefined();
    expect((adapter(null).prepare(request({})) as any).engineData.machine).toBeUndefined();
    expect((adapter(null).prepare(request({ machine: "box" })) as any).engineData.machine).toBe("m1");
    expect(() => adapter("gone").prepare(request({}))).toThrow(/run on gone by default .*machine "local"/);
  });
});

describe("Settings › Machines", () => {
  const words = machinesWords("en");
  async function mount(request: (cmd: any) => Promise<any>) {
    const el = document.createElement("div"); document.body.append(el);
    const root = createRoot(el); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(MachinesSettings, { client: { request } as unknown as Client, lang: "en" })));
    await act(async () => {});
    return { el, done: async () => { await act(async () => root.unmount()); el.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
  }
  const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => (el as HTMLElement).click()); };
  const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const machine = (patch: Record<string, unknown>) => ({ id: "m1", name: "box", via: "ssh", trust: "trusted", host: "box", fingerprint: null, known: false, waiting: false, connected: false, info: null, workers: 0, ...patch });

  it("says so when remote workers are off", async () => {
    const m = await mount(async () => ({ enabled: false, relay: { url: null, state: "off" }, machines: [] }));
    try { expect(m.el.textContent).toContain(words.off); expect(m.el.querySelector("button")).toBeNull(); } finally { await m.done(); }
  });

  it("adds an ssh host, approves its key, makes a relay install line and approves a machine with its code", async () => {
    const calls: any[] = [];
    let machines: any[] = [machine({ info: { node: "v20.1.0", git: "git version 2.43.0", claude: "2.1.0 (Claude Code)", platform: "linux x64", at: 1, error: null }, workers: 1 })];
    const view = () => ({ enabled: true, relay: { url: "wss://relay.example/ws", state: "online" }, machines });
    const line = "curl -fsSL https://example/v1/botling-agent-install.sh | sh -s -- 'botling-machine1.SECRET'";
    const m = await mount(async (cmd) => {
      calls.push(cmd);
      switch (cmd.type) {
        case "machines.view": return view();
        case "machines.hosts": return { hosts: ["mylinux", "gpu"] };
        case "machines.add": machines = [...machines, machine({ id: "m2", name: cmd.name ?? cmd.host, host: cmd.host, trust: "asked", fingerprint: "SHA256:key" })]; return view();
        case "machines.approve": machines = machines.map((x) => (x.id === cmd.id ? { ...x, trust: "trusted" } : x)); return view();
        case "machines.pair": return { command: line, expiresAt: Date.now() + 600_000 };
        default: return view();
      }
    });
    try {
      expect(m.el.textContent).toContain("box");
      expect(m.el.textContent).toContain("Node 20.1.0");
      expect(m.el.textContent).toContain(words.workers(1));
      // ssh: the first host in ~/.ssh/config, its key read; then approved.
      await click(button(m.el, words.add));
      expect(calls.find((c) => c.type === "machines.add")).toEqual({ type: "machines.add", host: "mylinux" });
      expect(m.el.textContent).toContain("SHA256:key");
      await click(button(m.el, words.approveKey));
      expect(calls.find((c) => c.type === "machines.approve")).toEqual({ type: "machines.approve", id: "m2" });

      // relay: the line, shown until hidden; then the machine asks and its code approves it.
      await click(button(m.el, words.create));
      expect(m.el.querySelector(".machine-command")?.textContent).toBe(line);
      machines = [...machines, machine({ id: "m3", name: "nas", via: "relay", host: null, trust: "asked", fingerprint: "AB12 CD34", waiting: true })];
      await act(async () => { await new Promise((r) => setTimeout(r, 2_100)); });
      const input = m.el.querySelector<HTMLInputElement>(`input[aria-label="${words.codeLabel} (nas)"]`)!;
      expect(input).toBeTruthy();
      await type(input, "abcd-efgh");
      await click(button(m.el, words.approve));
      expect(calls.filter((c) => c.type === "machines.approve").at(-1)).toEqual({ type: "machines.approve", id: "m3", code: "abcd-efgh" });
      // The line was for that pairing: gone.
      expect(m.el.querySelector(".machine-command")).toBeNull();

      // Revoke asks first.
      await click(button(m.el, `${words.revoke} box`));
      expect(m.el.textContent).toContain(words.revokeAsk("box"));
      await click(button(m.el, words.revokeYes));
      expect(calls.at(-1)).toEqual({ type: "machines.revoke", id: "m1" });
    } finally { await m.done(); }
  }, 15_000);
});

describe("a worker row on another machine", () => {
  it("names the machine, and says when it is not connected", () => {
    const row = { id: "w1", title: "Build", status: "running", head: "claude", startedAt: 1, endedAt: null, unsettledAt: null, settled: false, prompt: "x", machine: { name: "mylinux", connected: false } } as any;
    const bot = { id: "b", name: "b", role: "main", subagentRows: [row] } as any;
    const list = railWorkers(bot, [bot], 2, { viewed: new Set(), since: 0, watching: null, folded: new Set(), all: new Set() });
    const html = renderToStaticMarkup(createElement(RailWorkerList, { botId: "b", list, name: "b", now: 2, lang: "en", actions: { onOpen() {}, onSettle() {}, onAll() {}, onToggleJob() {} } }));
    expect(html).toContain('data-machine="mylinux"');
    expect(html).toContain("on mylinux (not connected)");
  });
});
