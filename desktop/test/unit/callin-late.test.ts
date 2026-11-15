// Botling 3 M5-03a: the "late" rule and `callin.cancel` (protocol v1 §15, D51, `CrossCallin.tla` bug_latewake).
//
// When the host gives up on a call-in (B silent for 75 s, B gone, the 16 min cap) it sends ONE `callin.cancel` and remembers
// the callId as given up (`meta` `callin:gaveup:<id>`, kept 7 days). A `callin.reply` that comes afterwards is appended to the
// host chat marked late and wakes nobody; a restart of A in between changes nothing; a reply is posted at most once.
//
// Part 1: the real intent runtime (in-memory server.db, the real handler) with a fake `ServerOrigin` and a fake clock.
// Part 2: a real `Core` (the chat the user sees: the notice, the line, no wake). Part 3: B's real guest side meets the cancel.
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "../../src/core/bot";
import type { Conversations, RemoteTurnRequest } from "../../src/core/conversations";
import { saveProjectRow } from "../../src/core/projects";
import { Core } from "../../src/core/server";
import type { ChatRecord } from "../../src/core/store/records";
import { Command, type Command as CommandType } from "../../src/contract";
import { encodeWireFrame, type Outcome, type Slot, type Target } from "../../src/protocol";
import { CallInHost, GAVEUP_KEEP_MS, GAVEUP_PREFIX, gaveUpKey, type CallInHostSender, type LateLine } from "../../src/server/callin";
import { GaveUpBook } from "../../src/server/callin/late";
import type { TxScope } from "../../src/server/effects";
import type { Db } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";
import { tempDir } from "../helpers";
import { harness, outcomeOf, type Harness } from "./server-intents-harness";

const HOST = "6A0B0000-0000-4000-8000-000000000003";
const GUEST = "6A0B0000-0000-4000-8000-0000000000B1";
const SERVER_B = "srv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVER_C = "srv_cccccccccccccccccccccccccccccc";
const GUEST_TARGET = `bot:${GUEST}` as Target;
const MEMBER = { id: GUEST, name: "build", server: SERVER_B, serverName: "build-box" };
const UNREACHABLE = 'its machine "build-box" is not reachable';
const LATE_NOTICE = "Late answer from build (after its machine was not reachable): nobody was woken for it.";

type Ask = Extract<CommandType, { type: "callin.ask" }>;
type Cancel = Extract<CommandType, { type: "callin.cancel" }>;
type Reply = Extract<CommandType, { type: "callin.reply" }>;

const line = (role: ChatRecord["role"], text: string, id: string): ChatRecord => ({ id, role, text, date: 0 });

function request(over: Partial<RemoteTurnRequest> = {}): RemoteTurnRequest & { signal?: AbortSignal } {
  return {
    member: MEMBER, host: { botId: HOST, name: "alpha" },
    transcript: [line("user", "hello", "U1"), line("user", "@build what does the build say?", "U2")],
    newest: "U2", ask: null, asked: "@build what does the build say?", by: "user", depth: 1,
    speakerName: () => null,
    ...over,
  };
}

