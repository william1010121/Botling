// botlingd's parts around the session (M1 step 9), each on its own: the per-connection live cap (LiveGate), the shell
// bridge (no window ⇒ the bot is told to open Botling 3), which commands a `req` may carry, the data folder and token,
// bot store keys, the step-boundary line update, the srv: stream in the hub, and a restore's reset with its backup time.
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Event as ContractEvent } from "../../src/contract";
import { connReduce, initialConn } from "../../src/fe-link/connection-state";
import { noticeText, READ_COMMANDS } from "../../src/main-v3/renderer-adapter";
import type { Message, StreamId } from "../../src/protocol";
import { storeKeyOf } from "../../src/server/botlingd";
import { BotlingdEngine } from "../../src/server/botlingd-engine";
import type { EngineHost, TurnEngine } from "../../src/server/effects";
import { appendEntries, ensureStream, LogHub } from "../../src/server/log";
import type { LiveChannel, LiveFrame } from "../../src/server/live";
import { restoreBackup } from "../../src/server/restore";
import { botlingdPaths, LiveGate, PathsError, readToken, refuse2xData, sameToken, servedAsReq, writeToken, type LiveGateClock } from "../../src/server/session";
import { NO_WINDOW_ERROR, ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, takeBackup } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

const root = testRoot("botlingd-parts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

class GateClock implements LiveGateClock {
  time = 1_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private ids = 0;
  now(): number { return this.time; }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.ids; this.timers.push({ at: this.time + ms, fn, id }); return id; }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter((timer) => timer.id !== handle); }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.time = next.at;
      next.fn();
      await Promise.resolve();
    }
    this.time = end;
    await Promise.resolve();
  }
}

const frame = (stream: string, rev: number, at: number, text: string, turnId = "t1"): LiveFrame => ({ t: "live", stream: stream as StreamId, turnId, seg: 0, rev, at, text });

describe("LiveGate: at most one live frame per 100 ms on a connection", () => {
  it("lets the first frame through, drops a second stream's until its turn, then asks it for the whole segment", async () => {
    const clock = new GateClock();
    const sent: LiveFrame[] = [];
    const gate = new LiveGate((f) => sent.push(f), { clock, intervalMs: 100 });
    const resyncs: string[] = [];
    const a = gate.add("bot:A", () => resyncs.push("A"));
    const b = gate.add("bot:B", () => resyncs.push("B"));
    a(frame("bot:A", 1, 0, "hel"));
    b(frame("bot:B", 1, 0, "wor"));
    expect(sent.map((f) => f.stream)).toEqual(["bot:A"]);
    // B waits: its appends are dropped too (the receiver would see a rev gap).
    b(frame("bot:B", 2, 3, "ld"));
    expect(gate.dropped).toBe(2);
    await clock.advance(100);
    expect(resyncs).toEqual(["B"]);
    // The channel answers the resync with a whole-segment frame: it goes, whatever A sends meanwhile.
    a(frame("bot:A", 2, 3, "lo"));
    b(frame("bot:B", 3, 0, "world"));
    expect(sent.map((f) => `${f.stream}:${f.text}`)).toEqual(["bot:A:hel", "bot:B:world"]);
    // A's dropped append makes A wait in turn.
    await clock.advance(100);
    expect(resyncs).toEqual(["B", "A"]);
    gate.close();
  });

  it("a grant whose frame never came (the turn ended) lapses and the stream's next turn streams again", async () => {
    const clock = new GateClock();
    const sent: LiveFrame[] = [];
    const gate = new LiveGate((f) => sent.push(f), { clock, intervalMs: 100 });
    const a = gate.add("bot:A", () => undefined);
    // B's resync finds its turn over: the channel sends nothing.
    const b = gate.add("bot:B", () => undefined);
    a(frame("bot:A", 1, 0, "hel"));
    b(frame("bot:B", 1, 0, "wor"));
    await clock.advance(100); // B granted, no frame
    await clock.advance(100); // the grant lapses
    await clock.advance(1_000);
    // B's next turn: its frames go out again (before the fix B stayed waiting and lost every frame for good).
    b(frame("bot:B", 1, 0, "next", "t2"));
    await clock.advance(100);
    b(frame("bot:B", 2, 4, " turn", "t2"));
    expect(sent.filter((f) => f.stream === "bot:B").map((f) => f.text)).toEqual(["next", " turn"]);
    gate.close();
  });

  it("never sends two frames within the interval, except the rest of one too-big segment in the same tick", async () => {
    const clock = new GateClock();
    const sent: Array<{ f: LiveFrame; at: number }> = [];
    const gate = new LiveGate((f) => sent.push({ f, at: clock.now() }), { clock, intervalMs: 100 });
    const a = gate.add("bot:A", () => undefined);
    a(frame("bot:A", 1, 0, "x".repeat(10)));
    a(frame("bot:A", 2, 10, "y".repeat(10))); // same tick, continues the frame just sent
    expect(sent).toHaveLength(2);
    await Promise.resolve();
    a(frame("bot:A", 3, 20, "z")); // next tick, inside the interval: dropped, A waits
    expect(sent).toHaveLength(2);
    for (let i = 0; i < 20; i++) await clock.advance(30);
    const times = sent.map((s) => s.at);
    for (let i = 2; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100);
    gate.close();
  });
});

