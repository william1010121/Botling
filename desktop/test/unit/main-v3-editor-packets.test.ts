// M1 demo bug 1 on Botling 3's side: the chat state the 2.x window sends its native chat page has a routine chip with
// `started: now` on the newest bot reply, so that row's JSON (the chat page's row key, Web/src/main.ts) changes at every
// build and the page draws it anew, restarting a video in it. main-v3 makes the packets steady before main relays them
// (src/main-v3/editor-packets.ts) without changing the 2.x renderer or main.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BotView, MessageView, RoutineView } from "../../src/contract";
import { EDITOR_CHANNEL } from "../../src/editor-host-wire";
import { chatState } from "../../src/renderer/payload";
import { installEditorPacketFilter, ROUTINE_CHIP_STARTED, steadyEditorPacket, type IpcMainLike } from "../../src/main-v3/editor-packets";

const bot = { id: "B", name: "main", role: "main", avatar: "circle", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null } as unknown as BotView;
const routine = { id: "r-daily", kind: "recurring", task: "Write the daily summary", title: "Daily summary", schedule: "Every day 08:15", cron: "15 8 * * *", status: "enabled", next: "2026-11-15T08:15:00.000Z" } as unknown as RoutineView;
const messages: MessageView[] = [
  { id: "u1", role: "user", text: "Show me the clip", time: "2026-11-14T09:00:00.000Z" },
  { id: "r1", role: "bot", text: "Here: ![clip](file:///Users/x/clip.mp4)", time: "2026-11-14T09:00:05.000Z", state: "done" },
];
const stamp = { surfaceId: "s1", documentGeneration: "g1" };
/** The 2.x chat state at `now` (renderer/payload.ts), as the window builds it. */
const stateAt = (now: number) => chatState(bot, { botId: "B", messages, running: null, live: [], routines: [routine] } as never, new Date(now));
/**
 * What the window sent at `now` before the 2.x renderer made routine chips steady (App.tsx ChatFrame: a full state at every
 * re-bind): the routine chip's `started` was `now`. main-v3 still steadies such packets (an older window build).
 */
const packetAt = (now: number) => {
  const { state, extras } = stateAt(now);
  const rows = state.messages.map((row) => row.tasks ? { ...row, tasks: row.tasks.map((chip) => chip.id.startsWith("routine:") ? { ...chip, started: now } : chip) } : row);
  return { stamp, message: { botling: "state", state: { ...state, messages: rows }, extras, revision: 1 } };
};
/** The chat page's key for each row (Web/src/main.ts: `JSON.stringify([message, mark])`, no components here). */
const rowKeys = (packet: unknown) => ((packet as { message: { state: { messages: unknown[] } } }).message.state.messages).map((m) => JSON.stringify([m, null]));

describe("steady chat packets", () => {
  it("the same chat built 30 s apart gives the same rows once steady (the 2.x packets differ in the newest row)", () => {
    const t = Date.parse("2026-11-14T09:01:00.000Z");
    const a = packetAt(t);
    const b = packetAt(t + 30_000);
    // The 2.x renderer's packets: the newest bot row carries the routine chip, and its key changes.
    expect(rowKeys(a)[1]).not.toBe(rowKeys(b)[1]);
    expect(rowKeys(steadyEditorPacket(a))).toEqual(rowKeys(steadyEditorPacket(b)));
    const chip = (steadyEditorPacket(a) as ReturnType<typeof packetAt>).message.state.messages[1].tasks![0];
    expect(chip).toMatchObject({ id: "routine:r-daily", kind: "cron", started: ROUTINE_CHIP_STARTED, fires: Date.parse(routine.next!) });
    // Nothing else moves: the packet it was given is not changed, and a row with no routine chip is the same object.
    expect(rowKeys(a)[1]).toContain(`"started":${t}`);
    expect((steadyEditorPacket(a) as ReturnType<typeof packetAt>).message.state.messages[0]).toBe(a.message.state.messages[0]);
    // The 2.x renderer now builds the steady value itself (the same one), so its packets pass unchanged in effect.
    expect(stateAt(t).state.messages[1]!.tasks![0]!.started).toBe(ROUTINE_CHIP_STARTED);
    expect(JSON.stringify(stateAt(t).state.messages)).toBe(JSON.stringify(stateAt(t + 30_000).state.messages));
  });

  it("a stateDelta's changed rows are made steady too; other packets and real tasks pass as they are", () => {
    const row = packetAt(1).message.state.messages[1];
    const delta = { stamp, message: { botling: "stateDelta", botID: "B", baseRevision: 1, revision: 2, patch: { order: ["u1", "r1"], changed: [row] }, extras: {} } };
    const steady = steadyEditorPacket(delta) as typeof delta;
    expect(steady.message.patch.changed[0].tasks![0].started).toBe(ROUTINE_CHIP_STARTED);
    const command = { ...row, tasks: [{ id: "task-1", kind: "command", title: "npm test", status: "running", started: 5, ended: null, detail: null }] };
    const plain = { stamp, message: { botling: "state", state: { messages: [command] } } };
    expect(steadyEditorPacket(plain)).toBe(plain);
    const focus = { stamp, message: { botling: "focus" } };
    expect(steadyEditorPacket(focus)).toBe(focus);
    expect(steadyEditorPacket(null)).toBe(null);
  });
});

describe("installEditorPacketFilter", () => {
  it("main's relay listener for the editor's down channel gets the steady packet; it is removed as registered", () => {
    const ipc = new EventEmitter();
    installEditorPacketFilter(ipc as unknown as IpcMainLike);
    installEditorPacketFilter(ipc as unknown as IpcMainLike); // twice: still one wrapping
    const got: unknown[] = [];
    const other: unknown[] = [];
    const down = (_event: unknown, packet: unknown) => got.push(packet);
    const up = (_event: unknown, packet: unknown) => other.push(packet);
    ipc.on(EDITOR_CHANNEL.down, down);
    ipc.on(EDITOR_CHANNEL.up, up);
    const packet = packetAt(1);
    ipc.emit(EDITOR_CHANNEL.down, {}, packet);
    ipc.emit(EDITOR_CHANNEL.up, {}, packet);
    expect(rowKeys(got[0])).toEqual(rowKeys(steadyEditorPacket(packetAt(2))));
    expect(other[0]).toBe(packet);
    ipc.removeListener(EDITOR_CHANNEL.down, down);
    ipc.off(EDITOR_CHANNEL.up, up);
    expect(ipc.listenerCount(EDITOR_CHANNEL.down)).toBe(0);
    expect(ipc.listenerCount(EDITOR_CHANNEL.up)).toBe(0);
  });
});
