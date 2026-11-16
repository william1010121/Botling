// M7-O04 (the O03a review's F6, G1, G2, R7 and the Maintainer decision): a plugin that is not shipped cannot get a worker without the checks
// of `workers.start` (declared and granted permission, quota, the user's card for a plugin a bot wrote, a worker with fewer rights) by
// sending a bot a message (`bots.send`, `bots.wake`) or by adding a routine (`routines.add`); a bot-written plugin is asked again for a new
// instruction (`workers.send`), works only on bots it made, has one card open at a time; Maintainer is never a target; and
// "the user granted `orchestrate`" is false in the real core unless `pluginCapability` says so. Two layers: `PluginWorkers` alone, and the real core.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Core as RealCore } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { ADMITTED, PluginWorkers, type OrchestrationWorld, type PluginFacts, type WorkerPort } from "../../src/core/orchestration/plugin-workers";
import type { Core } from "../../src/core/server";
import type { AppAnswer, AppQuestion } from "../../src/core/plugins";
import { tempDir } from "../helpers";
import { claudeHarness } from "../claude-workers-fake";

const ALL = ["orchestrate", "exec", "files", "bots"];
type Handoff = { task_id: string; run: number };

/** `PluginWorkers` over fakes. `written`: the plugin is one a bot wrote; `made`: the bots it made. */
function book(options: { written?: boolean; installed?: boolean; made?: string[]; granted?: boolean; atOnce?: number; ask?: (q: AppQuestion) => Promise<AppAnswer | null>; permissions?: string[] } = {}) {
  const log = { started: [] as Record<string, unknown>[], sent: [] as string[], cards: [] as string[] };
  const port: WorkerPort = {
    id: "b1",
    start: async (args) => { log.started.push(args); return { task_id: `T${log.started.length}`, run: 1 }; },
    send: async (_id, text) => { log.sent.push(text); return { ok: true, how: "steered", run: 1 }; },
    stop: async () => true,
  };
  const world: OrchestrationWorld = {
    granted: () => options.granted ?? true,
    ...(options.installed === undefined ? {} : { installed: () => options.installed === true }),
    workers: (bot) => (bot === "b1" ? port : "No such bot."),
    made: (_plugin, bot) => (options.made ?? ["b1"]).includes(bot),
    quota: () => ({ atOnce: options.atOnce ?? 4 }),
    specWriters: () => ["opus"],
  };
  const facts = (): PluginFacts => ({ name: "p", identity: "a".repeat(64), permissions: options.permissions ?? ALL, botWritten: options.written ?? false });
  const workers = new PluginWorkers({
    world, facts,
    ask: options.ask ?? (async (question) => { log.cards.push(question.text); return { index: 0 }; }),
    tell: () => {},
  });
  return { workers, log };
}

/** What a bot's own `app_handoff` does once a plugin's message is in its turn: `run` is the handoff (the count says whether it ran). */
function handoff(book: PluginWorkers, args: Record<string, unknown>, kind = "claude-process", bot = "b1") {
  const ran = { n: 0, args: undefined as Record<string, unknown> | undefined };
  const run = async (): Promise<Handoff> => { ran.n += 1; ran.args = { ...args }; return { task_id: `H${ran.n}`, run: 1 }; };
  return { ran, result: book.admitHeard("p", bot, kind, args, run) };
}

