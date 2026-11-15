// M7-12b (Q-M7-C8): what the window offers on a bot of another machine. M7-12a made the owner accept a window command
// (stamped `manage`); here the window itself: send / card answers / stop / waiting actions go to the owner's bot stream
// as they are, what needs this desktop's own machine is refused at once with the reason (and nothing is queued or asked
// of the attached server), and the attached server's own bots are unchanged.
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { FeLink, MemoryFeStorage } from "../../src/fe-link";
import { peerActionRefusal } from "../../src/main-v3/peer-actions";
import { RendererAdapter, type LinkPort } from "../../src/main-v3/renderer-adapter";
import type { Message, StreamId } from "../../src/protocol";
import type { SummaryRow } from "../../src/protocol/table-rows";
import { FakeClock, FakeServer, flush, SERVER_ID } from "./fe-link-harness";

const B = "srvb";
const FAR = "far1";
const FAR_STREAM = `bot:${FAR}` as StreamId;
const summary = (): SummaryRow => ({
  name: "Faraway", face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle",
  waiting: [], unread: 0, lastAt: null, lines: ["hello"],
} as SummaryRow);

const opened: Array<{ link: FeLink; adapter: RendererAdapter }> = [];
afterEach(async () => { for (const { link: held, adapter } of opened.splice(0)) { adapter.stop(); await held.stop(); } });

let epochs = 0;
async function rig() {
  const server = new FakeServer();
  server.servers = [
    { id: SERVER_ID, name: "Studio", state: "live", since: 1 },
    { id: B, name: "Linux box", state: "live", since: 2 },
  ];
  server.tables.set(`srv:${B}`, { logId: "incb-0001", rev: 1, rows: new Map([[`bot:${FAR}`, { rev: 1, body: summary() }]]), retired: [] });
  server.peerTargets.add(FAR_STREAM);
  const clock = new FakeClock();
  const reqs: Command[] = [];
  server.onMessage = (message: Message) => {
    if (message.t !== "req") return;
    const cmd = (message as { cmd: Command }).cmd;
    reqs.push(cmd);
    if (cmd.type === "chat.snapshot") {
      const own = { id: "b1", name: "Main", role: "main", avatar: "circle", folder: "/p", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
      server.send({ t: "res", req: message.req, ok: true, result: { epoch: "e", seq: 0, bots: [own], imported: null, components: {}, plugins: null, settings: null, doctor: null, waiting: { items: [], doing: {} }, chat: null } } as unknown as Message);
    } else server.send({ t: "res", req: message.req, ok: true, result: {} } as unknown as Message);
  };
  server.snapView = () => ({ bot: null, messages: [], history: { hasMore: false, older: 0 }, cards: [] });
  const held = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "window", feVersion: "3.0.0", clock, newEpoch: () => (++epochs).toString(16).padStart(32, "0"), local: true });
  held.start();
  const adapter = new RendererAdapter({ link: held as unknown as LinkPort, emit: () => {}, clock, noticeDelayMs: 0 });
  opened.push({ link: held, adapter });
  adapter.start();
  await flush();
  await adapter.snapshot();
  const sentTo = (target: string) => server.copies.filter((copy) => copy.slot.target === target);
  const asked = (type: string) => reqs.filter((cmd) => cmd.type === type);
  return { adapter, sentTo, asked, ask: (cmd: Record<string, unknown>) => adapter.request(cmd as Command) };
}

/** Each: a command the owner decides (device scopes), about the peer's bot. */
const OWNER_DECIDES: Array<[string, Record<string, unknown>]> = [
  ["send", { type: "chat.send", botId: FAR, text: "hi" }],
  ["a card choice", { type: "chat.choose", botId: FAR, messageId: "m1", index: 0 }],
  ["a card answer", { type: "chat.answer", botId: FAR, messageId: "m1", text: "yes" }],
  ["ignore a question", { type: "chat.ignoreQuestion", botId: FAR, messageId: "m1" }],
  ["stop", { type: "turn.stop", botId: FAR, turnId: "t1" }],
  ["a waiting action", { type: "waiting.ignore", botId: FAR, text: "ask" }],
  ["an approval", { type: "component.approve", botId: FAR, messageId: "m1", index: 0, command: "ls", folder: "/p" }],
  ["a reaction", { type: "chat.react", botId: FAR, messageId: "m1", emoji: "👍", present: true }],
  ["a bot restart", { type: "bot.restart", botId: FAR }],
];

