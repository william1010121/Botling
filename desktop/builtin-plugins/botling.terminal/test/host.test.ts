// botling.terminal's program part against a fake Botling API: the one method its frames call ("terminal"), the folder a shell starts
// in (the bot's own, from the core; never the frame's), the push of what a shell prints, and what happens when a bot goes or the plugin unloads.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activate } from "../src/host";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fake(folders: Record<string, string | null> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botling-terminal-host-"))); dirs.push(dir);
  const folder = join(dir, "project"); require("node:fs").mkdirSync(folder);
  const bots: Record<string, string | null> = { B1: folder, ...folders };
  const exposed = new Map<string, (params: unknown) => unknown>();
  const events = new Map<string, (data: any) => void>();
  const commands: string[] = [], emitted: [string, any, any][] = [], processes: any[] = [], spawned: { shell: string; cwd: string }[] = [];
  const api = {
    subscriptions: [] as (() => void)[],
    plugin: { name: "botling.terminal", version: "1", dir, storageDir: join(dir, "storage") },
    bots: { folder: async (id: string) => bots[id] ?? null },
    events: { on: (name: string, fn: (data: any) => void) => { events.set(name, fn); return () => {}; } },
    commands: { register: (id: string) => { commands.push(id); return () => {}; } },
    ui: {
      expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => {}; },
      emit: (name: string, data: unknown, opts: unknown) => { emitted.push([name, data, opts]); },
    },
  };
  const spawnPty = ((shell: string, _args: string[], options: { cwd: string }) => {
    spawned.push({ shell, cwd: options.cwd });
    const p = { written: "", killed: 0, onData(cb: any) { this.data = cb; return { dispose() {} }; }, onExit(cb: any) { this.exit = cb; return { dispose() {} }; }, write(d: string) { this.written += d; }, kill() { this.killed++; } } as any;
    processes.push(p); return p;
  }) as never;
  const call = (request: unknown) => Promise.resolve(exposed.get("terminal")!(request)) as Promise<any>;
  return { api: api as unknown as BotlingApi, call, exposed, events, commands, emitted, processes, spawned, folder, dir, spawnPty };
}

it("exposes one method, registers the toggle command the page runs, and opens a shell in the bot's own folder", async () => {
  const f = fake();
  await activate(f.api, { spawnPty: f.spawnPty });
  expect([...f.exposed.keys()]).toEqual(["terminal"]);
  expect(f.commands).toEqual(["botling.terminal.toggle"]);
  const tab = await f.call({ type: "open", botId: "B1" });
  expect(f.spawned).toEqual([{ shell: expect.any(String), cwd: f.folder }]);
  expect(await f.call({ type: "list", botId: "B1" })).toEqual([expect.objectContaining({ sessionId: tab.sessionId, exitCode: null })]);
  await f.call({ type: "input", botId: "B1", sessionId: tab.sessionId, data: "ls\r" });
  expect(f.processes[0].written).toBe("ls\r");
});

it("gives the frame the terminal font (it has no files of its own), once read, as base64", async () => {
  const f = fake();
  const font = join(f.dir, "font.ttf");
  require("node:fs").writeFileSync(font, Buffer.from([0, 1, 2, 250, 251]));
  await activate(f.api, { spawnPty: f.spawnPty, fontFile: font });
  expect(await f.call({ type: "font" })).toEqual({ font: Buffer.from([0, 1, 2, 250, 251]).toString("base64") });
  require("node:fs").rmSync(font);
  expect(await f.call({ type: "font" })).toEqual({ font: Buffer.from([0, 1, 2, 250, 251]).toString("base64") });
});

it("does not take a folder, program or any other field from the frame; an unknown or removed bot gets nothing", async () => {
  const f = fake({ gone: null });
  await activate(f.api, { spawnPty: f.spawnPty });
  await expect(f.call({ type: "open", botId: "B1", cwd: "/tmp" })).rejects.toThrow();
  await expect(f.call({ type: "open", botId: "gone" })).rejects.toThrow("no longer available");
  await expect(f.call({ type: "nonsense" })).rejects.toThrow();
  expect(f.spawned).toEqual([]);
  f.events.get("botRemoved")!({ botId: "B1" });
  await expect(f.call({ type: "open", botId: "B1" })).rejects.toThrow("no longer available");
});

it("pushes what a shell prints to that bot's frames, with the offset to acknowledge, and its exit", async () => {
  const f = fake();
  await activate(f.api, { spawnPty: f.spawnPty });
  const tab = await f.call({ type: "open", botId: "B1" });
  f.processes[0].data("hello");
  f.processes[0].exit({ exitCode: 0 });
  expect(f.emitted).toEqual([
    ["terminal", { type: "data", botId: "B1", sessionId: tab.sessionId, data: "hello", offset: 5 }, { botId: "B1" }],
    ["terminal", { type: "exit", botId: "B1", sessionId: tab.sessionId, exitCode: 0 }, { botId: "B1" }],
  ]);
  const attached = await f.call({ type: "attach", botId: "B1", sessionId: tab.sessionId });
  expect(attached).toMatchObject({ output: "hello", offset: 5 });
});

it("ends a removed bot's shells, and every shell when the plugin unloads", async () => {
  const f = fake({ B2: f_folder() });
  function f_folder() { return process.cwd(); }
  await activate(f.api, { spawnPty: f.spawnPty });
  await f.call({ type: "open", botId: "B1" });
  await f.call({ type: "open", botId: "B2" });
  f.events.get("botRemoved")!({ botId: "B1" });
  expect(f.processes.map((p) => p.killed)).toEqual([1, 0]);
  // The host disposes a plugin's subscriptions last to first when it unloads it.
  for (const dispose of f.api.subscriptions.splice(0).reverse()) dispose();
  expect(f.processes.map((p) => p.killed)).toEqual([1, 1]);
  await expect(f.call({ type: "open", botId: "B2" })).rejects.toThrow("shutting down");
});