describe("F6: a worker the bot starts after a plugin's message goes through the checks of workers.start", () => {
  it("is refused without the permission (not declared, or not granted), and the handoff never runs", async () => {
    for (const options of [{ permissions: ["exec", "files", "bots"] }, { granted: false }]) {
      const { workers } = book(options);
      const h = handoff(workers, { instructions: "do it" });
      await expect(h.result).rejects.toThrow(/permission/);
      expect(h.ran.n).toBe(0);
    }
  });

  it("is refused when a model that may write spec/ is asked for, and when a kind is not a Claude-process worker", async () => {
    const { workers } = book();
    const spec = handoff(workers, { instructions: "x", model: "opus" });
    await expect(spec.result).rejects.toThrow(/spec\//);
    const other = handoff(workers, { instructions: "x" }, "codex-thread");
    await expect(other.result).rejects.toThrow(/Claude-process/);
    expect(spec.ran.n + other.ran.n).toBe(0);
  });

  it("takes only what workers.start takes: machine, subagent_type, isolated_git, role and another engine are refused", async () => {
    const { workers } = book();
    for (const extra of [{ machine: "m1" }, { subagent_type: "general" }, { isolated_git: true }, { role: "r" }, { engine: "codex" }]) {
      const h = handoff(workers, { instructions: "x", ...extra });
      await expect(h.result, JSON.stringify(extra)).rejects.toThrow(/not accepted/);
      expect(h.ran.n).toBe(0);
    }
  });

  it("runs with fewer rights (the pluginStarted mark) and takes a place of the quota, given back when the worker ends", async () => {
    const { workers } = book({ atOnce: 2 });
    const first = handoff(workers, { instructions: "one", name: "n", model: "sonnet", effort: "low", group: "g" });
    await expect(first.result).resolves.toMatchObject({ task_id: "H1" });
    expect(first.ran.args).toMatchObject({ instructions: "one", pluginStarted: true });
    await handoff(workers, { instructions: "two" }).result;
    const third = handoff(workers, { instructions: "three" });
    await expect(third.result).rejects.toThrow(/2 workers at work/);
    expect(third.ran.n).toBe(0);
    workers.ended("H1", 1, "done", "report");
    await expect(handoff(workers, { instructions: "four" }).result).resolves.toBeTruthy();
  });

  it("gives the room back when the handoff fails", async () => {
    const { workers } = book({ atOnce: 1 });
    await expect(workers.admitHeard("p", "b1", "claude-process", { instructions: "x" }, async () => { throw new Error("no head"); })).rejects.toThrow("no head");
    await expect(handoff(workers, { instructions: "y" }).result).resolves.toBeTruthy();
  });

  it("a handoff this book already checked (ADMITTED, a symbol no model's JSON can carry) is not checked twice; the string 'ADMITTED' is not it", async () => {
    const { workers } = book({ granted: false });
    const ok = handoff(workers, { instructions: "x", [ADMITTED]: true } as Record<string, unknown>);
    await expect(ok.result).resolves.toBeTruthy();
    const forged = handoff(workers, { instructions: "x", ADMITTED: true });
    await expect(forged.result).rejects.toThrow();
    expect(forged.ran.n).toBe(0);
  });

  it("a plugin a bot wrote gets a card (with the instructions), and no handoff when the user refuses", async () => {
    const asked = book({ written: true });
    await handoff(asked.workers, { instructions: "the plan" }).result;
    expect(asked.log.cards).toHaveLength(1);
    expect(asked.log.cards[0]).toContain("the plan");
    const refused = book({ written: true, ask: async () => ({ index: 1 }) });
    const h = handoff(refused.workers, { instructions: "x" });
    await expect(h.result).rejects.toThrow(/did not allow/);
    expect(h.ran.n).toBe(0);
  });

});

describe("G1: a plugin a bot wrote is asked again for a new instruction, and works only on bots it made", () => {
  it("workers.send gives a card with the message; a refusal sends nothing; a plugin not written by a bot gets no card", async () => {
    const t = book({ written: true });
    const { taskId } = await t.workers.start("p", { bot: "b1", instructions: "first" });
    t.log.cards.length = 0;
    await t.workers.send("p", taskId, "NEW ORDER");
    expect(t.log.cards).toHaveLength(1);
    expect(t.log.cards[0]).toContain("NEW ORDER");
    expect(t.log.sent).toEqual(["NEW ORDER"]);

    let answers = 0;
    const no = book({ written: true, ask: async () => ({ index: answers++ === 0 ? 0 : 1 }) });
    const started = await no.workers.start("p", { bot: "b1", instructions: "first" });
    await expect(no.workers.send("p", started.taskId, "SWAPPED")).rejects.toThrow(/did not allow/);
    expect(no.log.sent).toEqual([]);

    const plain = book();
    const own = await plain.workers.start("p", { bot: "b1", instructions: "first" });
    await plain.workers.send("p", own.taskId, "more");
    expect(plain.log.cards).toEqual([]);
    expect(plain.log.sent).toEqual(["more"]);
  });

  it("a send's card answered after the grant was taken away sends nothing (authority at use, review)", async () => {
    const options: Parameters<typeof book>[0] & {} = { written: true };
    let cards = 0;
    options.ask = async () => { cards += 1; if (cards === 2) options.granted = false; return { index: 0 }; };
    const t = book(options);
    const { taskId } = await t.workers.start("p", { bot: "b1", instructions: "first" });
    await expect(t.workers.send("p", taskId, "NEW ORDER")).rejects.toThrow(/not been allowed/);
    expect(cards).toBe(2);
    expect(t.log.sent).toEqual([]);
  });

  it("start refuses a bot the plugin did not make, for the bot's own model as well; a plugin not written by a bot is not restricted", async () => {
    const t = book({ written: true, made: [] });
    await expect(t.workers.start("p", { bot: "b1", instructions: "x" })).rejects.toThrow(/made itself/);
    const h = handoff(t.workers, { instructions: "x" });
    await expect(h.result).rejects.toThrow(/made itself/);
    expect(h.ran.n + t.log.started.length + t.log.cards.length).toBe(0);
    const open = book({ made: [] });
    await expect(open.workers.start("p", { bot: "b1", instructions: "x" })).resolves.toBeTruthy();
  });

  it("a worker started on a bot the plugin made can be sent to even after the world forgot the bot (the send is checked at use)", async () => {
    const t = book({ written: true });
    const { taskId } = await t.workers.start("p", { bot: "b1", instructions: "x" });
    (t.workers as unknown as { deps: { world: OrchestrationWorld } }).deps.world.made = () => false;
    await expect(t.workers.send("p", taskId, "more")).rejects.toThrow(/made itself/);
  });
});

describe("G2: one card at a time per plugin; a second ask waits its turn (2026-11-16, no longer refused)", () => {
  it("a second ask while a card waits queues behind it: one card is open, the second shows after the first is answered, both start", async () => {
    const answers: ((answer: AppAnswer) => void)[] = [];
    const cards: string[] = [];
    const t = book({ written: true, ask: (question) => { cards.push(question.text); return new Promise((resolve) => { answers.push(resolve); }); } });
    const first = t.workers.start("p", { bot: "b1", instructions: "one" });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const second = t.workers.start("p", { bot: "b1", instructions: "two" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cards).toHaveLength(1);
    answers[0]!({ index: 0 });
    await expect(first).resolves.toBeTruthy();
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    expect(cards[1]).toContain("two");
    answers[1]!({ index: 0 });
    await expect(second).resolves.toBeTruthy();
    expect(t.log.started).toHaveLength(2);
  });

  it("a card that is refused, or answered with an error, frees the place", async () => {
    let n = 0;
    const t = book({ written: true, ask: async () => { if (n++ === 0) throw new Error("page closed"); return { index: 0 }; } });
    await expect(t.workers.start("p", { bot: "b1", instructions: "one" })).rejects.toThrow(/did not allow/);
    await expect(t.workers.start("p", { bot: "b1", instructions: "two" })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The real core: the wire from a plugin's request to the bot.
const running: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of running.splice(0)) await core.shutdown(); });

function plugin(dir: string, name: string, permissions: string[], root: "plugins" | "builtin") {
  const folder = join(dir, root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

function realCore(options: { grant?: boolean | undefined } = {}) {
  const dir = tempDir("o04-heard");
  plugin(dir, "shipped", ALL, "builtin");
  plugin(dir, "written", ALL, "plugins");
  plugin(dir, "plain", ["bots"], "plugins");
  const core = new RealCore({
    dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    plugins: { node: null, hostScript: "", sealer: null, builtIns: join(dir, "builtin") },
    ...(options.grant === undefined ? {} : { pluginCapability: () => options.grant === true }),
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
  });
  running.push(core);
  const bots = (core as unknown as { bots: Map<string, Bot> }).bots;
  const main = [...bots.values()].find((bot) => bot.profile.role === "main") ?? [...bots.values()][0]!;
  const sent = vi.spyOn(main, "send").mockReturnValue({ messageId: "m", turnId: null } as never);
  const routines = vi.spyOn(main, "addRoutine").mockReturnValue(true);
  const ask = (method: string, params: unknown) => (core.plugins as unknown as { requested(m: string, p: unknown): Promise<unknown> }).requested(method, params);
  /** What the bot's `app_handoff` does in a turn that stems from `plugin` (none: the user's, or the bot's own). */
  const admit = (kind: string, args: Record<string, unknown>, plugin?: string) => {
    const ran = { n: 0 };
    const result = (main as unknown as { options: { workerAdmit: (k: string, a: Record<string, unknown>, run: () => Promise<Handoff>, plugin: string | undefined) => Promise<Handoff> } }).options.workerAdmit(kind, args, async () => { ran.n += 1; return { task_id: "H", run: 1 }; }, plugin);
    return { ran, result };
  };
  return { core, main, ask, admit, routines, sent };
}

describe("F6 in the real core: a message from a plugin that is not shipped carries the plugin, and the turn that answers it is checked as that plugin's", () => {
  it("bots.send, as the plugin or as the user, and bots.wake send the message from the plugin; a shipped plugin's message carries none", async () => {
    const t = realCore();
    const from = () => (t.sent.mock.calls.at(-1)![1] as { from?: string }).from;
    await t.ask("bots.send", { plugin: "shipped", bot: "main", text: "hi" });
    expect(from()).toBeUndefined();
    await t.ask("bots.send", { plugin: "written", bot: "main", text: "hi" });
    expect(from()).toBe("written");
    await t.ask("bots.send", { plugin: "plain", bot: "main", text: "as me", as: "user" });
    expect(from()).toBe("plain");
    await t.ask("bots.wake", { plugin: "written", bot: "main", prompt: "wake" });
    expect(from()).toBe("written");
  });

  it("a turn that stems from a plugin cannot start a worker without the grant; a turn nobody's plugin made starts as before", async () => {
    const t = realCore();
    const free = t.admit("claude-process", { instructions: "mine" });
    await expect(free.result).resolves.toBeTruthy();
    expect(free.ran.n).toBe(1);
    const refused = t.admit("claude-process", { instructions: "from the plugin" }, "written");
    await expect(refused.result).rejects.toThrow(/permission/);
    expect(refused.ran.n).toBe(0);
  });

  it("routines.add: a shipped plugin adds one; a plugin that is not shipped never does, granted or not, written by a bot or not (decided)", async () => {
    const add = { bot: "main", cron: "0 9 * * *", task: "Check: do the thing" };
    const none = realCore();
    await expect(none.ask("routines.add", { plugin: "shipped", ...add })).resolves.toBeNull();
    expect(none.routines).toHaveBeenCalledTimes(1);
    const granted = realCore({ grant: true });
    for (const core of [none, granted]) for (const plugin of ["plain", "written"]) await expect(core.ask("routines.add", { plugin, ...add })).rejects.toThrow(/shipped with Botling/);
    expect(none.routines).toHaveBeenCalledTimes(1);
    expect(granted.routines).not.toHaveBeenCalled();
  });
});

describe("R7 and Maintainer in the real core", () => {
  it("nobody has orchestrate unless pluginCapability says so: unset refuses, false refuses, true allows", () => {
    const orchestration = (grant?: boolean) => (realCore({ grant }).core.plugins as unknown as { options: { world: { orchestration: OrchestrationWorld } } }).options.world.orchestration;
    expect(orchestration(undefined).granted("written")).toBe(false);
    expect(orchestration(false).granted("written")).toBe(false);
    expect(orchestration(true).granted("written")).toBe(true);
  });

  it("with pluginCapability unset, workers.start is refused through the wire", async () => {
    const t = realCore();
    await expect(t.ask("workers.start", { plugin: "written", bot: "main", instructions: "x" })).rejects.toThrow(/has not been allowed to orchestrate/);
  });

  it("Maintainer is never a target, and a bot is 'made' by a plugin only when its profile says so", () => {
    const t = realCore({ grant: true });
    const world = (t.core.plugins as unknown as { options: { world: { orchestration: OrchestrationWorld } } }).options.world.orchestration;
    const maintainer = (t.core as unknown as { maintainerId: string }).maintainerId;
    expect(world.workers(maintainer)).toMatch(/Maintainer/);
    // "main" names the main bot, but the port (and so each entry of the book) carries its real id, the one `botRemoved` names (review).
    const port = world.workers("main");
    expect(typeof port === "string" ? port : port.id).toBe(t.main.id);
    expect(world.made?.("written", t.main.id)).toBe(false);
    expect(world.made?.("written", "no-such-bot")).toBe(false);
  });
});

describe("the wire from the bot's own app_handoff to the book", () => {
  it("the bot's app_handoff, after a plugin's message, is refused through the real Claude workers of the bot (hook wired to WorkerCore); with no mark it goes on", async () => {
    const t = realCore();
    const workers = t.main.ensureClaudeWorkers();
    t.main.turn = { plugin: "written" } as never;
    await expect(workers.tool("app_handoff", { instructions: "from the plugin's message" })).rejects.toThrow(/permission/);
    // Not marked: the checks are not asked, the handoff goes on as before (and stops here only because this core has no agent).
    t.main.turn = null;
    await expect(workers.tool("app_handoff", { instructions: "mine" })).rejects.not.toThrow(/permission/);
  });

  it("a worker a plugin started does not inherit the bot's always-allow rules; the bot's own worker does", async () => {
    const base = { command: "claude", cwd: "/elsewhere", sessionId: "coordinator", resume: true, allowedTools: ["Read"], disallowedTools: [], model: "sonnet", effort: "low", allowRules: ["Bash(npm test)"] } as never;
    const h = claudeHarness(undefined, { base });
    try {
      await h.workers.startFor({ instructions: "from a plugin" });
      await h.workers.tool("app_handoff", { instructions: "from the bot" });
      const [fromPlugin, fromBot] = h.heads.map((head) => head.config);
      expect(fromPlugin).toMatchObject({ allowRules: [], askPermission: true });
      expect(fromBot).toMatchObject({ allowRules: ["Bash(npm test)"] });
    } finally { await h.workers.close(); }
  });

  it("startFor gives its handoff the ADMITTED symbol and the pluginStarted mark; a handoff of the bot's own has neither", async () => {
    const h = claudeHarness();
    try {
      const handoff = vi.spyOn((h.workers as unknown as { core: { handoff: (kind: string, args: Record<string, unknown>) => Promise<unknown> } }).core, "handoff");
      await h.workers.startFor({ instructions: "from a plugin" });
      await h.workers.tool("app_handoff", { instructions: "from the bot" });
      const [fromPlugin, fromBot] = handoff.mock.calls.map((call) => call[1] as Record<string | symbol, unknown>);
      expect(fromPlugin![ADMITTED]).toBe(true);
      expect(fromPlugin!.pluginStarted).toBe(true);
      expect(fromBot![ADMITTED]).toBeUndefined();
      expect(fromBot!.pluginStarted).toBeUndefined();
    } finally { await h.workers.close(); }
  });
});
