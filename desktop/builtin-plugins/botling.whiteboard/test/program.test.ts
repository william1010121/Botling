// botling.whiteboard's program part with a fake api: the board shaped from the workspace and rebuilt only when it changed
// (`workspace.onChange`, listened to only while the board is asked for), the <whiteboard> tag, a picture's command run by
// Botling once the user allowed it, and the pictures imported from whiteboard.json the first time.
import { describe, expect, it, vi } from "vitest";
import type { BotlingApi, BotSummary, CommandRun, ReplyTag, WorkspaceChange } from "../../../../Web/host/src/api";
import { PICTURE_DATA_LIMIT, Program, SHOWN_COOLDOWN_MS, SHOWN_FOR_MS, readPicture, type Deps } from "../src/program";

const summary = (id: string, extra: Partial<BotSummary> = {}): BotSummary => ({
  id, name: id.toUpperCase(), role: id === "main" ? "main" : "manager", parent: null, folder: `${id}-folder`, engine: "claude", busy: false, asleep: true, avatar: "circle", pinned: false,
  lastActivity: null, job: null, subagents: 0, guest: false, approvals: 0, status: { key: "asleep", text: "Asleep" }, lastReply: null, ...extra,
});

/** The api a plugin gets, as far as the program part uses it; `world` is what Botling would answer, `calls` what was asked. */
function setup(world: { bots?: BotSummary[]; library?: Record<string, string | null>; runs?: Record<string, CommandRun>; legacy?: Record<string, unknown> } = {}) {
  const state = { bots: world.bots ?? [summary("main", { lastReply: "All good." }), summary("site"), summary("news", { role: "bot", job: "Morning news" })] };
  const library = world.library ?? { status: null, gitlog: "git log --oneline" };
  const storage: Record<string, unknown> = {};
  const calls: unknown[][] = [];
  const listeners: ((change: WorkspaceChange) => void)[] = [];
  const exposed = new Map<string, (params: unknown) => unknown>();
  const tags: ((tag: ReplyTag) => void)[] = [];
  const runs: Record<string, CommandRun> = world.runs ?? {};
  let settings: Record<string, unknown> = { botLook: "original", language: "en" };
  const run = (botId: string, command: string): CommandRun => runs[`${botId}|${command}`] ?? { folder: `/p/${botId}`, approved: false, status: "approve", data: null, error: null, ranAt: null };
  const api = {
    plugin: { name: "botling.whiteboard", version: "1.0.0", dir: "/x", storageDir: "/data/plugin-data/botling.whiteboard" },
    subscriptions: [] as (() => void)[],
    storage: { dir: "/s", get: (key: string) => storage[key], set: (key: string, value: unknown) => { storage[key] = JSON.parse(JSON.stringify(value)); } },
    settings: { app: (key: string) => settings[key] ?? null },
    bots: { send: async (...args: unknown[]) => { calls.push(["send", ...args]); return { messageId: "M" }; } },
    replyTags: { on: (tag: string, fn: (tag: ReplyTag) => void) => { calls.push(["replyTags.on", tag]); tags.push(fn); return () => {}; } },
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => exposed.delete(method); } },
    approvals: {
      state: async (botId: string, command: string, key: string) => { calls.push(["approvals.state", botId, command, key]); return run(botId, command); },
      run: async (botId: string, command: string, key: string, opts?: { minIntervalMs?: number }) => { calls.push(["approvals.run", botId, command, key, opts?.minIntervalMs ?? 0]); return { ...run(botId, command), started: false }; },
    },
    workspace: {
      bots: async () => { calls.push(["bots"]); return state.bots; },
      memory: async (botId: string) => { calls.push(["memory", botId]); return { currentStatus: [`${botId} is fine.`], inProgress: [], decided: [], waitingOnYou: [] }; },
      tasks: async (botId: string, opts?: unknown) => { calls.push(["tasks", botId, opts]); return []; },
      taskHistory: async (botId: string, days: number) => { calls.push(["taskHistory", botId, days]); return []; },
      results: async (botId: string, opts?: unknown) => { calls.push(["results", botId, opts]); return []; },
      waiting: async () => { calls.push(["waiting"]); return { items: [], doing: {} }; },
      pendingApprovals: async () => [],
      ignoreWaiting: async (botId: string, text: string) => { calls.push(["ignoreWaiting", botId, text]); },
      face: async (botId: string, look: string) => { calls.push(["face", botId, look]); return `face:${botId}:${look}`; },
      component: async (botId: string, name: string, spec?: { command?: string }) => {
        calls.push(["component", botId, name, spec]);
        return name in library ? { exists: true, command: spec?.command ?? library[name] ?? null } : { exists: false, command: null };
      },
      onChange: (fn: (change: WorkspaceChange) => void) => { calls.push(["onChange"]); listeners.push(fn); return () => { listeners.splice(listeners.indexOf(fn), 1); calls.push(["offChange"]); }; },
    },
  } as unknown as BotlingApi;
  let now = 1_000_000;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const deps: Deps = {
    now: () => now,
    legacy: (botId) => world.legacy?.[botId] ?? null,
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return { cancel: () => { timer.live = false; } }; },
  };
  const program = new Program(api, deps);
  program.start();
  const call = (method: string, params?: unknown) => exposed.get(method)!(params) as Promise<any>;
  const board = (since?: string) => call("board", since === undefined ? {} : { since });
  const tag = (botId: string, attributes: Record<string, string>, body = "", role: "main" | "manager" | "bot" = "manager") => tags[0]!({ bot: { id: botId, name: botId, role, awake: true }, tag: "whiteboard", attributes, body });
  return {
    api, program, calls, storage, listeners, exposed, runs, board, call, tag, state, library,
    advance: (ms: number) => { now += ms; },
    changeSettings: (next: Record<string, unknown>) => { settings = { ...settings, ...next }; },
    fire: (change: Partial<WorkspaceChange> = {}) => { for (const listener of [...listeners]) listener({ stamp: "x", botIds: ["site"], kinds: ["bots"], ...change }); },
    idle: () => { const timer = [...timers].reverse().find((candidate) => candidate.live); timer?.fn(); },
    reads: () => calls.filter((entry) => entry[0] === "bots").length,
  };
}

