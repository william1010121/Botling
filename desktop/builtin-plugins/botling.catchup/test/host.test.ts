// The program part (src/host.ts) against a fake Botling API: it takes over the core's old files once,
// summarizes unread lines when you read a chat and intervals when you post, with the fake Codex CLI
// Botling names (`engines.cli`), and puts each summary in the chat as a decoration.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BotlingApi, ChatData, MessageDecoration, PluginEvents } from "../../../../Web/host/src/api";
import { fakeCodex, tempDir, until } from "../../../test/helpers";
import manifest from "../package.json";
import { activate } from "../src/host";

const id = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (n: number, role: string, text = `${role} ${n}`) => ({ id: id(n), role, text, date: 800_000_000 + n, ...(role === "bot" ? { engine: "claude" } : {}) });

/** A fake Botling for one chat ("main"): what the plugin asked and drew is recorded. */
function fakeApi(dir: string, chat: { messages: ReturnType<typeof line>[]; unread: number }, values: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = {};
  const settings: Record<string, unknown> = Object.fromEntries(Object.entries(manifest.ccb.contributes.settings).map(([key, setting]) => [key, setting.default]));
  Object.assign(settings, values);
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const exposed = new Map<string, (params: unknown) => unknown>();
  const drawn: MessageDecoration[][] = [];
  const reads: number[] = [];
  const updates: [string, unknown][] = [];
  mkdirSync(join(dir, "plugin-data", "botling.catchup"), { recursive: true });
  const api = {
    plugin: { name: "botling.catchup", version: "1.0.0", dir, storageDir: join(dir, "plugin-data", "botling.catchup"), appDataDir: dir },
    subscriptions: [],
    settings: {
      get: (key: string) => settings[key],
      update: async (key: string, value: unknown) => { updates.push([key, value]); settings[key] = value; },
      app: (key: string) => (key === "language" ? "en" : null),
      onChange: () => () => {},
    },
    storage: { dir, get: (key: string) => storage[key], set: (key: string, value: unknown) => { storage[key] = value; } },
    events: { on: (name: string, fn: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; } },
    chat: {
      messages: async (botId: string, opts: { limit?: number } = {}): Promise<ChatData> => {
        reads.push(opts.limit ?? 500);
        if (botId !== "main") throw new Error("No such bot.");
        return { botId, name: "Garden", unread: chat.unread, messages: chat.messages, tasks: [] };
      },
      decorate: async (_botId: string, decorations: MessageDecoration[]) => { drawn.push(structuredClone(decorations)); },
    },
    engines: { cli: async (engine: string) => (engine === "codex" ? { file: process.execPath, args: [fakeCodex], env: { FAKE_CODEX_EXEC_LOG: join(dir, "exec.log") } } : null) },
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => {}; } },
  } as unknown as BotlingApi;
  const emit = <E extends keyof PluginEvents>(name: E, data: PluginEvents[E]) => { for (const fn of listeners.get(name) ?? []) fn(data); };
  const execs = () => (existsSync(join(dir, "exec.log")) ? readFileSync(join(dir, "exec.log"), "utf8").trim().split("\n").length : 0);
  return { api, emit, drawn, reads, updates, storage, settings, exposed, execs, last: () => drawn.at(-1) ?? [] };
}

