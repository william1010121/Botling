// M1 demo bug 5a: a turn botlingd interrupted (`turn.interrupted`, it crashed or stopped mid-reply) shows on its reply
// line as 2.x shows a reply its core died during: "failed", `interrupted`, the words so far and a note that it was not
// sent again (2.x core/bot.ts on load). The 2.x renderer draws that with no renderer change; it has no Continue or Retry
// for it. The live path (the window's adapter) and a snapshot after the restart (the server's read model) agree.
import { describe, expect, it, afterEach } from "vitest";
import type { BotView, MessageView } from "../../src/contract";
import { BotSnapView, INTERRUPTED_NOTE, interruptedLine, type StreamId } from "../../src/protocol";
import { ensureStream, LogHub, readSnap } from "../../src/server/log";
import { chatState } from "../../src/renderer/payload";
import { quickStore, type QuickStore } from "./server-log-helpers";

const A = "bot:alpha" as StreamId;
const stores: QuickStore[] = [];
const hubs: LogHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const store of stores.splice(0)) await store.close();
});
const reply = (text: string): MessageView => ({ id: "r1", role: "bot", text, time: "2026-11-14T09:00:00.000Z", turnId: "t1", state: "streaming" });

describe("an interrupted reply line", () => {
  it("is the checkpoint text, the note, failed and interrupted; made again it stays the same", () => {
    const line = interruptedLine(reply("Hel"), { turnId: "t1", text: "Hello wor" }, { id: "r1", time: "x" });
    expect(line).toEqual({ ...reply(""), text: `Hello wor\n\n${INTERRUPTED_NOTE}`, state: "failed", interrupted: true });
    expect(interruptedLine(line, { turnId: "t1", text: "Hello wor" }, { id: "r1", time: "x" })).toBe(line);
    // No checkpoint text: the words the line had; none at all: the note alone (a new line when there was none).
    expect(interruptedLine(reply("Hel"), { turnId: "t1", text: "" }, { id: "r1", time: "x" }).text).toBe(`Hel\n\n${INTERRUPTED_NOTE}`);
    expect(interruptedLine(null, { turnId: "t1", text: "" }, { id: "r9", time: "2026-11-14T09:00:00.000Z" })).toEqual({ id: "r9", role: "bot", text: INTERRUPTED_NOTE, time: "2026-11-14T09:00:00.000Z", turnId: "t1", state: "failed", interrupted: true });
  });

  it("a snap after the restart shows it so (the server's read model applies turn.interrupted)", async () => {
    const store = quickStore();
    stores.push(store);
    const hub = new LogHub(store);
    hubs.push(hub);
    await store.submit((db) => ensureStream(db, A));
    await hub.append(A, [{ kind: "message.added", body: { botId: "alpha", message: reply("Hel") } }]);
    await hub.append(A, [{ kind: "turn.interrupted", body: { botId: "alpha", turnId: "t1", messageId: "r1", text: "Hello wor" } }]);
    const view = BotSnapView.parse(readSnap(store.db, A)!.frame.view);
    expect(view.messages).toEqual([{ ...reply(""), text: `Hello wor\n\n${INTERRUPTED_NOTE}`, state: "failed", interrupted: true }]);
  });

  it("the 2.x chat page gets the words and the note, marked interrupted (no Continue or Retry exists to show)", () => {
    const bot = { id: "alpha", name: "A", role: "main", avatar: "circle", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null } as unknown as BotView;
    const line = interruptedLine(reply("Hel"), { turnId: "t1", text: "Hello wor" }, { id: "r1", time: "x" });
    const { state } = chatState(bot, { botId: "alpha", messages: [line], running: null, live: [] });
    expect(state.messages[0]).toMatchObject({ text: `Hello wor\n\n${INTERRUPTED_NOTE}`, interrupted: true });
    expect(state.working).toBeFalsy();
  });
});
