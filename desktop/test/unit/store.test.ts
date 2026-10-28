import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../../src/renderer/store";
import type { BotView, EventEnvelope, MessageView, ResultOf } from "../../src/contract";

const botA: BotView = { id: "A", name: "A", role: "main", avatar: "circle", folder: "/a", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const botB: BotView = { ...botA, id: "B", name: "B", role: "bot", working: false };
const reply: MessageView = { id: "m1", role: "bot", text: "", time: "t", turnId: "t1", state: "streaming" };
const snap = (epoch: string, seq: number, text = "", botId = "A"): ResultOf<"chat.snapshot"> => ({
  epoch, seq, bots: [botA, botB], imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
  chat: { botId, messages: [{ ...reply, text }], running: { turnId: "t1", messageId: "m1" }, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [] },
});
const delta = (epoch: string, seq: number, text: string, botId = "A"): EventEnvelope =>
  ({ v: 10, epoch, seq, event: { type: "turn.delta", botId, turnId: "t1", messageId: "m1", text } });

describe("WorkspaceStore", () => {
  it("keeps the Board on same-chat snapshots and updates, but opens another bot in Chat", async () => {
    const store = new WorkspaceStore(async (botId) => snap("e1", 1, "", botId ?? "A"));
    await store.resync();
    store.showBoard(true);
    store.receive(delta("e1", 2, "new reply"));
    expect(store.getView().board).toBe(true);
    await store.resync();
    expect(store.getView().board).toBe(true);
    await store.select("A");
    expect(store.getView().board).toBe(true);
    await store.select("B");
    expect(store.getView().board).toBe(false);
    await store.select("A");
    expect(store.getView().board).toBe(false);
  });

  it("applies events in order after a snapshot, and only the shown bot's chat events", async () => {
    const store = new WorkspaceStore(async () => snap("e1", 5));
    await store.resync();
    store.receive(delta("e1", 5, "old")); // Already in the snapshot: ignored.
    store.receive(delta("e1", 6, "Hel"));
    store.receive(delta("e1", 7, "lo"));
    store.receive(delta("e1", 8, "!!", "B")); // Another bot's chat: not this one's.
    store.receive({ v: 10, epoch: "e1", seq: 9, event: { type: "bot.updated", bot: { ...botB, approvals: 2 } } });
    expect(store.getView().chat!.messages[0]!.text).toBe("Hello");
    expect(store.getView().bots.find((bot) => bot.id === "B")!.approvals).toBe(2);
  });

  it("re-syncs on a gap or a new epoch instead of guessing", async () => {
    const snapshot = vi.fn(async () => snap("e1", 1));
    const store = new WorkspaceStore(snapshot);
    await store.resync();
    store.receive(delta("e1", 3, "skipped one"));
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    store.receive(delta("e2", 1, "core restarted"));
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
    expect(store.getView().chat!.messages[0]!.text).toBe("");
  });

  it("buffers events that arrive during a snapshot and replays the newer ones", async () => {
    let release!: () => void;
    const store = new WorkspaceStore(() => new Promise((resolve) => { release = () => resolve(snap("e1", 2, "ab")); }));
    const syncing = store.resync();
    store.receive(delta("e1", 2, "b")); // Covered by the snapshot.
    store.receive(delta("e1", 3, "c"));
    release();
    await syncing;
    expect(store.getView().chat!.messages[0]!.text).toBe("abc");
  });

  it("selecting a bot fetches its chat; steps and the end of the turn apply", async () => {
    const snapshot = vi.fn(async (botId?: string) => snap("e1", 1, "", botId ?? "A"));
    const store = new WorkspaceStore(snapshot);
    await store.resync();
    await store.select("B");
    expect(snapshot).toHaveBeenLastCalledWith("B");
    expect(store.getView().chat!.botId).toBe("B");
    const step = { id: "s1", kind: "tool" as const, tool: "Bash", title: "Run ls", detail: "ls", output: null, failed: false, done: false };
    store.receive({ v: 10, epoch: "e1", seq: 2, event: { type: "turn.steps", botId: "B", turnId: "t1", messageId: "m1", steps: [step] } });
    expect(store.getView().chat!.live).toEqual([step]);
    store.receive({ v: 10, epoch: "e1", seq: 3, event: { type: "turn.finished", botId: "B", turnId: "t1", messageId: "m1", status: "stopped", text: "so far" } });
    expect(store.getView().chat).toMatchObject({ running: null, live: [], messages: [{ text: "so far", state: "stopped" }] });
  });
});


describe("selected chat subscriptions", () => {
  it("keeps selected-bot worker progress in the sidebar without rebuilding chat history", async () => {
    const store = new WorkspaceStore(async () => snap("e1", 1));
    await store.resync();
    const changed = vi.fn(), sidebar = vi.fn();
    store.subscribeChat(changed); store.subscribe(sidebar);
    const first = store.getChatView();
    for (let i = 0; i < 20; i++) {
      store.receive({ v: 10, epoch: "e1", seq: i + 2, event: { type: "bot.updated", bot: {
        ...botA, heads: [...botA.heads], unread: i, openTasks: i,
        lastActivity: new Date(i * 1000).toISOString(),
        subagentRows: [{ id: "worker", title: `Step ${i}`, status: "running", head: "codex", startedAt: 0, endedAt: null, unsettledAt: null, settled: false, prompt: "work" }],
      } } });
    }
    expect(sidebar).toHaveBeenCalledTimes(20);
    expect(store.getView().bots[0].subagentRows[0].title).toBe("Step 19");
    expect(changed).not.toHaveBeenCalled();
    expect(store.getChatView()).toBe(first);
    store.receive(delta("e1", 22, "new token"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getChatView().chat!.messages[0].text).toBe("new token");
  });

  it.each([
    { name: "Renamed" }, { avatar: "square" }, { approvals: 1 }, { subagents: 1 },
    { guest: "B" }, { heads: ["codex"] }, { components: ["report"] }, { members: ["B"] },
    { codexRetry: { attempt: 1, max: 5, reason: "rateLimited", retryAt: null } },
  ] as Partial<BotView>[])("still delivers selected chat metadata %j", async (change) => {
    const store = new WorkspaceStore(async () => snap("e1", 1));
    await store.resync();
    const changed = vi.fn(); store.subscribeChat(changed);
    store.receive({ v: 10, epoch: "e1", seq: 2, event: { type: "bot.updated", bot: { ...botA, ...change } } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getChatView().bots[0]).toMatchObject(change);
  });

  it("ignores other bots' activity while keeping the sidebar current and mention metadata fresh", async () => {
    const store = new WorkspaceStore(async () => snap("e1", 1));
    await store.resync();
    const changed = vi.fn(), sidebar = vi.fn();
    store.subscribeChat(changed); store.subscribe(sidebar);
    const first = store.getChatView();
    store.receive({ v: 10, epoch: "e1", seq: 2, event: { type: "bot.updated", bot: { ...botB, unread: 2, working: true } } });
    store.receive(delta("e1", 3, "background", "B"));
    expect(changed).not.toHaveBeenCalled();
    expect(store.getChatView()).toBe(first);
    expect(store.getView().bots[1].unread).toBe(2);
    expect(sidebar).toHaveBeenCalledTimes(1);
    store.receive({ v: 10, epoch: "e1", seq: 4, event: { type: "bot.updated", bot: { ...botB, name: "New name" } } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getChatView().bots[1].name).toBe("New name");
    store.receive(delta("e1", 5, "visible"));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("keeps library identity/version for equivalent snapshots and invalidates changed templates or flags", async () => {
    const components = { demo: { template: "<p>one</p>", version: 1, updated: false, working: false, hasPrevious: false, sizes: ["2x2"], icon: null, title: null } };
    const store = new WorkspaceStore(async () => ({ ...snap("e1", 1), components: structuredClone(components) }));
    await store.resync();
    const first = store.getChatView();
    await store.resync();
    expect(store.getChatView().libraryVersion).toBe(first.libraryVersion);
    expect(store.getChatView().components).toBe(first.components);
    expect(store.getChatView().resyncs).toBe(first.resyncs + 1);
    store.receive({ v: 10, epoch: "e1", seq: 2, event: { type: "components.updated", components: { demo: { ...components.demo, template: "<p>two</p>", version: 2 } } } });
    expect(store.getChatView().libraryVersion).toBe(first.libraryVersion + 1);
    store.receive({ v: 10, epoch: "e1", seq: 3, event: { type: "components.updated", components: { demo: { ...components.demo, working: true } } } });
    expect(store.getChatView().libraryVersion).toBe(first.libraryVersion + 2);
  });
});
