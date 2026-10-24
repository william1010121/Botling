import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../../src/renderer/store";
import type { BotView, EventEnvelope, MessageView, ResultOf } from "../../src/contract";

const botA: BotView = { id: "A", name: "A", role: "main", avatar: "circle", folder: "/a", phase: "awake", working: true, approvals: 0, unread: 0, problem: null };
const botB: BotView = { ...botA, id: "B", name: "B", role: "bot", working: false };
const reply: MessageView = { id: "m1", role: "bot", text: "", time: "t", turnId: "t1", state: "streaming" };
const snap = (epoch: string, seq: number, text = "", botId = "A"): ResultOf<"chat.snapshot"> => ({
  epoch, seq, bots: [botA, botB], imported: null,
  chat: { botId, messages: [{ ...reply, text }], running: { turnId: "t1", messageId: "m1" }, live: [] },
});
const delta = (epoch: string, seq: number, text: string, botId = "A"): EventEnvelope =>
  ({ v: 2, epoch, seq, event: { type: "turn.delta", botId, turnId: "t1", messageId: "m1", text } });

describe("WorkspaceStore", () => {
  it("applies events in order after a snapshot, and only the shown bot's chat events", async () => {
    const store = new WorkspaceStore(async () => snap("e1", 5));
    await store.resync();
    store.receive(delta("e1", 5, "old")); // Already in the snapshot: ignored.
    store.receive(delta("e1", 6, "Hel"));
    store.receive(delta("e1", 7, "lo"));
    store.receive(delta("e1", 8, "!!", "B")); // Another bot's chat: not this one's.
    store.receive({ v: 2, epoch: "e1", seq: 9, event: { type: "bot.updated", bot: { ...botB, approvals: 2 } } });
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
    store.receive({ v: 2, epoch: "e1", seq: 2, event: { type: "turn.steps", botId: "B", turnId: "t1", messageId: "m1", steps: [step] } });
    expect(store.getView().chat!.live).toEqual([step]);
    store.receive({ v: 2, epoch: "e1", seq: 3, event: { type: "turn.finished", botId: "B", turnId: "t1", messageId: "m1", status: "stopped", text: "so far" } });
    expect(store.getView().chat).toMatchObject({ running: null, live: [], messages: [{ text: "so far", state: "stopped" }] });
  });
});