describe("the board", () => {
  it("is the workspace shaped as the core's whiteboard.view was: every bot but the main bot a part of its own, the others as bots", async () => {
    const t = setup({ bots: [summary("main", { lastReply: "All good.", pinned: true }), summary("site", { busy: true, asleep: false, lastActivity: "2026-11-01T10:00:00Z", approvals: 1, status: { key: "waiting", text: "Waiting for your answer" } }), summary("sub", { role: "bot", parent: "site" })] });
    const view = await t.board();
    expect(view).toMatchObject({ look: "original", lang: "en", mainBotId: "main", mainReply: "All good.", pinned: ["main"], shelfOpen: false });
    expect(view.bots.map((bot: any) => [bot.id, bot.phase, bot.working, bot.approvals])).toEqual([["main", "asleep", false, 0], ["site", "awake", true, 1], ["sub", "asleep", false, 0]]);
    // No part for the main bot or a sub bot (it shares its project's); the part has what the core's had.
    expect(view.entries.map((entry: any) => entry.botId)).toEqual(["site"]);
    expect(view.entries[0]).toMatchObject({ botId: "site", currentStatus: ["site is fine."], picture: null, latest: null, description: "site is fine." });
    expect(t.calls).toContainEqual(["tasks", "site", { limit: 100 }]);
    expect(t.calls).toContainEqual(["results", "site", { limit: 12 }]);
    expect(t.calls).toContainEqual(["taskHistory", "site", 14]);
    expect(view.faces).toEqual({ main: "face:main:original", site: "face:site:original", sub: "face:sub:original" });
    expect(view.statuses.site).toEqual({ key: "waiting", text: "Waiting for your answer" });
    expect(view.stamp).toMatch(/^\d+:\d+$/);
  });

  it("is read when something changed (workspace.onChange), not on every ask; an ask with its stamp is answered `same`", async () => {
    const t = setup();
    const first = await t.board();
    expect(t.calls.filter((entry) => entry[0] === "onChange")).toHaveLength(1);
    const reads = t.reads();
    expect(reads).toBe(1);
    for (let i = 0; i < 3; i++) expect(await t.board(first.stamp)).toMatchObject({ same: true, stamp: first.stamp, bots: [], entries: [] });
    expect(t.reads()).toBe(reads);
    // Told something changed: the next ask reads again, and the stamp moves only if what is shown did.
    t.fire();
    expect((await t.board(first.stamp)).same).toBe(true);
    expect(t.reads()).toBe(reads + 1);
    t.state.bots = [t.state.bots[0]!, summary("site", { busy: true, asleep: false }), t.state.bots[2]!];
    t.fire({ kinds: ["bots", "tasks"] });
    const moved = await t.board(first.stamp);
    expect(moved.stamp).not.toBe(first.stamp);
    expect(moved.bots.find((bot: any) => bot.id === "site")).toMatchObject({ working: true });
    // A change that shows nothing new keeps the stamp (it was read again: `same` is about what the page shows).
    t.fire();
    expect((await t.board(moved.stamp)).same).toBe(true);
    expect(t.reads()).toBe(reads + 3);
  });

  it("listens for changes only while the board is asked for: it lets go a while after the asks stop, and listens again", async () => {
    const t = setup();
    await t.board();
    expect(t.listeners).toHaveLength(1);
    await t.board();
    expect(t.listeners).toHaveLength(1);
    t.idle();
    expect(t.listeners).toHaveLength(0);
    // Not listening, nothing is known: the next ask reads again.
    const reads = t.reads();
    await t.board();
    expect(t.listeners).toHaveLength(1);
    expect(t.reads()).toBe(reads + 1);
    expect(SHOWN_FOR_MS).toBe(20_000);
  });

  it("follows the app's look and language, and each bot's face as it is now (cached while it does not change)", async () => {
    const t = setup();
    await t.board();
    t.fire();
    await t.board();
    expect(t.calls.filter((entry) => entry[0] === "face")).toHaveLength(3);
    t.changeSettings({ botLook: "cute", language: "zh-Hant" });
    const view = await t.board();
    expect(view).toMatchObject({ look: "cute", lang: "zh-Hant", faces: { main: "face:main:cute" } });
    expect(t.calls.filter((entry) => entry[0] === "face")).toHaveLength(6);
  });

  it("keeps the shelf open or closed for the next start, and sends a message to the main bot as the user's", async () => {
    const t = setup();
    await t.call("shelf", { open: true });
    expect(t.storage.shelfOpen).toBe(true);
    expect((await t.board()).shelfOpen).toBe(true);
    await t.call("send", { text: "  How is everyone?  " });
    expect(t.calls).toContainEqual(["send", "main", "How is everyone?", { as: "user" }]);
    await expect(t.call("send", { text: "  " })).rejects.toThrow("Nothing to send.");
    await t.call("ignore", { botId: "site", text: "task:c" });
    expect(t.calls).toContainEqual(["ignoreWaiting", "site", "task:c"]);
  });
});

