import { describe, expect, it, vi } from "vitest";
import { ChatStore } from "../../src/renderer/store";
import type { EventEnvelope, MessageView } from "../../src/contract";

const bot: MessageView = { id: "m1", role: "bot", text: "", time: "t", turnId: "t1", state: "streaming" };
const envelope = (epoch: string, seq: number, text: string): EventEnvelope => ({ v: 1, epoch, seq, event: { type: "turn.delta", turnId: "t1", messageId: "m1", text } });

describe("ChatStore", () => {
  it("applies events in order after a snapshot", async () => {
    const store = new ChatStore(async () => ({ epoch: "e1", seq: 5, messages: [bot], running: "t1" }));
    await store.resync();
    store.receive(envelope("e1", 5, "old")); // Already in the snapshot: ignored.
    store.receive(envelope("e1", 6, "Hel"));
    store.receive(envelope("e1", 7, "lo"));
    expect(store.getView().messages[0]!.text).toBe("Hello");
  });

  it("re-syncs on a gap or a new epoch instead of guessing", async () => {
    const snapshot = vi.fn(async () => ({ epoch: "e1", seq: 1, messages: [bot], running: null }));
    const store = new ChatStore(snapshot);
    await store.resync();
    store.receive(envelope("e1", 3, "skipped one"));
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    store.receive(envelope("e2", 1, "core restarted"));
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
    expect(store.getView().messages[0]!.text).toBe("");
  });

  it("buffers events that arrive during a snapshot and replays the newer ones", async () => {
    let release!: () => void;
    const store = new ChatStore(() => new Promise((resolve) => { release = () => resolve({ epoch: "e1", seq: 2, messages: [{ ...bot, text: "ab" }], running: "t1" }); }));
    const syncing = store.resync();
    store.receive(envelope("e1", 2, "b")); // Covered by the snapshot.
    store.receive(envelope("e1", 3, "c"));
    release();
    await syncing;
    expect(store.getView().messages[0]!.text).toBe("abc");
  });
});