describe("botling.catchup's program part", () => {
  it("takes over the core's settings and summaries once, leaving the old files as they were", async () => {
    const dir = tempDir("catchup-host");
    const old = { languageChoice: "en", catchUpEnabledChoice: false, intervalSummaryEnabledChoice: true, catchUpThresholdChoice: 99, catchUpModelChoice: "opus", catchUpModelEngine: "claude", summaryPromptChoice: "Be terse." };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(old));
    writeFileSync(join(dir, "catchup-summaries.json"), JSON.stringify({ "a-b-en": { bullets: ["x"], model: "m", date: 1 } }));
    const fake = fakeApi(dir, { messages: [], unread: 0 });
    await activate(fake.api);
    expect(Object.fromEntries(fake.updates)).toEqual({
      "botling.catchup.unread": false, "botling.catchup.interval": true, "botling.catchup.unreadThreshold": 50, "botling.catchup.customThresholds": true,
      "botling.catchup.model": "opus", "botling.catchup.engine": "claude", "botling.catchup.prompt": "Be terse.",
    });
    expect(JSON.parse(readFileSync(join(dir, "plugin-data", "botling.catchup", "summaries.json"), "utf8"))).toEqual({ "a-b-en": { bullets: ["x"], model: "m", date: 1 } });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual(old);
    expect(existsSync(join(dir, "catchup-summaries.json"))).toBe(true);
    // Not again: a later change of the user's stays.
    const again = fakeApi(dir, { messages: [], unread: 0 });
    Object.assign(again.storage, fake.storage);
    await activate(again.api);
    expect(again.updates).toEqual([]);
  });

  it("folds more than three unread replies into a summary when you read the chat, and draws it as it goes", async () => {
    const dir = tempDir("catchup-host");
    const messages = [line(1, "user"), line(2, "bot"), line(3, "bot"), line(4, "notice"), line(5, "bot")];
    const fake = fakeApi(dir, { messages, unread: 4 });
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 4, through: id(5) });
    await until(() => fake.last()[0]?.data && (fake.last()[0]!.data as { state: string }).state === "ready");
    expect(fake.drawn.map((list) => (list[0]?.data as { state: string }).state)).toEqual(["loading", "ready"]);
    const [summary] = fake.last();
    expect(summary).toMatchObject({ key: expect.stringMatching(/^unread:/), fold: [id(2), id(3), id(4), id(5)] });
    expect(summary).not.toHaveProperty("tasks");
    expect(summary!.data).toMatchObject({ kind: "unread", count: 4, state: "ready", model: "gpt-6-luna", requestedBy: null, latest: "Claude: bot 5" });
    expect((summary!.data as { bullets: string[] }).bullets[0]).toMatch(/\[\[source:[0-9A-F-]{36}\]\]$/);
    expect(fake.reads).toEqual([2_000, 2_000, 2_000]);
    // The same range again shows the summary it has.
    fake.emit("chatRead", { botId: "main", unread: 4, through: id(5) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.execs()).toBe(1);
  });

  it("reads nothing when no more lines are unread than the threshold, or summaries of unread lines are off", async () => {
    const dir = tempDir("catchup-host");
    const fake = fakeApi(dir, { messages: [line(1, "bot"), line(2, "bot"), line(3, "bot")], unread: 3 });
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 3, through: id(3) });
    const off = fakeApi(tempDir("catchup-host"), { messages: [1, 2, 3, 4].map((n) => line(n, "bot")), unread: 4 }, { "botling.catchup.unread": false });
    await activate(off.api);
    off.emit("chatRead", { botId: "main", unread: 4, through: id(4) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([fake.reads, off.reads, fake.drawn, off.drawn]).toEqual([[], [], [], []]);
  });

  it("summarizes the interval your line closed when that is on, and any interval or a failed one when the page asks", async () => {
    const dir = tempDir("catchup-host");
    const messages = [line(1, "user"), line(2, "bot"), line(3, "user")];
    const fake = fakeApi(dir, { messages, unread: 0 }, { "botling.catchup.interval": true, "botling.catchup.intervalThreshold": 1 });
    await activate(fake.api);
    fake.emit("messagePosted", { botId: "main", role: "user", text: "user 3", id: id(3) });
    await until(() => (fake.last()[0]?.data as { state?: string } | undefined)?.state === "ready");
    expect(fake.last()[0]).toMatchObject({ key: expect.stringMatching(/^interval:/), fold: [id(2)], data: { kind: "interval", automatic: true, speakerCounts: { claude: 1 } } });
    // The footer's button for the same range: already there, no new call; one with nothing in it: no.
    expect(await fake.exposed.get("interval")!({ botId: "main", userMessageId: id(1) })).toEqual({ started: true });
    expect(await fake.exposed.get("interval")!({ botId: "main", userMessageId: id(3) })).toEqual({ started: false });
    expect(await fake.exposed.get("retry")!({ botId: "main" })).toEqual({ started: false });
    expect(fake.execs()).toBe(1);
  });

  it("leaves an unanswered question out of the fold, and \"Show original messages\" removes the card for good", async () => {
    const dir = tempDir("catchup-host");
    const question = { ...line(4, "bot"), choices: [{ label: "A" }, { label: "B" }] };
    const messages = [line(1, "user"), line(2, "bot"), line(3, "bot"), question, line(5, "bot"), line(6, "bot")];
    const fake = fakeApi(dir, { messages, unread: 5 });
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 5, through: id(6) });
    await until(() => (fake.last()[0]?.data as { state?: string } | undefined)?.state === "ready");
    const [summary] = fake.last();
    expect(summary!.fold).toEqual([id(2), id(3), id(5), id(6)]);
    const key = (summary!.data as { key: string }).key;
    expect(await fake.exposed.get("expand")!({ botId: "main", key: "nope" })).toEqual({ expanded: false });
    expect(await fake.exposed.get("expand")!({ botId: "main", key })).toEqual({ expanded: true });
    await until(() => fake.last().length === 0);
    // Botling restarts the plugin: the same storage, the same unread lines, no card.
    const again = fakeApi(dir, { messages, unread: 5 });
    Object.assign(again.storage, fake.storage);
    await activate(again.api);
    again.emit("chatRead", { botId: "main", unread: 5, through: id(6) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.drawn).toEqual([]);
  });
});