describe("<whiteboard> in a reply", () => {
  it("keeps a picture for the bot: its component, the data, 1x1 or 2x1; the command a component with no data takes from its own about.md", async () => {
    const t = setup();
    await t.tag("site", { name: "status", size: "2x1" }, '{"ok":true}');
    expect(t.storage.pictures).toEqual({ site: { name: "status", data: '{"ok":true}', size: "2x1", savedAt: 1_000_000 } });
    await t.tag("news", { name: "gitlog" });
    expect(t.storage.pictures).toMatchObject({ news: { name: "gitlog", data: "null", command: "git log --oneline", size: "1x1" } });
    // The tag's own command wins.
    await t.tag("news", { name: "gitlog", command: "git log -3" });
    expect(t.storage.pictures).toMatchObject({ news: { command: "git log -3" } });
    expect(t.calls).toContainEqual(["component", "news", "gitlog", { data: "null", command: "git log -3" }]);
    // Anything but 2x1 is 1x1; the last good tag counts.
    await t.tag("site", { name: "status", size: "4x4" }, '{"n":2}');
    expect(t.storage.pictures).toMatchObject({ site: { data: '{"n":2}', size: "1x1" } });
  });

  it("keeps the picture before when the tag is not usable: no name, broken JSON, a component that is not in the library", async () => {
    const t = setup();
    await t.tag("site", { name: "status" }, '{"ok":true}');
    await t.tag("site", {}, '{"ok":false}');
    await t.tag("site", { name: "status" }, "{broken");
    await t.tag("site", { name: "nope" }, "{}");
    await t.tag("site", { command: "ls" });
    expect(t.storage.pictures).toEqual({ site: { name: "status", data: '{"ok":true}', size: "1x1", savedAt: 1_000_000 } });
  });

  it("<whiteboard clear/> (a tag with nothing in it) takes it away; the main bot has no card", async () => {
    const t = setup();
    await t.tag("site", { name: "status" }, '{"ok":true}');
    await t.tag("site", {});
    expect(t.storage.pictures).toEqual({});
    await t.tag("main", { name: "status" }, "{}", "main");
    expect(t.storage.pictures).toEqual({});
  });

  it("keeps too much data as nothing to draw (as ccb.save's limit), and a change shows on the next ask", async () => {
    const t = setup();
    const first = await t.board();
    await t.tag("site", { name: "status" }, JSON.stringify("x".repeat(PICTURE_DATA_LIMIT)));
    expect((t.storage.pictures as any).site.data).toBe("null");
    const changed = await t.board(first.stamp);
    expect(changed.same).toBeUndefined();
    await t.tag("site", { name: "status" }, '{"ok":true}');
    const view = await t.board(changed.stamp);
    expect(view.entries.find((entry: any) => entry.botId === "site").picture).toMatchObject({ name: "status", data: '{"ok":true}', size: "1x1", command: null, status: null });
  });
});

