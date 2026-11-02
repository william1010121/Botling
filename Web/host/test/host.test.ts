// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Host, type BotlingApi, type CcbHost, type HostPluginSpec } from "../src/host";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ccb-host-"));

function spec(name: string, overrides: Partial<HostPluginSpec> = {}): HostPluginSpec {
  return { name, version: "1.0.0", main: "", fingerprint: "1", settings: {}, storageDir: join(scratch, "data", name), ...overrides };
}

/** A host whose plugins are given as functions, and what it wrote. */
function makeHost(plugins: Record<string, (ccb: CcbHost) => unknown>) {
  const written: any[] = [];
  const host = new Host((message) => written.push(message), async (s) => plugins[s.name] as any);
  return { host, written };
}

describe("plugin host (in process)", () => {
  it("browser operations carry the caller identity and exact tab scope", async () => {
    let api: CcbHost;
    const { host, written } = makeHost({ fixture: ccb => { api = ccb; } });
    await host.sync([spec("fixture")]);
    const scope = { origin: "https://fixture.test", account: "a", tab: "t" };
    const pending = api!.browser.perform({ ...scope, operation: "click", target: "observed-1", plugin: "spoof" } as any);
    const request = written.find(m => m.method === "browser.perform");
    expect(request?.params).toEqual({ ...scope, operation: "click", target: "observed-1", plugin: "fixture" });
    await host.receive({ id: request.id, result: { clicked: true } });
    expect(await pending).toEqual({ clicked: true });
  });

  it("website tools route to their plugin and unregister on unload", async () => {
    let api: CcbHost;
    const { host, written } = makeHost({ fixture: ccb => {
      api = ccb;
      ccb.browser.registerTool({ id: "details", title: "Read details", origin: "https://fixture.test" }, async scope => {
        const observed = await ccb.browser.perform({ ...scope, operation: "observe" }) as any;
        await ccb.browser.perform({ ...scope, operation: "click", target: observed.targets[0].id });
        return ccb.browser.perform({ ...scope, operation: "extract", target: "fresh-target" });
      });
    }});
    await host.sync([spec("fixture")]);
    expect(written).toContainEqual({ method: "browser.register", params: { plugin: "fixture", id: "details", title: "Read details", origin: "https://fixture.test" } });
    const scope = { origin: "https://fixture.test", account: "a", tab: "t" };
    const invoke = host.receive({ id: 987, method: "web", params: { plugin: "fixture", method: "browser.tool.details", params: scope } });
    for (const result of [{ targets: [{ id: "current-target" }] }, { clicked: true }, { text: "Fixture detail" }]) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const request = written.filter(m => m.method === "browser.perform").at(-1)!;
      await host.receive({ id: request.id, result });
    }
    await invoke;
    expect(written.find(m => m.id === 987)?.result).toEqual({ text: "Fixture detail" });
    expect(written.filter(m => m.method === "browser.perform").map(m => m.params.operation)).toEqual(["observe", "click", "extract"]);
    await host.sync([]);
    expect(written).toContainEqual({ method: "browser.unregister", params: { plugin: "fixture", id: "details" } });
  });

  it("beforeSend hooks change or stop what is sent, in order", async () => {
    const { host, written } = makeHost({
      upper: (ccb) => { ccb.hooks.beforeSend((m) => m.text.toUpperCase()); },
      tag: (ccb) => { ccb.hooks.beforeSend((m) => ({ ...m, text: `${m.text}!` })); },
      stop: (ccb) => { ccb.hooks.beforeSend((m) => (m.text.includes("SECRET") ? false : undefined)); },
    });
    await host.sync([spec("upper"), spec("tag"), spec("stop")]);
    await host.receive({ id: 1, method: "beforeSend", params: { bot: { id: "b" }, text: "hi" } });
    await host.receive({ id: 2, method: "beforeSend", params: { bot: { id: "b" }, text: "secret" } });
    expect(written.find((m) => m.id === 1)?.result).toEqual({ text: "HI!" });
    expect(written.find((m) => m.id === 2)?.result).toEqual({ cancel: true, by: "stop" });
    await Promise.resolve();
    expect(written.filter((m) => m.method === "registered").at(-1)?.params.beforeSend).toBe(3);
  });

  it("a hook that throws is reported and skipped", async () => {
    const { host, written } = makeHost({
      bad: (ccb) => { ccb.hooks.beforeSend(() => { throw new Error("boom"); }); },
      good: (ccb) => { ccb.hooks.beforeSend((m) => `${m.text}.`); },
    });
    await host.sync([spec("bad"), spec("good")]);
    await host.receive({ id: 1, method: "beforeSend", params: { bot: {}, text: "a" } });
    expect(written.find((m) => m.id === 1)?.result).toEqual({ text: "a." });
    expect(written).toContainEqual({ method: "pluginError", params: { plugin: "bad", message: "boom" } });
  });

  it("a plugin whose activate throws does not load", async () => {
    const { host } = makeHost({ broken: () => { throw new Error("nope"); } });
    const result = await host.sync([spec("broken")]);
    expect(result.failed).toEqual([{ name: "broken", message: "nope" }]);
    expect(host.isLoaded("broken")).toBe(false);
  });

  it("commands, web calls, storage, settings and reloading", async () => {
    const changes: unknown[] = [];
    const disposed: string[] = [];
    const { host, written } = makeHost({
      tool: (ccb) => {
        ccb.commands.register("tool.add", (a, b) => (a as number) + (b as number));
        ccb.web.handle("echo", (params) => ({ got: params }));
        ccb.storage.set("count", (ccb.storage.get("count") as number ?? 0) + 1);
        ccb.settings.onChange("tool.mode", (value) => changes.push(value));
        return () => disposed.push("tool");
      },
    });
    await host.sync([spec("tool", { settings: { "tool.mode": "a" } })]);
    await host.receive({ id: 1, method: "command", params: { id: "tool.add", args: [2, 3] } });
    await host.receive({ id: 2, method: "web", params: { plugin: "tool", method: "echo", params: 7 } });
    expect(written.find((m) => m.id === 1)?.result).toBe(5);
    expect(written.find((m) => m.id === 2)?.result).toEqual({ got: 7 });

    await host.sync([spec("tool", { settings: { "tool.mode": "b" } })]);
    expect(changes).toEqual(["b"]);
    expect(disposed).toEqual([]);

    // A new version (new fingerprint) reloads it; its storage is still there.
    await host.sync([spec("tool", { fingerprint: "2", settings: { "tool.mode": "b" } })]);
    expect(disposed).toEqual(["tool"]);
    expect(JSON.parse(readFileSync(join(scratch, "data/tool/storage.json"), "utf8"))).toEqual({ count: 2 });
  });

  it("ui.expose (and web.handle, its old name) open a method to frames and the chat page; nothing else is answered for them", async () => {
    const { host, written } = makeHost({
      tool: (ccb) => {
        ccb.ui.expose("count", (params) => (params as { n: number }).n + 1);
        ccb.web.handle("echo", (params) => ({ got: params }));
        ccb.browser.registerTool({ id: "details", title: "Details", origin: "https://fixture.test" }, () => "page text");
      },
    });
    await host.sync([spec("tool")]);
    const announced = written.filter((m) => m.method === "registered").at(-1);
    expect(announced?.params.exposed).toEqual({ tool: ["count", "echo"] });
    await host.receive({ id: 1, method: "web", params: { plugin: "tool", method: "count", params: { n: 2 }, from: "frame" } });
    await host.receive({ id: 2, method: "web", params: { plugin: "tool", method: "echo", params: 7, from: "chat" } });
    await host.receive({ id: 3, method: "web", params: { plugin: "tool", method: "browser.tool.details", params: null, from: "frame" } });
    expect(written.find((m) => m.id === 1)?.result).toBe(3);
    expect(written.find((m) => m.id === 2)?.result).toEqual({ got: 7 });
    expect(written.find((m) => m.id === 3)?.error?.message).toBe('Plugin "tool" does not expose "browser.tool.details".');
    await host.sync([]);
    expect(written.filter((m) => m.method === "registered").at(-1)?.params.exposed).toEqual({});
  });

  it("asks Botling for bots and routines, and answers when Botling replies", async () => {
    let list: unknown;
    const { host, written } = makeHost({
      lister: async (ccb) => { list = await ccb.bots.list(); },
    });
    const loading = host.sync([spec("lister")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = written.find((m) => m.method === "bots.list");
    await host.receive({ id: request.id, result: [{ id: "main", name: "Main bot", role: "main", awake: false }] });
    await loading;
    expect(list).toEqual([{ id: "main", name: "Main bot", role: "main", awake: false }]);
  });
});

describe("making bots", () => {
  it("asks Botling to make a bot, naming the plugin, and returns it", async () => {
    let made: unknown;
    const { host, written } = makeHost({
      maker: async (ccb) => { made = await ccb.bots.create({ name: "Morning news", job: "Tech news at 08:00" }); },
    });
    const loading = host.sync([spec("maker")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = written.find((m) => m.method === "bots.create");
    expect(request.params).toEqual({ plugin: "maker", name: "Morning news", job: "Tech news at 08:00" });
    await host.receive({ id: request.id, result: { id: "B1", name: "Morning news", role: "bot", awake: false } });
    await loading;
    expect(made).toEqual({ id: "B1", name: "Morning news", role: "bot", awake: false });
  });
});

/** Answers the host's next request named `method` with `result`, and gives back its params. */
async function answer(host: Host, written: any[], method: string, result: unknown): Promise<any> {
  for (let tries = 0; tries < 50 && !written.some((m) => m.method === method && !m.answered); tries++) await new Promise((resolve) => setTimeout(resolve, 0));
  const request = written.find((m) => m.method === method && !m.answered);
  if (!request) throw new Error(`No ${method} request.`);
  request.answered = true;
  await host.receive({ id: request.id, result });
  return request.params;
}

describe("Host API v3 (plan M5)", () => {
  /** One plugin whose api the test drives. */
  async function loaded(overrides: Partial<HostPluginSpec> = {}) {
    let api!: BotlingApi;
    const made = makeHost({ p: (ccb) => { api = ccb; } });
    await made.host.sync([spec("p", overrides)]);
    return { ...made, api };
  }

  it("the old CcbHost and BotlingApi are one object; it knows its plugin", async () => {
    const { api } = await loaded({ version: "2.1.0", main: "/plugins/p/dist/host.mjs" });
    const old: CcbHost = api;
    expect(old.name).toBe("p");
    expect(api.plugin).toEqual({ name: "p", version: "2.1.0", dir: "/plugins/p/dist", storageDir: join(scratch, "data", "p") });
    expect(old.web.handle).toBe(api.ui.expose);
  });

  it("exec runs a shell command with its output and exit code", async () => {
    const { api } = await loaded();
    expect(await api.exec("echo out; echo err >&2; exit 3")).toEqual({ stdout: "out\n", stderr: "err\n", code: 3, timedOut: false });
    expect((await api.exec("pwd")).stdout.trim()).toBe(realpathSync(join(scratch, "data", "p")));
    expect((await api.exec("echo $GREETING", { env: { GREETING: "hi" } })).stdout).toBe("hi\n");
  });

  it("exec ends the command's whole group at its time limit, and caps its output", async () => {
    const { api } = await loaded();
    const marker = join(scratch, `grandchild-${Date.now()}`);
    const slow = await api.exec(`(sleep 1; touch ${marker}) & sleep 5`, { timeoutMs: 200 });
    expect(slow).toMatchObject({ code: null, timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(existsSync(marker)).toBe(false);
    const loud = await api.exec("yes", { maxBytes: 1000 });
    expect(loud.stdout.length).toBe(1000);
    expect(loud.code).toBeNull();
  });

  it("spawn streams a child's output; the plugin's children end when it unloads", async () => {
    const { host, api } = await loaded();
    const echo = api.spawn("/bin/sh", ["-c", "read line; echo got $line"]);
    const out: string[] = [];
    echo.onStdout((chunk) => out.push(chunk));
    echo.write("ping\n");
    expect(await echo.exited).toEqual({ code: 0, signal: null });
    expect(out.join("")).toBe("got ping\n");
    const sleeper = api.spawn("sleep", ["30"]);
    expect(alive(sleeper.pid!)).toBe(true);
    await host.sync([]);
    expect((await sleeper.exited).signal).toBe("SIGTERM");
    const missing = api.spawn(join(scratch, "no-such-program"), []);
    expect(await missing.exited).toEqual({ code: null, signal: null });
  });

  it("bots.send shows as the plugin's unless it asks to send as the user; it gives the message id", async () => {
    const { host, written, api } = await loaded();
    const sent = api.bots.send("main", "hello");
    expect(await answer(host, written, "bots.send", { messageId: "M1" })).toEqual({ plugin: "p", bot: "main", text: "hello", as: "plugin" });
    expect(await sent).toEqual({ messageId: "M1" });
    const asUser = api.bots.send("main", "hi", { as: "user" });
    expect((await answer(host, written, "bots.send", { messageId: "M2" })).as).toBe("user");
    await asUser;
  });

  it("an old plugin that ignores bots.send's answer is not blamed when it fails", async () => {
    const { host, written, api } = await loaded();
    void api.bots.send("nobody", "hello");
    const request = written.find((m) => m.method === "bots.send");
    await host.receive({ id: request.id, error: { message: "No such bot." } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written.some((m) => m.method === "pluginError")).toBe(false);
  });

  it("bots.wake and bots.interrupt ask Botling, naming the plugin", async () => {
    const { host, written, api } = await loaded();
    const woke = api.bots.wake("B1", "Check the build");
    expect(await answer(host, written, "bots.wake", null)).toEqual({ plugin: "p", bot: "B1", prompt: "Check the build" });
    await woke;
    const stopped = api.bots.interrupt("B1");
    expect(await answer(host, written, "bots.interrupt", { stopped: true })).toEqual({ plugin: "p", bot: "B1" });
    await stopped;
    const refused = api.bots.interrupt("B1");
    const request = written.filter((m) => m.method === "bots.interrupt").at(-1);
    await host.receive({ id: request.id, error: { message: 'Stopping bots needs the "bots" capability.' } });
    await expect(refused).rejects.toThrow(/capability/);
  });

  it("ui: notify with a level and actions, quickPick, input, openView and setStatus", async () => {
    const { host, written, api } = await loaded();
    api.ui.notify("Deploy failed", { level: "error", actions: [{ title: "Retry", command: "p.retry" }] });
    api.notify("old notice");
    expect(written.filter((m) => m.method === "notify").map((m) => m.params)).toEqual([
      { plugin: "p", text: "Deploy failed", level: "error", actions: [{ title: "Retry", command: "p.retry" }] },
      { plugin: "p", text: "old notice" },
    ]);
    const picked = api.ui.quickPick([{ id: "a", label: "A" }, { id: "b", label: "B", detail: "the second" }], { title: "Which?" });
    expect(await answer(host, written, "ui.quickPick", "b")).toEqual({ plugin: "p", items: [{ id: "a", label: "A" }, { id: "b", label: "B", detail: "the second" }], title: "Which?" });
    expect(await picked).toBe("b");
    const typed = api.ui.input({ title: "Name?", placeholder: "a name" });
    expect(await answer(host, written, "ui.input", null)).toEqual({ plugin: "p", title: "Name?", placeholder: "a name" });
    expect(await typed).toBeNull();
    const opened = api.ui.openView("p.board", { tab: 2 });
    expect(await answer(host, written, "ui.openView", null)).toEqual({ plugin: "p", id: "p.board", args: { tab: 2 } });
    await opened;
    api.ui.setStatus("build", { text: "Building", tooltip: "since 10:02" });
    api.ui.setStatus("build", null);
    expect(written.filter((m) => m.method === "ui.setStatus").map((m) => m.params)).toEqual([
      { plugin: "p", id: "build", item: { text: "Building", tooltip: "since 10:02" } },
      { plugin: "p", id: "build", item: null },
    ]);
  });

  it("settings.update asks Botling; settings.app reads Botling's settings, and a change there does not reload the plugin", async () => {
    let activations = 0;
    let api!: BotlingApi;
    const { host, written } = makeHost({ p: (ccb) => { api = ccb; activations++; } });
    await host.sync([spec("p", { app: { language: "en", botLook: "cute", workerLimit: 4 } })]);
    expect(api.settings.app("language")).toBe("en");
    expect(api.settings.app("workerLimit")).toBe(4);
    await host.sync([spec("p", { app: { language: "zh-Hant", botLook: "cute", workerLimit: 4 } })]);
    expect(api.settings.app("language")).toBe("zh-Hant");
    expect(activations).toBe(1);
    const updated = api.settings.update("p.mode", "fast");
    expect(await answer(host, written, "settings.update", null)).toEqual({ plugin: "p", key: "p.mode", value: "fast" });
    await updated;
  });

  it("secrets.get and secrets.set ask Botling, naming the plugin", async () => {
    const { host, written, api } = await loaded();
    const got = api.secrets.get("token");
    expect(await answer(host, written, "secrets.get", "tok")).toEqual({ plugin: "p", key: "token" });
    expect(await got).toBe("tok");
    const set = api.secrets.set("token", null);
    expect(await answer(host, written, "secrets.set", null)).toEqual({ plugin: "p", key: "token", value: null });
    await set;
  });

  it("keybindings.list and keybindings.set ask Botling", async () => {
    const { host, written, api } = await loaded();
    const list = api.keybindings.list();
    await answer(host, written, "keybindings.list", [{ command: "search", key: "Mod+K", source: "default" }]);
    expect(await list).toEqual([{ command: "search", key: "Mod+K", source: "default" }]);
    const set = api.keybindings.set("p.open", "cmd+shift+o");
    expect(await answer(host, written, "keybindings.set", { ok: false, conflict: "search" })).toEqual({ plugin: "p", command: "p.open", key: "cmd+shift+o" });
    expect(await set).toEqual({ ok: false, conflict: "search" });
  });

  it("events.on: Botling is told which events are listened to; each reaches its listeners until they are disposed", async () => {
    const seen: unknown[] = [];
    let off!: () => void;
    const { host, written } = makeHost({
      listener: (ccb) => {
        off = ccb.events.on("turnFinished", (t) => seen.push(t));
        ccb.events.on("workerDone", () => { throw new Error("listener broke"); });
        expect(() => ccb.events.on("nothing" as any, () => {})).toThrow(/No event "nothing"/);
      },
    });
    await host.sync([spec("listener")]);
    await Promise.resolve();
    expect(written.filter((m) => m.method === "registered").at(-1)?.params.events).toEqual(["turnFinished", "workerDone"]);
    await host.receive({ method: "event", params: { name: "turnFinished", data: { botId: "main", ok: true, reply: "done" } } });
    await host.receive({ method: "event", params: { name: "workerDone", data: { botId: "main", workerId: "w", status: "completed", report: "" } } });
    expect(seen).toEqual([{ botId: "main", ok: true, reply: "done" }]);
    expect(written).toContainEqual({ method: "pluginError", params: { plugin: "listener", message: "listener broke" } });
    off();
    await Promise.resolve();
    expect(written.filter((m) => m.method === "registered").at(-1)?.params.events).toEqual(["workerDone"]);
    await host.receive({ method: "event", params: { name: "turnFinished", data: {} } });
    expect(seen).toHaveLength(1);
  });

  it("subscriptions are disposed when the plugin unloads", async () => {
    const disposed: string[] = [];
    const { host } = makeHost({ p: (ccb) => { ccb.subscriptions.push(() => disposed.push("a"), () => disposed.push("b")); } });
    await host.sync([spec("p")]);
    await host.sync([]);
    expect(disposed).toEqual(["b", "a"]);
  });
});

describe("workspace (plan W1)", () => {
  async function loaded() {
    let api!: BotlingApi;
    const made = makeHost({ p: (ccb) => { api = ccb; } });
    await made.host.sync([spec("p")]);
    return { ...made, api };
  }

  it("each read asks Botling, naming the plugin, with what it was given", async () => {
    const { host, written, api } = await loaded();
    const cases: [Promise<unknown>, string, Record<string, unknown>, unknown][] = [
      [api.workspace.bots(), "workspace.bots", {}, [{ id: "main" }]],
      [api.workspace.memory("B1"), "workspace.memory", { bot: "B1" }, { currentStatus: [], inProgress: [], decided: [], waitingOnYou: [] }],
      [api.workspace.tasks("B1", { limit: 5 }), "workspace.tasks", { bot: "B1", limit: 5 }, []],
      [api.workspace.tasks("B1"), "workspace.tasks", { bot: "B1" }, []],
      [api.workspace.taskHistory("B1", 7), "workspace.taskHistory", { bot: "B1", days: 7 }, [{ day: "2026-11-02", done: 1, manual: 0 }]],
      [api.workspace.results("B1", { limit: 2 }), "workspace.results", { bot: "B1", limit: 2 }, [{ label: "Site", url: "https://x" }]],
      [api.workspace.waiting(), "workspace.waiting", {}, { items: [], doing: {} }],
      [api.workspace.ignoreWaiting("B1", "Pick one"), "workspace.ignoreWaiting", { bot: "B1", text: "Pick one" }, null],
      [api.workspace.pendingApprovals("B1"), "workspace.pendingApprovals", { bot: "B1" }, []],
      [api.workspace.face("B1", "cute"), "workspace.face", { bot: "B1", look: "cute" }, "data:image/svg+xml;base64,AA"],
    ];
    for (const [promise, method, params, result] of cases) {
      expect(await answer(host, written, method, result)).toEqual({ ...params, plugin: "p" });
      expect(await promise).toEqual(method === "workspace.ignoreWaiting" ? undefined : result);
    }
  });

  it("onChange: Botling is told at once (before any read that follows it), and each change reaches the listeners until disposed", async () => {
    const seen: unknown[] = [];
    let off!: () => void;
    const { host, written } = makeHost({
      board: (ccb) => {
        off = ccb.workspace.onChange((change) => seen.push(change));
        void ccb.workspace.bots();
      },
    });
    await host.sync([spec("board")]);
    // Said before the read it made right after listening: what it reads is at least as new as the watch's start.
    const said = written.findIndex((m) => m.method === "registered" && m.params.events.includes("workspace.changed"));
    const read = written.findIndex((m) => m.method === "workspace.bots");
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(read);
    // `events.on` does not take the workspace's own event.
    const change = { stamp: "e:1", botIds: ["B1"], kinds: ["tasks"] };
    await host.receive({ method: "event", params: { name: "workspace.changed", data: change } });
    expect(seen).toEqual([change]);
    off();
    await Promise.resolve();
    expect(written.filter((m) => m.method === "registered").at(-1)?.params.events).toEqual([]);
    await host.receive({ method: "event", params: { name: "workspace.changed", data: change } });
    expect(seen).toHaveLength(1);
  });

  it("events.on does not hear the workspace's changes (they are onChange's)", async () => {
    const { api } = await loaded();
    expect(() => api.events.on("workspace.changed" as any, () => {})).toThrow(/No event/);
  });
});

describe("plugin host (the real Node process)", () => {
  const script = join(scratch, "host.mjs");
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(async () => {
    await build({ entryPoints: [join(here, "../src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: script });
  });

  afterEach(() => child?.kill());

  it("speaks JSON-RPC on stdin/stdout and keeps plugin logs off stdout", async () => {
    const plugin = join(scratch, "shout.mjs");
    writeFileSync(plugin, `export function activate(ccb) {
      console.log("this goes to stderr");
      ccb.hooks.beforeSend((m) => m.text.replace("cat", "🐈"));
      ccb.notify("ready to shout");
    }`);
    child = spawn(process.execPath, [script], { env: { ...process.env, CCB_PLUGIN_HOST: "1" } });
    const messages: any[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      messages.push(JSON.parse(line));
      waiters.splice(0).forEach((wake) => wake());
    });
    const next = async (match: (m: any) => boolean) => {
      while (!messages.some(match)) await new Promise<void>((wake) => waiters.push(wake));
      return messages.find(match);
    };
    const send = (message: unknown) => child!.stdin.write(JSON.stringify(message) + "\n");

    await next((m) => m.method === "ready");
    send({ id: 1, method: "load", params: { plugins: [spec("shout", { main: plugin })] } });
    expect((await next((m) => m.id === 1)).result).toEqual({ loaded: ["shout"], failed: [] });
    expect((await next((m) => m.method === "notify")).params).toEqual({ plugin: "shout", text: "ready to shout" });
    send({ id: 2, method: "beforeSend", params: { bot: { id: "main" }, text: "one cat" } });
    expect((await next((m) => m.id === 2)).result).toEqual({ text: "one 🐈" });
  });
});