/** Each: needs this desktop's own machine (`machine`): files, paths, feedback to the maintainer. */
const NEEDS_THIS_MACHINE: Array<[string, Record<string, unknown>]> = [
  ["a project file search (a read)", { type: "project.files", botId: FAR, query: "a" }],
  ["a worker's folder (a read)", { type: "worker.cwd", botId: FAR, subagentId: "w1" }],
  ["a worker's file (a read)", { type: "worker.file", botId: FAR, subagentId: "w1", path: "a.txt" }],
  ["feedback (a command)", { type: "chat.feedback", botId: FAR, messageId: "m1", text: "x", images: [], rect: null }],
];

describe("peerActionRefusal", () => {
  it("machine and admin commands name the machine and the scope; server-only commands say who sends them; the rest goes", () => {
    expect(peerActionRefusal({ type: "project.files", botId: FAR, query: "a" } as Command, "Linux box")).toBe("project.files needs the desktop window on Linux box (machine)");
    expect(peerActionRefusal({ type: "mobile.pair" } as Command, "Linux box")).toBe("mobile.pair needs the desktop window on Linux box (admin)");
    expect(peerActionRefusal({ type: "callin.cancel" } as Command, "Linux box")).toBe("callin.cancel is only sent by another server");
    for (const [, cmd] of OWNER_DECIDES) expect(peerActionRefusal(cmd as unknown as Command, "Linux box")).toBeNull();
    // A machine-security setting is `machine` too; an ordinary one is the owner's to decide.
    expect(peerActionRefusal({ type: "settings.set", change: { key: "developerMode", value: true } } as unknown as Command, "x")).toContain("(machine)");
    expect(peerActionRefusal({ type: "settings.set", change: { key: "theme", value: "dark" } } as unknown as Command, "x")).toBeNull();
  });
});

describe("the window on a peer's bot (M7-12b)", () => {
  it.each(OWNER_DECIDES)("%s goes to the owner's bot stream as it is, not refused here", async (_name, cmd) => {
    const { ask, sentTo } = await rig();
    void ask(cmd);
    await flush();
    const copies = sentTo(FAR_STREAM);
    expect(copies).toHaveLength(1);
    expect(copies[0].cmd).toMatchObject(cmd);
  });

  it.each(NEEDS_THIS_MACHINE)("%s is refused at once with the machine's name; nothing is queued or asked of the attached server", async (_name, cmd) => {
    const { ask, sentTo, asked } = await rig();
    const answer = await ask(cmd);
    expect(answer).toEqual({ ok: false, error: { code: "forbidden", message: `not sent: ${String(cmd.type)} needs the desktop window on Linux box (machine)` } });
    await flush();
    expect(sentTo(FAR_STREAM)).toEqual([]);
    expect(asked(String(cmd.type))).toEqual([]);
  });

  it("the attached server's own bot: the same commands are unchanged (a read is asked, a command is queued)", async () => {
    const { ask, sentTo, asked } = await rig();
    expect(await ask({ type: "project.files", botId: "b1", query: "a" })).toMatchObject({ ok: true });
    expect(asked("project.files")).toHaveLength(1);
    void ask({ type: "chat.feedback", botId: "b1", messageId: "m1", text: "x", images: [], rect: null });
    void ask({ type: "chat.send", botId: "b1", text: "hi" });
    await flush();
    expect(sentTo("bot:b1").map((copy) => copy.cmd.type)).toEqual(["chat.feedback", "chat.send"]);
  });

  it("a command with no bot is not about a peer: it goes to the attached server as before", async () => {
    const { ask, asked } = await rig();
    expect(await ask({ type: "mobile.view" })).toMatchObject({ ok: true });
    expect(asked("mobile.view")).toHaveLength(1);
  });

  it("window hints for a peer's bot still answer empty without being sent", async () => {
    const { ask, asked } = await rig();
    expect(await ask({ type: "chat.read", botId: FAR })).toEqual({ ok: true, result: {} });
    expect(await ask({ type: "chat.shown", botId: FAR })).toEqual({ ok: true, result: {} });
    expect(asked("chat.read")).toEqual([]);
  });
});
