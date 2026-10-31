// The renderer's side of history paging: older pages are put in front of the loaded lines.
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../../src/renderer/store";
import type { BotView, EventEnvelope, MessageView, ResultOf } from "../../src/contract";

const bot: BotView = { id: "A", name: "A", role: "main", avatar: "circle", folder: "/a", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null } as unknown as BotView;
const line = (n: number, text = `line ${n}`): MessageView => ({ id: `m${n}`, role: n % 2 ? "bot" : "user", text, time: new Date(2026, 0, 1, 0, n).toISOString() });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => line(from + i));
const snap = (messages: MessageView[], older: number): ResultOf<"chat.snapshot"> => ({
  epoch: "e", seq: 1, bots: [bot], imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
  chat: { botId: "A", messages, running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [], ...(older ? { history: { hasMore: true, older } } : {}) },
} as unknown as ResultOf<"chat.snapshot">);
const event = (seq: number, e: unknown): EventEnvelope => ({ v: 10, epoch: "e", seq, event: e } as EventEnvelope);

async function shown(older = 30, fetchHistory = vi.fn(async (_b: string, before: string) => {
  const end = Number(before.slice(1));
  return { messages: range(Math.max(0, end - 10), end), hasMore: end - 10 > 0, older: Math.max(0, end - 10), found: true };
})) {
  const store = new WorkspaceStore(async () => snap(range(30, 40), older), fetchHistory);
  await store.resync();
  return { store, fetchHistory };
}
const ids = (store: WorkspaceStore) => store.getView().chat!.messages.map((m) => m.id);

describe("loading older pages", () => {
  it("puts the page before the first line, in order, and stops when there is no more", async () => {
    const { store, fetchHistory } = await shown();
    await store.loadOlder();
    expect(fetchHistory).toHaveBeenCalledWith("A", "m30", undefined);
    expect(ids(store)).toEqual(range(20, 40).map((m) => m.id));
    expect(store.getView().chat!.history).toEqual({ hasMore: true, older: 20 });
    await store.loadOlder();
    await store.loadOlder();
    expect(ids(store)).toEqual(range(0, 40).map((m) => m.id));
    expect(store.getView().chat!.history).toBeUndefined();
    await store.loadOlder(); // Nothing more: no request.
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("passes `until` for a jump to a line that is not loaded", async () => {
    const { store, fetchHistory } = await shown();
    await store.loadOlder("m5");
    expect(fetchHistory).toHaveBeenCalledWith("A", "m30", "m5");
  });

  it("asks once while a page is on its way", async () => {
    let release!: () => void;
    const fetchHistory = vi.fn(() => new Promise<ResultOf<"chat.history">>((resolve) => { release = () => resolve({ messages: range(20, 30), hasMore: true, older: 20, found: true }); }));
    const { store } = await shown(30, fetchHistory as never);
    const first = store.loadOlder();
    void store.loadOlder();
    release();
    await first;
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("drops a page that arrives after a resync changed the first line", async () => {
    let release!: () => void;
    const fetchHistory = vi.fn(() => new Promise<ResultOf<"chat.history">>((resolve) => { release = () => resolve({ messages: range(20, 30), hasMore: true, older: 20, found: true }); }));
    const { store } = await shown(30, fetchHistory as never);
    const pending = store.loadOlder();
    (store as unknown as { view: unknown }).view = { ...store.getView(), chat: { ...store.getView().chat!, messages: range(31, 40) } };
    release();
    await pending;
    expect(ids(store)).toEqual(range(31, 40).map((m) => m.id));
  });

  it("does not ask when the chat is whole", async () => {
    const { store, fetchHistory } = await shown(0);
    await store.loadOlder();
    expect(fetchHistory).not.toHaveBeenCalled();
  });
});

describe("events for lines that are not loaded", () => {
  it("does not append an update to an older line at the end; it shows once its page is loaded", async () => {
    const { store } = await shown();
    store.receive(event(2, { type: "message.updated", botId: "A", message: { ...line(12, "a reaction came"), reactions: [{ emoji: "👍", actor: "user" }] } }));
    expect(ids(store)).toEqual(range(30, 40).map((m) => m.id));
    store.receive(event(3, { type: "message.added", botId: "A", message: line(40) }));
    expect(ids(store).at(-1)).toBe("m40");
    store.receive(event(4, { type: "message.updated", botId: "A", message: line(33, "edited") }));
    expect(store.getView().chat!.messages.find((m) => m.id === "m33")!.text).toBe("edited");
  });
});