describe("ShellBridge: the core's app ops go to the attached window", () => {
  it("fails at once with no window: the bot is told to open Botling 3", async () => {
    const bridge = new ShellBridge();
    await expect(bridge.request("browser", { request: "{}" })).resolves.toEqual({ ok: false, error: NO_WINDOW_ERROR });
    await expect(bridge.request("screenshot")).resolves.toMatchObject({ ok: false });
    expect(NO_WINDOW_ERROR).toMatch(/open Botling 3 to use the browser/i);
  });

  it("sends shell.* to the newest window and settles with its shell.done; a window that leaves fails its asks", async () => {
    const bridge = new ShellBridge({ timeoutMs: 1_000 });
    const sent: Message[] = [];
    const window = { send: (m: Message) => { sent.push(m); return true; } };
    const other = { send: () => true };
    bridge.attach(other);
    bridge.attach(window);
    const asked = bridge.request("browser", { request: '{"op":"tabs"}' });
    expect(sent).toEqual([{ t: "shell.browser", req: "shell-1", args: { request: '{"op":"tabs"}' } }]);
    bridge.answer(other, { t: "shell.done", req: "shell-1", ok: false }); // not its ask: ignored
    bridge.answer(window, { t: "shell.done", req: "shell-1", ok: true, data: { tabs: [] } });
    await expect(asked).resolves.toEqual({ ok: true, data: { tabs: [] } });
    const shot = bridge.request("screenshot");
    bridge.detach(window);
    await expect(shot).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/closed/) });
    expect(bridge.appBridge()).toMatchObject({ pid: null, bundle: null });
    bridge.close();
  });
});

describe("req: read commands only", () => {
  it("serves every command the window's adapter sends as a read, and refuses mutating ones", () => {
    for (const type of READ_COMMANDS) expect(servedAsReq(type), type).toBe(true);
    for (const type of ["chat.send", "bots.create", "settings.set", "turn.stop"] as const) expect(servedAsReq(type)).toBe(false);
  });
});

describe("data folder, socket and token", () => {
  it("needs a data folder, refuses a socket path macOS cannot take, and a 2.x data folder", () => {
    expect(() => botlingdPaths({})).toThrow(PathsError);
    expect(botlingdPaths({ BOTLING_DATA_DIR: "/d" })).toEqual({ dataDir: "/d", socket: "/d/botlingd.sock", token: "/d/botlingd.token" });
    expect(botlingdPaths({ BOTLING_SERVER_DATA_DIR: "/s", BOTLING_DATA_DIR: "/d", BOTLING_SERVER_SOCKET: "/t.sock" }).socket).toBe("/t.sock");
    expect(() => botlingdPaths({ BOTLING_DATA_DIR: `/${"x".repeat(120)}` })).toThrow(/104|103/);
    const old = join(root, "two");
    mkdirSync(join(old, "projects"), { recursive: true });
    expect(() => refuse2xData(old)).toThrow(/2\.x/);
    writeFileSync(join(old, "server.db"), "");
    expect(() => refuse2xData(old)).not.toThrow();
  });

  it("writes a new 0600 token each time and compares tokens in constant time", () => {
    const file = join(root, "botlingd.token");
    const first = writeToken(file);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readToken(file)).toBe(first);
    expect(writeToken(file)).not.toBe(first);
    expect(sameToken(readToken(file)!, readToken(file)!)).toBe(true);
    expect(sameToken(undefined, first)).toBe(false);
    expect(sameToken(first.slice(1), first)).toBe(false);
  });

  it("keys bot stores by bot id, and a second head's by <id>/partner-<engine>", () => {
    const mainId = "0F0F0000-0000-4000-8000-000000000001";
    expect(storeKeyOf("/d", "/d/main", mainId)).toBe(mainId);
    expect(storeKeyOf("/d", "/d/projects/B1", mainId)).toBe("B1");
    expect(storeKeyOf("/d", "/d/projects/B1/partner-codex", mainId)).toBe("B1/partner-codex");
    expect(storeKeyOf("/d", "/d/main/partner-codex", mainId)).toBe(`${mainId}/partner-codex`);
  });
});

