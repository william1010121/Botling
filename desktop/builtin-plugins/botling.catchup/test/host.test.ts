// The program part (src/host.ts) against a fake Botling API: it takes over the core's old switch and threshold once,
// folds all but the top three when you read a chat with more unread replies than the threshold, and puts the fold in
// the chat as a decoration. It never starts a process: no summarizer, no model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BotlingApi, ChatData, MessageDecoration, PluginEvents } from "../../../../Web/host/src/api";
import { tempDir, until } from "../../../test/helpers";
import manifest from "../package.json";

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const spy = <F extends (...args: any[]) => any>(fn: F) => ((...args: Parameters<F>) => { spawned.calls.push(args); return fn(...args); }) as F;
  // (execFile and exec are left alone: util.promisify finds its own variant on them.)
  return { ...real, spawn: spy(real.spawn), spawnSync: spy(real.spawnSync), fork: spy(real.fork), execFileSync: spy(real.execFileSync), execSync: spy(real.execSync) };
});
import { activate } from "../src/host";

const id = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (n: number, role: string, extra: Record<string, unknown> = {}) => ({ id: id(n), role, text: `${role} ${n}`, date: 800_000_000 + n, ...(role === "bot" ? { engine: "claude" } : {}), ...extra });

/** A fake Botling for one chat ("main"): what the plugin asked and drew is recorded. */
function fakeApi(dir: string, chat: { messages: ReturnType<typeof line>[]; unread: number }, values: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = {};
  const settings: Record<string, unknown> = Object.fromEntries(Object.entries(manifest.ccb.contributes.settings).map(([key, setting]) => [key, setting.default]));
  Object.assign(settings, values);
  const listeners = new Map<string, ((data: unknown) => void)[]>();
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
  } as unknown as BotlingApi;
  const emit = <E extends keyof PluginEvents>(name: E, data: PluginEvents[E]) => { for (const fn of listeners.get(name) ?? []) fn(data); };
  return { api, emit, drawn, reads, updates, storage, settings, last: () => drawn.at(-1) ?? [] };
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("botling.catchup's program part", () => {
  it("takes over only the old switch and threshold once, leaving the old files as they were", async () => {
    const dir = tempDir("catchup-host");
    const old = { languageChoice: "en", catchUpEnabledChoice: false, intervalSummaryEnabledChoice: true, catchUpThresholdChoice: 99, catchUpModelChoice: "opus", catchUpModelEngine: "claude", summaryPromptChoice: "Be terse." };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(old));
    writeFileSync(join(dir, "catchup-summaries.json"), JSON.stringify({ "a-b-en": { bullets: ["x"], model: "m", date: 1 } }));
    const fake = fakeApi(dir, { messages: [], unread: 0 });
    await activate(fake.api);
    expect(Object.fromEntries(fake.updates)).toEqual({ "botling.catchup.unread": false, "botling.catchup.unreadThreshold": 50 });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual(old);
    // The old summaries are not copied: nothing is summarized any more.
    expect(() => readFileSync(join(dir, "plugin-data", "botling.catchup", "summaries.json"))).toThrow();
    // Not again: a later change of the user's stays.
    const again = fakeApi(dir, { messages: [], unread: 0 });
    Object.assign(again.storage, fake.storage);
    await activate(again.api);
    expect(again.updates).toEqual([]);
  });

  it("folds all but the top three when you read the chat with more unread replies than the threshold", async () => {
    const dir = tempDir("catchup-host");
    const messages = [line(1, "user"), line(2, "bot"), line(3, "bot"), line(4, "notice"), line(5, "bot"), line(6, "bot")];
    const fake = fakeApi(dir, { messages, unread: 5 });
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 5, through: id(6) });
    await until(() => fake.last().length > 0);
    const [fold] = fake.last();
    // Replies 2, 3, 5, 6 and a notice 4: the newest bot replies 6, 5, 3 stay; the first reply and the notice fold.
    expect(fold).toMatchObject({ key: `unread:${id(2)}-${id(4)}`, fold: [id(2), id(4)], data: { kind: "unread", key: `${id(2)}-${id(4)}`, ids: [id(2), id(4)], important: 3 } });
    expect(fold!.data).not.toHaveProperty("bullets");
    expect(fold!.data).not.toHaveProperty("state");
    expect(fake.drawn).toHaveLength(1);
    expect(fake.reads).toEqual([2_000, 2_000]);
    // The same range again changes nothing and draws nothing.
    fake.emit("chatRead", { botId: "main", unread: 5, through: id(6) });
    await quiet();
    expect(fake.drawn).toHaveLength(1);
  });

  it("an error and an open question stay in view ahead of newer plain replies", async () => {
    const dir = tempDir("catchup-host");
    const question = line(4, "bot", { choices: [{ label: "A" }, { label: "B" }] });
    const messages = [line(1, "user"), line(2, "bot"), line(3, "error"), question, line(5, "bot"), line(6, "bot"), line(7, "bot")];
    const fake = fakeApi(dir, { messages, unread: 6 });
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 6, through: id(7) });
    await until(() => fake.last().length > 0);
    // The question (4) and the error (3) stay, then the newest reply (7): 2, 5 and 6 fold.
    expect(fake.last()[0]!.fold).toEqual([id(2), id(5), id(6)]);
    expect((fake.last()[0]!.data as { important: number }).important).toBe(3);
  });

  it("reads nothing when no more lines are unread than the threshold, or it is off", async () => {
    const dir = tempDir("catchup-host");
    const fake = fakeApi(dir, { messages: [line(1, "bot"), line(2, "bot"), line(3, "bot")], unread: 3 });
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 3, through: id(3) });
    const off = fakeApi(tempDir("catchup-host"), { messages: [1, 2, 3, 4].map((n) => line(n, "bot")), unread: 4 }, { "botling.catchup.unread": false });
    await activate(off.api);
    off.emit("chatRead", { botId: "main", unread: 4, through: id(4) });
    await quiet();
    expect([fake.reads, off.reads, fake.drawn, off.drawn]).toEqual([[], [], [], []]);
  });

  it("never starts a process: no summarizer, no model, whatever the chat holds; old model settings are ignored", async () => {
    const dir = tempDir("catchup-host");
    const messages = [line(1, "user"), ...[2, 3, 4, 5, 6, 7].map((n) => line(n, "bot"))];
    const fake = fakeApi(dir, { messages, unread: 6 }, { "botling.catchup.engine": "codex", "botling.catchup.model": "gpt-6-luna", "botling.catchup.interval": true });
    spawned.calls.length = 0;
    await activate(fake.api);
    fake.emit("chatRead", { botId: "main", unread: 6, through: id(7) });
    fake.emit("messagePosted" as never, { botId: "main", role: "user", text: "next", id: id(8) } as never);
    await until(() => fake.last().length > 0);
    await quiet();
    expect(fake.last()[0]!.fold).toEqual([id(2), id(3), id(4)]);
    expect(spawned.calls).toEqual([]);
  });
});