/** A stand-in for `ServerOrigin`: parses and frame-checks like the real `submit`, records everything that goes to B. */
function fakeSender(options: { owner?: string | null; failCancel?: boolean; failAsk?: boolean } = {}) {
  const sent: Array<{ target: Target; cmd: Ask | Cancel }> = [];
  const peer: { state: "live" | "stale" | "gone"; since: number | null } = { state: "live", since: null };
  const listeners = new Set<(slot: Slot, outcome: Outcome) => void>();
  let n = 0;
  const sender: CallInHostSender = {
    self: "srv-a",
    peerState: (server) => (server === SERVER_B ? { ...peer } : null),
    ownerOf: (target) => (target === GUEST_TARGET ? (options.owner === undefined ? SERVER_B : options.owner) : null),
    async submit(target, cmd) {
      if (options.failAsk && cmd.type === "callin.ask") throw new TypeError("test: the ask cannot be sent");
      if (options.failCancel && cmd.type === "callin.cancel") throw new TypeError("test: the cancel cannot be sent");
      const parsed = Command.parse(cmd);
      const frame = encodeWireFrame({ t: "cmd", slot: { origin: "srv-a", originEpoch: "f".repeat(32), target, n: 1 }, floor: 1, inc: "x".repeat(10), cmd: parsed, scope: "read" } as never, "peer", { local: false });
      if (!frame.ok) throw new TypeError(frame.detail);
      sent.push({ target, cmd: parsed as Ask | Cancel });
      n += 1;
      return { origin: "srv-a", originEpoch: "f".repeat(32), target, n } as Slot;
    },
    onOutcome(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const asks = () => sent.filter((entry) => entry.cmd.type === "callin.ask").map((entry) => entry.cmd as Ask);
  const cancels = () => sent.filter((entry) => entry.cmd.type === "callin.cancel").map((entry) => entry as { target: Target; cmd: Cancel });
  return { sender, sent, asks, cancels, peer, outcome: (slot: Slot, outcome: Outcome) => { for (const listener of listeners) listener(slot, outcome); } };
}
type Fake = ReturnType<typeof fakeSender>;

const logs: string[] = [];
const open: Harness[] = [];
/** The fake clock: only the host's interval and `Date` (the harness and the core keep their real timers). */
const fakeClock = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
afterEach(() => { for (const h of open.splice(0)) h.close(); logs.length = 0; vi.useRealTimers(); });

async function start(options: { fake?: Fake; h?: Harness } = {}) {
  const h = options.h ?? await harness({ bots: ["MAIN", HOST] });
  if (!options.h) open.push(h);
  const fake = options.fake ?? fakeSender();
  const lates: LateLine[] = [];
  h.runtime.callHost.attach(fake.sender);
  h.runtime.callHost.bindLate((late) => { lates.push(late); });
  return { h, host: h.runtime.callHost, fake, lates };
}

const until = async (check: () => boolean) => vi.waitFor(() => { if (!check()) throw new Error("not yet"); });
const replyCmd = (callId: string, outcome: Reply["outcome"], over: Partial<Reply> = {}): CommandType => ({
  type: "callin.reply", botId: HOST, callId, guest: { botId: GUEST, name: "build" }, outcome, ...over,
});
const text = (value: string): Reply["outcome"] => ({ kind: "reply", text: value, engine: "claude" });
const send = (h: Harness, cmd: CommandType, origin = SERVER_B) => h.send(cmd, { origin });
const gaveRows = (h: Harness) => h.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'callin:gaveup:%' ORDER BY key").all().map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as Record<string, unknown> }));

/** One call-in that B never answers: asks, lets B stay silent for 80 s, returns the callId once the cancel went out. */
async function giveUp(fake: Fake, host: CallInHost, over: Partial<RemoteTurnRequest> = {}) {
  const turn = host.remoteTurn(request(over));
  await until(() => fake.asks().length > 0 && fake.asks().some((ask) => !fake.cancels().some((c) => c.cmd.callId === ask.callId)));
  const callId = fake.asks().filter((ask) => !fake.cancels().some((c) => c.cmd.callId === ask.callId)).at(-1)!.callId;
  fake.peer.state = "stale"; fake.peer.since = Date.now();
  await vi.advanceTimersByTimeAsync(80_000);
  await expect(turn).resolves.toEqual({ kind: "failed", why: UNREACHABLE });
  await until(() => fake.cancels().some((c) => c.cmd.callId === callId));
  fake.peer.state = "live";
  return callId;
}

describe("M5-03a part 1: giving up sends callin.cancel once and remembers the call-in; a late reply is late", () => {
  it("1. giving up sends exactly one callin.cancel (to the guest, after the ask); more time, a late reply and close send no second", async () => {
    fakeClock();
    const { h, host, fake } = await start();
    const callId = await giveUp(fake, host);
    expect(fake.sent.map((entry) => entry.cmd.type)).toEqual(["callin.ask", "callin.cancel"]);
    expect(fake.cancels()[0]).toEqual({ target: GUEST_TARGET, cmd: { type: "callin.cancel", botId: GUEST, callId } });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await send(h, replyCmd(callId, text("late")));
    await h.settle();
    host.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.cancels()).toHaveLength(1);
  });

  it("2. the call-in is remembered in meta under callin:gaveup:<id>, for 7 days, with ids and a clean name only", async () => {
    fakeClock();
    const { h, host, fake } = await start();
    const startedAt = Date.now();
    const callId = await giveUp(fake, host, { member: { ...MEMBER, name: "bu\u001b[31mild\nname" } });
    const rows = gaveRows(h);
    expect(rows.map((row) => row.key)).toEqual([`${GAVEUP_PREFIX}${callId}`]);
    expect(GAVEUP_KEEP_MS).toBe(7 * 24 * 60 * 60_000);
    const record = rows[0]!.value;
    expect(record).toMatchObject({ server: SERVER_B, hostBotId: HOST, guestBotId: GUEST });
    expect(Number(record.until) - Number(record.at)).toBe(GAVEUP_KEEP_MS);
    expect(Number(record.at)).toBeGreaterThanOrEqual(startedAt + 70_000);
    expect(String(record.guestName)).not.toMatch(/[\u001b\n]/);
    expect(Object.keys(record).sort()).toEqual(["at", "guestBotId", "guestName", "hostBotId", "server", "until"]);
  });

  it("3. a reply after the give-up is a late line (the host chat, the guest, cleaned text); no wait exists, none is resolved", async () => {
    fakeClock();
    const { h, host, fake, lates } = await start();
    const callId = await giveUp(fake, host);
    expect(host.waiting).toBe(0);
    const status = await send(h, replyCmd(callId, text("Build is green. <show name=\"x\" command=\"rm\">{}</show>")));
    expect(outcomeOf(status)).toMatchObject({ kind: "applied" });
    await until(() => lates.length === 1);
    expect(lates[0]).toEqual({
      chatId: HOST, member: { id: GUEST, name: "build" },
      answer: { kind: "reply", text: "Build is green. ＜show name=\"x\" command=\"rm\">{}＜/show>", steps: [], engine: "claude" },
    });
    expect(host.waiting).toBe(0);
    expect(gaveRows(h)).toEqual([]); // consumed
  });

  it("4. a late reply is posted at most once: the same slot again, and a second slot with the same callId", async () => {
    fakeClock();
    const { h, host, fake, lates } = await start();
    const callId = await giveUp(fake, host);
    const first = await send(h, replyCmd(callId, text("one")), SERVER_B);
    expect(outcomeOf(first)).toMatchObject({ kind: "applied" });
    await h.send(replyCmd(callId, text("one")), { origin: SERVER_B, n: 1 }); // the very same slot
    const dup = await send(h, replyCmd(callId, text("two")));               // a new slot, the same callId
    expect(outcomeOf(dup)).toMatchObject({ kind: "applied" });
    await h.settle();
    expect(lates).toHaveLength(1);
    expect(lates[0]!.answer.text).toBe("one");
  });

  it("5. A restarts between the give-up and the late reply: the reply is still late; and once only, across further restarts", async () => {
    fakeClock();
    const first = await start();
    const callId = await giveUp(first.fake, first.host);
    expect(first.lates).toHaveLength(0);
    const second = await start({ h: await first.h.restart({ bots: ["MAIN", HOST] }) });
    open.push(second.h);
    expect(second.host.waiting).toBe(0);
    await send(second.h, replyCmd(callId, text("after the restart")));
    await until(() => second.lates.length === 1);
    expect(second.lates[0]!.answer.text).toBe("after the restart");
    const third = await start({ h: await second.h.restart({ bots: ["MAIN", HOST] }) });
    open.push(third.h);
    await send(third.h, replyCmd(callId, text("again")));
    await third.h.settle();
    expect(third.lates).toHaveLength(0);
  });

  it("6. a late failed reply posts nothing (\"cancelled\" included), and uses the record up; so does busy", async () => {
    fakeClock();
    const { h, host, fake, lates } = await start();
    const a = await giveUp(fake, host);
    const b = await giveUp(fake, host);
    const c = await giveUp(fake, host);
    const d = await giveUp(fake, host);
    expect(gaveRows(h)).toHaveLength(4);
    await send(h, replyCmd(a, { kind: "failed", why: "cancelled" }));
    await send(h, replyCmd(b, { kind: "failed", why: "its machine restarted during the answer" }));
    await send(h, replyCmd(c, { kind: "busy" }));
    await h.settle();
    expect(lates).toHaveLength(0);
    expect(gaveRows(h).map((row) => row.key)).toEqual([`${GAVEUP_PREFIX}${d}`]);
    // the cancelled call's record is gone, so a real reply that follows is not posted either
    await send(h, replyCmd(a, text("late after cancelled")));
    await h.settle();
    expect(lates).toHaveLength(0);
  });

  it("7. a reply from another server or naming other bots is refused, the record is kept, and the right reply is then late", async () => {
    fakeClock();
    const { h, host, fake, lates } = await start();
    const callId = await giveUp(fake, host);
    const other = await send(h, replyCmd(callId, text("forged")), SERVER_C);
    expect(outcomeOf(other)).toMatchObject({ kind: "refused" });
    const wrongGuest = await send(h, replyCmd(callId, text("forged"), { guest: { botId: "someone-else", name: "x" } }));
    expect(outcomeOf(wrongGuest)).toMatchObject({ kind: "refused", reason: "invalid" });
    const wrongHost = await send(h, replyCmd(callId, text("forged"), { botId: "another-host" }), SERVER_B);
    expect(outcomeOf(wrongHost)).not.toMatchObject({ kind: "applied" });
    await h.settle();
    expect(lates).toHaveLength(0);
    expect(gaveRows(h)).toHaveLength(1);
    await send(h, replyCmd(callId, text("real")));
    await until(() => lates.length === 1);
    expect(lates[0]!.answer.text).toBe("real");
  });

  it("8. the record lives 7 days: a reply just before is late, at the end it is dropped (and its row is removed)", async () => {
    fakeClock();
    const { h, host, fake, lates } = await start();
    const a = await giveUp(fake, host);
    const b = await giveUp(fake, host);
    const until_a = Number(gaveRows(h).find((row) => row.key.endsWith(a))!.value.until);
    const until_b = Number(gaveRows(h).find((row) => row.key.endsWith(b))!.value.until);
    vi.setSystemTime(until_a - 1);
    await send(h, replyCmd(a, text("in time")));
    await until(() => lates.length === 1);
    vi.setSystemTime(until_b);
    const status = await send(h, replyCmd(b, text("too late")));
    expect(outcomeOf(status)).toMatchObject({ kind: "applied" });
    await h.settle();
    expect(lates).toHaveLength(1);
    expect(gaveRows(h)).toEqual([]);
  });

  it("9. expiry is bounded: the next give-up sweeps expired rows, and no more than the cap are ever kept", async () => {
    fakeClock();
    const h = await harness({ bots: ["MAIN", HOST] });
    open.push(h);
    const fake = fakeSender();
    const host = new CallInHost({ scope: h.runtime.scope, maxGaveUp: 3, log: (entry) => logs.push(entry) });
    host.attach(fake.sender);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) { ids.push(await giveUp(fake, host)); await vi.advanceTimersByTimeAsync(1_000); }
    // the cap keeps the newest 3 (written in order, so the oldest go first)
    await until(() => gaveRows(h).length === 3);
    expect(gaveRows(h).map((row) => row.key).sort()).toEqual(ids.slice(2).map((id) => `${GAVEUP_PREFIX}${id}`).sort());
    // 8 days later one more give-up sweeps the three expired ones
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
    const last = await giveUp(fake, host);
    await until(() => gaveRows(h).length === 1);
    expect(gaveRows(h)[0]!.key).toBe(`${GAVEUP_PREFIX}${last}`);
    host.close();
  });

  it("10. the meta key is built only from a callId that passes the id regex", async () => {
    for (const bad of ["", ".", "..", "a:b", "a.b", "a/b", "../x", "x y", "é", "a".repeat(65), "a\n", "__proto__\u0000"]) expect(gaveUpKey(bad)).toBeNull();
    for (const good of ["a", "A-b_9", "constructor", "__proto__", "x".repeat(64), "6A0B0000-0000-4000-8000-0000000000C1"]) expect(gaveUpKey(good)).toBe(`callin:gaveup:${good}`);
    // The contract lets "..", "a:b" and "." through as ids; the handler must drop such a reply without touching meta.
    fakeClock();
    const { h, lates } = await start();
    for (const id of ["..", "a:b", "a.b", "constructor", "__proto__", "toString"]) {
      const status = await send(h, replyCmd(id, text("x")));
      expect(outcomeOf(status)).toMatchObject({ kind: "applied" });
    }
    await h.settle();
    expect(lates).toHaveLength(0);
    expect(gaveRows(h)).toEqual([]);
  });

  it("11. no cancel and no record when nothing was queued or the call-in never was one: ask not sendable, ask refused, no owner, closing", async () => {
    fakeClock();
    // the ask cannot be sent
    const failing = fakeSender({ failAsk: true });
    const a = await start({ fake: failing });
    await expect(a.host.remoteTurn(request())).resolves.toMatchObject({ kind: "failed" });
    // no owner for the guest
    const orphan = fakeSender({ owner: null });
    const b = await start({ fake: orphan });
    await expect(b.host.remoteTurn(request())).resolves.toEqual({ kind: "failed", why: UNREACHABLE });
    // B refuses the ask
    const refusing = fakeSender();
    const c = await start({ fake: refusing });
    const turn = c.host.remoteTurn(request());
    await until(() => refusing.asks().length === 1);
    refusing.outcome({ origin: "srv-a", originEpoch: "f".repeat(32), target: GUEST_TARGET, n: 1 } as Slot, { kind: "refused", reason: "invalid" } as Outcome);
    await expect(turn).resolves.toMatchObject({ kind: "failed" });
    // closing the host while it waits
    const closing = fakeSender();
    const d = await start({ fake: closing });
    const stopping = d.host.remoteTurn(request());
    await until(() => closing.asks().length === 1);
    d.host.close();
    await expect(stopping).resolves.toEqual({ kind: "failed", why: "this machine is stopping" });
    await vi.advanceTimersByTimeAsync(10_000);
    for (const fake of [failing, orphan, refusing, closing]) expect(fake.cancels()).toHaveLength(0);
    for (const env of [a, b, c, d]) expect(gaveRows(env.h)).toEqual([]);
  });

  it("12. an aborted wait cancels the guest once and leaves no record (the caller asked to stop: its answer is not wanted late)", async () => {
    fakeClock();
    const { h, host, fake, lates } = await start();
    const controller = new AbortController();
    const turn = host.remoteTurn({ ...request(), signal: controller.signal });
    await until(() => fake.asks().length === 1);
    const callId = fake.asks()[0]!.callId;
    controller.abort();
    await expect(turn).resolves.toEqual({ kind: "failed", why: "cancelled" });
    await until(() => fake.cancels().length === 1);
    expect(fake.cancels()[0]!.cmd).toEqual({ type: "callin.cancel", botId: GUEST, callId });
    expect(gaveRows(h)).toEqual([]);
    await send(h, replyCmd(callId, text("nobody wants it")));
    await h.settle();
    expect(lates).toHaveLength(0);
    expect(fake.cancels()).toHaveLength(1);
  });

  it("13. a cancel that cannot be sent is logged without peer text, is not retried, and the call-in is still late-able", async () => {
    fakeClock();
    const fake = fakeSender({ failCancel: true });
    const { h, host, lates } = await start({ fake });
    const turn = host.remoteTurn(request());
    await until(() => fake.asks().length === 1);
    const callId = fake.asks()[0]!.callId;
    fake.peer.state = "stale"; fake.peer.since = Date.now();
    await vi.advanceTimersByTimeAsync(80_000);
    await expect(turn).resolves.toEqual({ kind: "failed", why: UNREACHABLE });
    await until(() => gaveRows(h).length === 1);
    await until(() => h.logs.some((entry) => entry.includes("cancel")));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fake.cancels()).toHaveLength(0);
    expect(h.logs.filter((entry) => entry.includes("cancel"))).toHaveLength(1);
    await send(h, replyCmd(callId, text("it answered anyway")));
    await until(() => lates.length === 1);
  });

  it("14. a damaged or foreign meta row under the key is dropped, never trusted, never thrown on", async () => {
    fakeClock();
    const { h, lates } = await start();
    const put = (id: string, value: string) => h.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${GAVEUP_PREFIX}${id}`, value);
    put("bad-json", "{nope");
    put("not-an-object", "42");
    put("wrong-types", JSON.stringify({ server: 1, hostBotId: HOST, guestBotId: GUEST, guestName: "x", at: 0, until: Date.now() + 1000 }));
    put("no-expiry", JSON.stringify({ server: SERVER_B, hostBotId: HOST, guestBotId: GUEST, guestName: "x", at: 0 }));
    for (const id of ["bad-json", "not-an-object", "wrong-types", "no-expiry"]) {
      const status = await send(h, replyCmd(id, text("x")));
      expect(outcomeOf(status)).toMatchObject({ kind: "applied" });
    }
    await h.settle();
    expect(lates).toHaveLength(0);
    expect(gaveRows(h)).toEqual([]);
  });
});

// ---- part 2: a real Core, the chat the user sees ----------------------------------------------------------------------

const BOT_A = "6AC64E3A-C7D7-4000-8000-0000000000A1";
const storeRoot = testRoot("callin-late");
const cores: Core[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.shutdown().catch(() => {}); });
afterAll(() => { rmSync(storeRoot, { recursive: true, force: true }); });

function coreFixture() {
  const dir = tempDir("callin-late");
  const folder = tempDir("callin-late-a");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOT_A, name: "alpha", folder, avatar: "triangle" });
  const holder: { host: CallInHost | null } = { host: null };
  const coreLogs: string[] = [];
  const core = new Core({
    log: (entry) => coreLogs.push(entry),
    dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
    remoteMembers: () => [MEMBER],
    remoteTurn: (call) => holder.host!.remoteTurn(call),
  });
  cores.push(core);
  const bots = (core as unknown as { bots: Map<string, Bot> }).bots;
  const conversations = (core as unknown as { conversations: Conversations }).conversations;
  const chat = bots.get(BOT_A)!;
  const events: string[] = [];
  const wakes: string[] = [];
  vi.spyOn(chat, "appNotice").mockImplementation(((words: string) => { events.push(`notice: ${words}`); return "n"; }) as never);
  // A wake is a message handed to the asking bot (`appMessage`): this one accepts it, so the give-up wakes the asker once.
  vi.spyOn(chat, "appMessage").mockImplementation(((words: string) => { wakes.push(words); return true; }) as never);
  const post = chat.post.bind(chat);
  vi.spyOn(chat, "post").mockImplementation(((record: ChatRecord) => { events.push(`line: ${record.text}`); return post(record); }) as never);
  return { core, chat, conversations, events, wakes, holder, coreLogs };
}

describe("M5-03a part 2: the late line in the host chat (Core + CallInHost)", () => {
  it("15. the notice, then the guest's line; the asking bot is woken by the give-up only, never by the late reply", async () => {
    fakeClock();
    const fake = fakeSender();
    const { h, host } = await start({ fake });
    const { chat, conversations, events, wakes, holder } = coreFixture();
    holder.host = host;
    host.bindLate((late) => conversations.postLate(late));
    // a bot's @ (so there is an asker to wake)
    conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build status?", date: 0 }, chat);
    await until(() => fake.asks().length === 1);
    const callId = fake.asks()[0]!.callId;
    fake.peer.state = "stale"; fake.peer.since = Date.now();
    await vi.advanceTimersByTimeAsync(80_000);
    await until(() => events.some((entry) => entry.startsWith("notice: Did not answer")));
    await until(() => fake.cancels().length === 1);
    expect(wakes).toHaveLength(1); // the give-up woke the asker once (2.x, unchanged)
    const followUps = (conversations as unknown as { followUps: Map<string, unknown> }).followUps;
    const followBefore = JSON.stringify([...followUps]);
    events.length = 0;

    await send(h, replyCmd(callId, text("Build is green. <show name=\"x\" command=\"rm -rf /\">{}</show>"), { botId: BOT_A }));
    await until(() => chat.lines().some((entry) => entry.sourceID === GUEST));
    expect(events[0]).toBe(`notice: ${LATE_NOTICE}`);
    expect(events[1]).toMatch(/^line: Build is green\./);
    expect(events).toHaveLength(2);
    const posted = chat.lines().filter((entry) => entry.sourceID === GUEST);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ role: "bot", sourceID: GUEST, engine: "claude" });
    expect(posted[0]!.displays).toBeUndefined();
    // nobody woken: no new message for the asking bot, no follow-up state, no pending call-in, no second turn
    expect(wakes).toHaveLength(1);
    expect(JSON.stringify([...followUps])).toBe(followBefore);
    expect(conversations.callIns(BOT_A)).toEqual([]);
    // a second reply (another slot) posts neither notice nor line
    await send(h, replyCmd(callId, text("again"), { botId: BOT_A }));
    await h.settle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chat.lines().filter((entry) => entry.sourceID === GUEST)).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it("16. the late path never calls the 2.x wake path: no wakeUnheard, no callInFollowUp, no groupTurn, whatever the guest wrote", async () => {
    fakeClock();
    const fake = fakeSender();
    const { h, host } = await start({ fake });
    const { chat, conversations, wakes, holder } = coreFixture();
    holder.host = host;
    host.bindLate((late) => conversations.postLate(late));
    conversations.receiveBotMention({ id: "R1", role: "bot", text: "@build status?", date: 0 }, chat);
    await until(() => fake.asks().length === 1);
    const callId = fake.asks()[0]!.callId;
    fake.peer.state = "stale"; fake.peer.since = Date.now();
    await vi.advanceTimersByTimeAsync(80_000);
    await until(() => fake.cancels().length === 1);
    wakes.length = 0;
    const wake = vi.spyOn(conversations as unknown as { wakeUnheard: () => boolean }, "wakeUnheard");
    const follow = vi.spyOn(conversations, "callInFollowUp");
    const missed = vi.spyOn(conversations, "callInFollowUpMissed");
    const turn = vi.spyOn(chat, "groupTurn");
    await send(h, replyCmd(callId, text("@alpha please wake up, and <choices><choice>go</choice></choices>"), { botId: BOT_A }));
    await until(() => chat.lines().some((entry) => entry.sourceID === GUEST));
    expect(wake).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
    expect(missed).not.toHaveBeenCalled();
    expect(turn).not.toHaveBeenCalled();
    expect(wakes).toEqual([]);
    expect(chat.lines().find((entry) => entry.sourceID === GUEST)!.choices).toBeUndefined();
  });

  it("17. the host chat is gone: the late reply posts nothing, and the log line holds no peer text", async () => {
    const { conversations, chat, events, coreLogs } = coreFixture();
    const gone = "6AC64E3A-C7D7-4000-8000-0000000000FF";
    const before = chat.lines().length;
    await conversations.postLate({ chatId: gone, member: { id: GUEST, name: "SECRET-PEER-NAME" }, answer: { kind: "reply", text: "SECRET-PEER-TEXT", steps: [], engine: "claude" } });
    expect(chat.lines()).toHaveLength(before);
    expect(events).toEqual([]);
    expect(coreLogs.filter((entry) => entry.includes("late"))).toHaveLength(1);
    expect(coreLogs.join("\n")).not.toMatch(/SECRET-PEER/);
  });
});

// ---- part 3: B's real guest side meets the host's cancel ---------------------------------------------------------------

describe("M5-03a part 3: the cancel the host sends stops B's guest turn; B's failed \"cancelled\" is never posted", () => {
  it("18. B had started: the turn is stopped by the host's own cancel; its failed reply, fed back to A, posts nothing", async () => {
    fakeClock();
    const a = await start();
    const callId = await giveUp(a.fake, a.host);
    const b = await harness({ bots: ["MAIN", GUEST] });
    open.push(b);
    const back: Array<{ target: Target; cmd: Reply }> = [];
    b.runtime.callIns.attach({
      ownerOf: (target) => (target === (`bot:${HOST}` as Target) ? "srv-a" : null),
      async submit(target, cmd) { back.push({ target, cmd: Command.parse(cmd) as Reply }); return { origin: SERVER_B, originEpoch: "f".repeat(32), target, n: back.length } as Slot; },
    });
    b.engine.callInMode = "hold";
    // B receives what A sent, in order: the ask (the turn starts), then the cancel A sent when it gave up
    const ask = a.fake.asks().find((entry) => entry.callId === callId)!;
    await b.send(ask, { origin: "srv-a" });
    for (let i = 0; i < 200 && !b.engine.callIns[0]?.begun; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(b.engine.callIns[0]!.begun).toBe(true);
    await b.send(a.fake.cancels()[0]!.cmd, { origin: "srv-a" });
    await b.settle();
    expect(b.engine.callIns).toHaveLength(1);
    expect(b.engine.callIns[0]!.aborted).toBe(true);
    expect(back).toHaveLength(1);
    expect(back[0]!.cmd.outcome).toEqual({ kind: "failed", why: "cancelled" });
    // that reply reaches A: applied, never posted
    const status = await send(a.h, back[0]!.cmd);
    expect(outcomeOf(status)).toMatchObject({ kind: "applied" });
    await a.h.settle();
    expect(a.lates).toHaveLength(0);
    expect(gaveRows(a.h)).toEqual([]);
  });
});

// ---- review (M5-03a): a reply applied before the give-up's own write ----------------------------------------------------

describe("M5-03a review: the record is not written back after a reply used it up", () => {
  it("19. the reply's transaction runs before the give-up's write: the write adds no row, so a second reply is not late", async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID");
    const db = raw as unknown as Db;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    // The store's writer is busy: the give-up's write waits behind the reply's transaction.
    const scope = { submit: async <T>(work: (tx: Db) => T) => { await gate; return work(db); }, onRollback() {} } as unknown as TxScope;
    const book = new GaveUpBook({ scope, now: () => 1_000, log: () => undefined });
    const saved = book.remember("call-19", { server: SERVER_B, hostBotId: HOST, guestBotId: GUEST, guestName: "build" });
    expect(book.find(db, "call-19")).toMatchObject({ server: SERVER_B, hostBotId: HOST, guestBotId: GUEST });
    book.consume(db, "call-19");
    open();
    await expect(saved).resolves.toBe(true);
    expect(Number((raw.prepare("SELECT count(*) AS n FROM meta").get() as { n: number }).n)).toBe(0);
    expect(book.find(db, "call-19")).toBeNull();
    raw.close();
  });
});