describe("BotlingdEngine: a step boundary keeps the text so far in the reply line", () => {
  it("adds message.updated with the live text before a turn.steps that adds a step, and feeds every event to the exports", () => {
    let host!: EngineHost;
    const inner = { attach: (h: EngineHost) => { host = h; } } as unknown as TurnEngine;
    let text = "";
    const live = { running: () => ({ botId: "B", turnId: "t", seg: 0, text, turnText: text }) } as unknown as LiveChannel;
    const fed: string[] = [];
    const engine = new BotlingdEngine(inner, { live, feed: (e) => fed.push(e.type) });
    const seen: ContractEvent[] = [];
    engine.attach({ event: (e) => seen.push(e), deferTurn: () => false });
    const line = { id: "R", role: "bot" as const, text: "", time: "2026-01-01T00:00:00.000Z", turnId: "t", state: "streaming" as const };
    host.event({ type: "turn.started", botId: "B", turnId: "t", messageId: "R" } as ContractEvent);
    host.event({ type: "message.added", botId: "B", message: line } as ContractEvent);
    text = "Looking at it.";
    host.event({ type: "turn.steps", botId: "B", turnId: "t", messageId: "R", steps: [{}] } as unknown as ContractEvent);
    host.event({ type: "turn.steps", botId: "B", turnId: "t", messageId: "R", steps: [{}] } as unknown as ContractEvent); // no new step
    expect(seen.map((e) => e.type)).toEqual(["turn.started", "message.added", "message.updated", "turn.steps", "turn.steps"]);
    expect(seen[2]).toEqual({ type: "message.updated", botId: "B", message: { ...line, text: "Looking at it." } });
    expect(fed).toEqual(["turn.started", "message.added", "turn.steps", "turn.steps"]);
  });

  it("hands callInTurn on to the inner engine, and has none when the inner engine has none (M5-02b guest check)", async () => {
    const calls: unknown[][] = [];
    const answer = { kind: "reply", text: "hi", steps: [] };
    const inner = { callInTurn: async (...args: unknown[]) => { calls.push(args); return answer; } } as unknown as TurnEngine;
    const engine = new BotlingdEngine(inner);
    const onBegin = () => undefined;
    const options = { host: { botId: "H", name: "Host" }, asked: "q", by: "bot" } as unknown as Parameters<NonNullable<TurnEngine["callInTurn"]>>[3];
    expect(await engine.callInTurn!("G", "prompt", onBegin, options)).toBe(answer);
    expect(calls).toEqual([["G", "prompt", onBegin, options]]);
    expect(new BotlingdEngine({} as unknown as TurnEngine).callInTurn).toBeUndefined();
  });
});

describe("the srv: stream and a restore", () => {
  it("serves this server's srv: stream (snap {serverId, bots}); a restore resets readers with the backup's time", async () => {
    const dataDir = join(root, "server");
    let store = await openServerStore(dataDir);
    const serverId = store.meta("serverId")!;
    const srv = `srv:${serverId}` as StreamId;
    await store.submit((db) => {
      ensureStream(db, srv);
      appendEntries(db, srv, [{ kind: "cmd.skipped", body: { origin: "o", originEpoch: "0".repeat(32), target: srv, from: 1, to: 1 } }]);
    });
    const hub = new LogHub(store, { serverStreams: true });
    const frames: Message[] = [];
    const reader = hub.attach((m) => frames.push(m));
    expect(await reader.sub(srv, null)).toEqual({ ok: true });
    const snap = frames.find((m) => m.t === "snap") as Extract<Message, { t: "snap" }>;
    expect(snap.view).toEqual({ serverId, bots: [] });
    const cursor = { logId: snap.logId, seq: snap.seq };
    hub.close();
    const takenAt = new Date(Date.now() - 60_000);
    const backup = await takeBackup(store.file, store.backupsDir, "manual", takenAt);
    await store.close();

    const restored = await restoreBackup(dataDir, backup);
    expect(restored.streams).toBeGreaterThanOrEqual(1);
    // When the backup was taken, from its own metadata (step 12), not its file time.
    expect(restored).toMatchObject({ restoredTo: takenAt.getTime(), restoredToFrom: "metadata" });
    expect(restored.restoredTo).not.toBe(Math.floor(statSync(backup).mtimeMs));
    store = await openServerStore(dataDir);
    try {
      const after = new LogHub(store, { serverStreams: true });
      const seen: Message[] = [];
      await after.attach((m) => seen.push(m)).sub(srv, cursor);
      expect(seen[0]).toMatchObject({ t: "reset", stream: srv, reason: "restored", restoredTo: restored.restoredTo, retired: [{ logId: cursor.logId }] });
      expect(seen[1]).toMatchObject({ t: "snap", stream: srv });
      after.close();
    } finally {
      await store.close();
    }
    // Without `serverStreams` the hub serves bot streams only (step 7's default).
  });

  it("the window's notice says what time the history went back to", () => {
    let model = connReduce(initialConn(0), { type: "welcome", catching: false }, 0);
    model = connReduce(model, { type: "reset", restoredTo: new Date(2026, 10, 3, 9, 5).getTime() }, 10);
    expect(noticeText(model)).toBe("This machine's history was restored to 2026-11-03 09:05 from a backup. Lines after that are gone.");
    model = connReduce(model, { type: "restore seen" }, 20);
    expect(model.restoredTo).toBeNull();
  });
});