describe("a picture's command", () => {
  const BOT = "site";
  const allowed = (extra: Partial<CommandRun> = {}): CommandRun => ({ folder: "/p/site", approved: true, status: "done", data: '{"n":3}', error: null, ranAt: Date.parse("2026-11-02T10:00:00Z"), ...extra });

  it("waits for the user's OK: status approve, the command and the folder the core named; nothing is run", async () => {
    const t = setup();
    await t.tag(BOT, { name: "gitlog" });
    const view = await t.board();
    const picture = view.entries.find((entry: any) => entry.botId === BOT).picture;
    expect(picture).toMatchObject({ name: "gitlog", data: "null", command: "git log --oneline", folder: "/p/site", status: "approve" });
    // Asked, not started: the core refuses an unallowed command, and the plugin asks again only every 30 s.
    expect(t.calls).toContainEqual(["approvals.run", BOT, "git log --oneline", "picture", SHOWN_COOLDOWN_MS]);
  });

  it("after Allow on the app page's sheet, `run` asks Botling to run it now; the output is the picture's data, kept for the next start", async () => {
    const t = setup();
    await t.tag(BOT, { name: "gitlog" });
    await t.call("run", { botId: BOT });
    expect(t.calls).toContainEqual(["approvals.run", BOT, "git log --oneline", "picture", 0]);
    t.runs[`${BOT}|git log --oneline`] = allowed();
    const view = await t.board();
    expect(view.entries.find((entry: any) => entry.botId === BOT).picture).toMatchObject({ data: '{"n":3}', status: "done", error: null, ranAt: "2026-11-02T10:00:00.000Z" });
    expect((t.storage.pictures as any)[BOT].data).toBe('{"n":3}');
    // A failed run is not drawn (the page leaves it out) and keeps what was kept.
    t.runs[`${BOT}|git log --oneline`] = allowed({ status: "failed", data: null, error: "The command failed (exit code 1)." });
    t.fire();
    expect((await t.board()).entries.find((entry: any) => entry.botId === BOT).picture).toMatchObject({ status: "failed", data: '{"n":3}', error: "The command failed (exit code 1)." });
  });

  it("run does nothing for a bot with no command picture; it never decides whether the command is allowed (Botling does)", async () => {
    const t = setup();
    await t.call("run", { botId: BOT });
    await t.tag(BOT, { name: "status" }, "{}");
    await t.call("run", { botId: BOT });
    expect(t.calls.some((entry) => entry[0] === "approvals.run")).toBe(false);
    expect(Object.keys(t.api.approvals).sort()).toEqual(["run", "state"]);
  });

  it("leaves a picture out when its component is gone from the library", async () => {
    const t = setup();
    await t.tag(BOT, { name: "status" }, "{}");
    delete t.library.status;
    const view = await t.board();
    expect(view.entries.find((entry: any) => entry.botId === BOT).picture).toBeNull();
  });
});

describe("pictures from before the plugin", () => {
  it("imports each bot's whiteboard.json once, keeps what the plugin already has, and leaves the files alone", async () => {
    const t = setup({ legacy: {
      site: { name: "status", data: '{"ok":true}', size: "2x1", savedAt: 5 },
      news: { name: "gitlog", data: "null", command: "git log --oneline", size: "1x1", savedAt: 6 },
      main: { name: "status", data: "{}", size: "1x1" },
    } });
    await t.board();
    expect(t.storage.pictures).toEqual({
      site: { name: "status", data: '{"ok":true}', command: undefined, size: "2x1", savedAt: 5 },
      news: { name: "gitlog", data: "null", command: "git log --oneline", size: "1x1", savedAt: 6 },
    });
    expect(t.storage.importedFrom).toEqual(["site", "news"]);
    // Newer than the files: a new picture is not overwritten by a second import.
    await t.tag("site", { name: "status" }, '{"n":9}');
    t.fire();
    await t.board();
    expect((t.storage.pictures as any).site.data).toBe('{"n":9}');
  });

  it("reads a record as whiteboard.json had it, or not at all", () => {
    expect(readPicture({ name: "x", data: "{}", size: "2x1", savedAt: 3, command: "ls" })).toEqual({ name: "x", data: "{}", size: "2x1", savedAt: 3, command: "ls" });
    expect(readPicture({ name: "x", data: "{}" })).toEqual({ name: "x", data: "{}", size: "1x1", savedAt: 0 });
    for (const bad of [null, "x", { name: "", data: "{}" }, { name: "x" }, { name: "x", data: 1 }]) expect(readPicture(bad)).toBeNull();
  });
});

describe("a stopped program part", () => {
  it("stops listening for changes when the plugin unloads", async () => {
    const t = setup();
    await t.board();
    for (const dispose of t.api.subscriptions.splice(0).reverse()) dispose();
    expect(t.listeners).toHaveLength(0);
    vi.useRealTimers();
  });
});
