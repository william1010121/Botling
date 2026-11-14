// Backup / restore end to end (M1 step 12; protocol v1 §7.6, §8.3, §11.3, D49, D50) under plain Node, no window: the
// built botlingd (out/server/main.cjs) with the fake engine on a temp data folder, a scripted front end on the socket,
// and Botling 3's window main headless (ServerClient: the real fe-link and renderer adapter, its events applied by the
// real renderer store).
//
// 1. Before the backup: the script sends slot 1, the window sends one line; both delivered.
// 2. `botlingd backup` while it runs: the copy carries when it was taken (meta.backupAt), not a file time. The daily
//    backup ran too (check interval shortened). `status` shows the newest backup and the Doctor notes.
// 3. Two more messages: the script's slot 2 and the window's second line, both delivered.
// 4. `botlingd restore` is refused while the server runs (exit 75); `restore --stop` stops it and restores. While it is
//    down the window writes a third line (waiting in its outbox).
// 5. The next start:
//    - the script, reconnecting, sends slot 3 with the old `inc` before it has the srv: reset → `cmd.retry` with the new
//      inc, and nothing is stored for it (D49);
//    - its newer cursors get `reset` (the old logId retired with the seq the restore kept, `restoredTo` = the backup's
//      time) + `snap`;
//    - slot 3 re-sent with the new inc and `floor` 3: the owner forgot slot 2, so `cmd.skipped{2..2}` unblocks it and
//      slot 3 applies once; sent again → its stored outcome; slot 2 sent again → `skipped`, never applied again;
//    - the window reattaches by itself: its third line went out with the old inc → `cmd.retry` → re-sent once it had the
//      reset → applied exactly once (floor skips its lost second slot); a batch of the retired logId and a `cmd.result`
//      naming it, handed to the window's link right after the reset and again after the new snap, are dropped (D50);
//    - the renderer shows "history restored to <time>" with the backup's time, the lines after the backup are gone, and
//      no item is left waiting; the next send clears the notice.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Command, EventEnvelope, MessageView, ResultOf } from "../../src/contract";
import { FeLink, MemoryFeStorage, type Dial } from "../../src/fe-link";
import { ServerClient } from "../../src/main-v3/server-client";
import { unixDial } from "../../src/main-v3/unix-dial";
import { NOTICE_ID } from "../../src/main-v3/renderer-adapter";
import { decodeFrame, encodeFrame, type Entry, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { WorkspaceStore } from "../../src/renderer/store";
import { readEntries } from "../../src/server/log";
import { openReaderDb } from "../../src/server/store/connection";
import { BotlingdProcess, botlingdEnv, botlingdScript, MAIN, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";

const root = testRoot("restore");
const dataDir = join(root, "data");
const BOT = `bot:${MAIN}` as const;
const extra = { BOTLING_SERVER_BACKUP_CHECK_MS: "300" };
const running: BotlingdProcess[] = [];
const windows: ServerClient[] = [];
afterAll(async () => {
  for (const window of windows) await window.stop();
  for (const daemon of running) await daemon.stop("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

function start(): BotlingdProcess {
  const daemon = new BotlingdProcess(dataDir, extra);
  running.push(daemon);
  return daemon;
}

/** A botlingd command run without blocking this process (the window and the server's pipes keep going meanwhile). */
function command(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", botlingdScript, ...args], { env: botlingdEnv(dataDir, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;
const isRetry = (slot: Slot) => (m: Message): m is MessageOf<"cmd.retry"> => m.t === "cmd.retry" && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;
const userLines = (entries: Entry[], token: string) => entries.filter((entry) => entry.kind === "message.added"
  && (entry.body as { message: { role: string; text: string } }).message.role === "user"
  && (entry.body as { message: { text: string } }).message.text.includes(token));
const finishedWith = (entries: Entry[], token: string) => entries.find((entry) => entry.kind === "turn.finished" && String((entry.body as { text?: string }).text ?? "").includes(token)) ?? null;

/** The notice's local "YYYY-MM-DD hh:mm", as the renderer adapter writes it. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Botling 3's window main, headless: ServerClient → adapter → the real renderer store. Frames are recorded, and stale ones can be handed in. */
function openWindow() {
  const received: Message[] = [];
  const injected: Message[] = [];
  let tap: ((message: Message, deliver: (extra: Message) => void) => void) | null = null;
  const dial: Dial = (handlers) => unixDial({ path: join(dataDir, "botlingd.sock") })({
    ...handlers,
    frame: (frame) => {
      handlers.frame(frame);
      const decoded = decodeFrame(frame, "server", { local: true });
      if (!decoded.ok) return;
      received.push(decoded.message);
      tap?.(decoded.message, (message) => {
        const encoded = encodeFrame(message, "server", { local: true });
        if (!encoded.ok) throw new Error(encoded.detail);
        injected.push(message);
        handlers.frame(encoded.text);
      });
    },
  });
  let store!: WorkspaceStore;
  const audit: string[] = [];
  const window = new ServerClient(
    { script: join(desktop, "out", "core", "main.cjs"), env: { BOTLING_APP_DATA_DIR: join(root, "app"), BOTLING_SERVER_DATA_DIR: dataDir }, onEvent: (envelope: EventEnvelope) => store.receive(envelope), audit: (line) => audit.push(line) },
    { storage: () => new MemoryFeStorage(), dial, launch: () => undefined, link: { reconnectMinMs: 100, reconnectMaxMs: 400 } },
  );
  windows.push(window);
  const unwrap = async <T,>(response: Promise<{ ok: boolean; result?: unknown; error?: unknown }>) => {
    const r = await response;
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.result as T;
  };
  store = new WorkspaceStore(
    (botId) => unwrap<ResultOf<"chat.snapshot">>(window.request({ type: "chat.snapshot", ...(botId ? { botId } : {}) } as Command)),
    (botId, before, untilId) => unwrap<ResultOf<"chat.history">>(window.request({ type: "chat.history", botId, before, ...(untilId ? { until: untilId } : {}) } as Command)),
  );
  return {
    window, store, received, injected, audit,
    link: () => window.linkForTests as FeLink,
    chat: (): MessageView[] => store.getView().chat?.messages ?? [],
    onFrame: (fn: typeof tap) => { tap = fn; },
  };
}

describe("backup / restore end to end (plain Node, no window, fake engine)", () => {
  it("backup, two more messages, restore: reset + snap with the restore time, floor unblocks, cmd.retry applies once, retired frames dropped, the window shows it", async () => {
    // ---- 1. Before the backup.
    let daemon = start();
    await daemon.ready();
    const originEpoch = "fedcba9876543210fedcba9876543210";
    const script = new ScriptClient("script", originEpoch);
    await script.connect(daemon.socket, daemon.token);
    await script.sub(script.srv);
    const srvSnap = await script.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === script.srv, "srv snap");
    const oldInc = srvSnap.logId;
    await script.sub(BOT);
    await script.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === BOT, "bot snap");
    const slot = (n: number): Slot => ({ origin: "script", originEpoch, target: BOT, n });
    script.cmd(slot(1), { type: "chat.send", botId: MAIN, text: "/say alpha" }, oldInc);
    expect((await script.wait(isResult(slot(1)), "slot 1")).outcome.kind).toBe("applied");
    await until(() => finishedWith(script.entriesOf(BOT), "alpha"), { timeout: 60_000, what: "alpha reply" });

    const w = openWindow();
    w.window.start();
    await w.window.ready();
    await w.store.resync();
    await w.window.request({ type: "chat.send", botId: MAIN, text: "/say wone" });
    await until(() => finishedWith(script.entriesOf(BOT), "wone"), { timeout: 60_000, what: "wone reply" });
    await until(() => w.chat().some((m) => m.role !== "user" && m.text.includes("wone")) || null, { timeout: 30_000, what: "window: wone reply" });
    await until(() => w.link().pending().every((item) => item.state === "delivered") || null, { what: "window: wone delivered" });

    // ---- 2. Backup while it runs; the daily backup ran by itself.
    await until(() => (existsSync(join(dataDir, "backups")) && readdirSync(join(dataDir, "backups")).some((name) => name.startsWith("server-daily-"))) || null, { timeout: 30_000, what: "a daily backup" });
    const beforeBackup = Date.now();
    const backup = await command(["backup"]);
    const afterBackup = Date.now();
    expect(backup.code, backup.stderr).toBe(0);
    const backupFile = backup.stdout.trim();
    const copy = openReaderDb(backupFile);
    let backupAt: number;
    let keptSeq: number;
    try {
      backupAt = Number(copy.prepare("SELECT value FROM meta WHERE key = 'backupAt'").get()?.value);
      keptSeq = Number(copy.prepare("SELECT head FROM streams WHERE stream = ?").get(BOT)?.head);
    } finally {
      copy.close();
    }
    expect(backupAt).toBeGreaterThanOrEqual(beforeBackup - 1);
    expect(backupAt).toBeLessThanOrEqual(afterBackup);
    expect(keptSeq).toBeGreaterThan(0);
    const status = JSON.parse((await command(["status", "--json"])).stdout) as { backup: { path: string; at: number } | null; notes: Array<{ id: string }> };
    expect(status.backup).not.toBeNull();
    expect(status.notes.map((note) => note.id)).not.toContain("no-backup");

    // ---- 3. Two more messages after the backup.
    script.cmd(slot(2), { type: "chat.send", botId: MAIN, text: "/say bravo" }, oldInc);
    expect((await script.wait(isResult(slot(2)), "slot 2")).outcome.kind).toBe("applied");
    await until(() => finishedWith(script.entriesOf(BOT), "bravo"), { timeout: 60_000, what: "bravo reply" });
    await w.window.request({ type: "chat.send", botId: MAIN, text: "/say wtwo" });
    await until(() => finishedWith(script.entriesOf(BOT), "wtwo"), { timeout: 60_000, what: "wtwo reply" });
    await until(() => w.chat().some((m) => m.role !== "user" && m.text.includes("wtwo")) || null, { timeout: 30_000, what: "window: wtwo reply" });
    await until(() => w.link().pending().every((item) => item.state === "delivered") || null, { what: "window: wtwo delivered" });
    const oldBotLogId = script.logIdOf(BOT)!;
    const entriesBefore = script.entriesOf(BOT);
    const scriptCursor = { logId: oldBotLogId, seq: entriesBefore[entriesBefore.length - 1].seq };
    const scriptSrvCursor = { logId: oldInc, seq: script.entriesOf(script.srv).at(-1)?.seq ?? srvSnap.seq };
    expect(scriptCursor.seq).toBeGreaterThan(keptSeq);
    // A batch of the old incarnation the window took after the backup (a late relay will hand it in again).
    const staleBatch = [...w.received].reverse().find((m): m is MessageOf<"batch"> => m.t === "batch" && m.stream === BOT && m.logId === oldBotLogId && m.to > keptSeq);
    expect(staleBatch).toBeDefined();
    script.close();

    // ---- 4. Restore: refused while running; --stop stops it first. The window writes while the server is down.
    const refused = await command(["restore", backupFile]);
    expect(refused.code).toBe(75);
    expect(refused.stderr).toMatch(/is running; stop it first/);
    const restore = await command(["restore", backupFile, "--stop"]);
    expect(restore.code, restore.stderr).toBe(0);
    expect(restore.stdout).toContain("stopped.");
    expect(restore.stdout).toContain(`taken ${new Date(backupAt).toISOString()}`);
    expect(await daemon.exited()).toBe(0);
    await until(() => w.link().status.state !== "live" || null, { what: "window: connecting" });
    await w.window.request({ type: "chat.send", botId: MAIN, text: "/say wthree" });
    const waiting = w.link().pending().filter((item) => item.state === "waiting");
    expect(waiting).toHaveLength(1);
    const windowSlot = waiting[0].slot;
    const restoredStatus = JSON.parse((await command(["status", "--json"])).stdout) as { running: boolean; notes: Array<{ id: string; text: string }> };
    expect(restoredStatus.running).toBe(false);
    expect(restoredStatus.notes.find((note) => note.id === "restored")?.text).toContain(new Date(backupAt).toISOString().replace(/\.\d+Z$/, "Z"));

    // Stale frames of the retired logId reach the window right after its bot reset and again after the new snap.
    let resetSeen = false;
    let newSnapSeen = false;
    w.onFrame((message, deliver) => {
      const staleResult = { t: "cmd.result", slot: windowSlot, outcome: { kind: "refused", reason: "invalid", detail: "a late result of the old incarnation" }, logId: oldBotLogId, seq: keptSeq + 1 } as Message;
      if (message.t === "reset" && message.stream === BOT && !resetSeen) { resetSeen = true; deliver(staleBatch!); deliver(staleResult); }
      if (message.t === "snap" && message.stream === BOT && message.logId !== oldBotLogId && resetSeen && !newSnapSeen) { newSnapSeen = true; deliver(staleBatch!); deliver(staleResult); }
    });

    // ---- 5. The next start.
    daemon = start();
    await daemon.ready();
    const again = new ScriptClient("script", originEpoch);
    await again.connect(daemon.socket, daemon.token);
    // A copy sent to the earlier incarnation (old inc), before this client has the srv: reset: cmd.retry, nothing stored.
    again.cmd(slot(3), { type: "chat.send", botId: MAIN, text: "/say charlie" }, oldInc, 3);
    const retry = await again.wait(isRetry(slot(3)), "cmd.retry");
    expect(retry.inc).not.toBe(oldInc);
    expect(again.received.some(isResult(slot(3)))).toBe(false);
    // Newer cursors → reset (with the restore time) + snap.
    await again.sub(again.srv, scriptSrvCursor);
    const srvReset = await again.wait((m): m is MessageOf<"reset"> => m.t === "reset" && m.stream === again.srv, "srv reset");
    expect(srvReset).toMatchObject({ logId: retry.inc, reason: "restored", restoredTo: backupAt });
    expect(srvReset.retired.map((old) => old.logId)).toContain(oldInc);
    await again.sub(BOT, scriptCursor);
    const botReset = await again.wait((m): m is MessageOf<"reset"> => m.t === "reset" && m.stream === BOT, "bot reset");
    expect(botReset).toMatchObject({ reason: "restored", restoredTo: backupAt });
    expect(botReset.logId).not.toBe(oldBotLogId);
    expect(botReset.retired).toContainEqual({ logId: oldBotLogId, keptSeq });
    const botSnap = await again.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === BOT, "bot snap");
    expect(botSnap.logId).toBe(botReset.logId);
    expect(botSnap.seq).toBeGreaterThanOrEqual(keptSeq); // the window, reattached first, may have written already
    expect(again.received.indexOf(botSnap)).toBeGreaterThan(again.received.indexOf(botReset));
    expect(again.received.some((m) => (m.t === "batch" || m.t === "snap") && (m as { logId: string }).logId === oldBotLogId)).toBe(false);

    // Re-sent with the new inc and floor 3: the forgotten slot 2 is skipped, slot 3 applies once.
    again.cmd(slot(3), { type: "chat.send", botId: MAIN, text: "/say charlie" }, retry.inc, 3);
    const applied = await again.wait(isResult(slot(3)), "slot 3 applied");
    expect(applied).toMatchObject({ outcome: { kind: "applied" }, logId: botReset.logId });
    const skipped = await until(() => again.entriesOf(BOT).find((entry) => entry.kind === "cmd.skipped" && (entry.body as { origin: string }).origin === "script") ?? null, { what: "cmd.skipped" });
    expect(skipped.body).toMatchObject({ originEpoch, target: BOT, from: 2, to: 2 });
    const sent = again.received.length;
    again.cmd(slot(3), { type: "chat.send", botId: MAIN, text: "/say charlie" }, retry.inc, 3);
    expect(await again.wait(isResult(slot(3)), "slot 3 stored outcome", { from: sent })).toMatchObject({ outcome: { kind: "applied" }, seq: applied.seq });
    const sent2 = again.received.length;
    again.cmd(slot(2), { type: "chat.send", botId: MAIN, text: "/say bravo" }, retry.inc, 2);
    expect((await again.wait(isResult(slot(2)), "slot 2 again", { from: sent2 })).outcome.kind).toBe("skipped");
    again.cmd(slot(4), { type: "chat.send", botId: MAIN, text: "/say delta" }, retry.inc, 4);
    expect((await again.wait(isResult(slot(4)), "slot 4")).outcome.kind).toBe("applied");
    await until(() => finishedWith(again.entriesOf(BOT), "delta"), { timeout: 60_000, what: "delta reply" });

    // The whole log of the new incarnation, read from server.db: the window reattaches by itself and may apply its line
    // (and the floor's skip) before this script's bot snap, which then holds them inside the snap, not in a batch.
    const logAfter = (): Entry[] => {
      const db = openReaderDb(join(dataDir, "server.db"));
      try {
        return readEntries(db, BOT, keptSeq + 1, { maxEntries: 10_000, maxBytes: Number.MAX_SAFE_INTEGER }).entries;
      } finally {
        db.close();
      }
    };
    // The window reattached by itself: its waiting line applied exactly once; the stale frames were dropped.
    await until(() => (resetSeen && newSnapSeen) || null, { timeout: 30_000, what: "window: reset and new snap" });
    await until(() => w.link().pending().every((item) => item.state !== "waiting" && item.state !== "held") || null, { timeout: 30_000, what: "window: nothing waiting" });
    await until(() => finishedWith(logAfter(), "wthree"), { timeout: 60_000, what: "wthree reply" });
    expect(w.injected.map((m) => m.t)).toEqual(["batch", "cmd.result", "batch", "cmd.result"]);
    expect(w.received.some(isRetry(windowSlot))).toBe(true);
    const scriptSeen = again.entriesOf(BOT);
    const entriesAfter = logAfter();
    expect(entriesAfter.every((entry) => entry.logId === botReset.logId)).toBe(true);
    // What the script took from its snap on is the same log: no entry it holds differs from server.db.
    for (const entry of scriptSeen) expect(entriesAfter.find((e) => e.seq === entry.seq)?.hash).toBe(entry.hash);
    const windowResults = w.received.filter(isResult(windowSlot));
    expect(windowResults.length).toBeGreaterThan(0);
    expect(windowResults.every((m) => m.logId === botReset.logId && m.outcome.kind === "applied")).toBe(true);
    // The window's floor skipped its own lost second slot.
    expect(entriesAfter.some((e) => e.kind === "cmd.skipped" && (e.body as { origin: string }).origin === "desktop")).toBe(true);
    expect(userLines(entriesAfter, "wthree")).toHaveLength(1);
    expect(userLines(entriesAfter, "charlie")).toHaveLength(1);
    expect(userLines(entriesAfter, "bravo")).toHaveLength(0); // gone with the restore, never applied again
    expect(w.link().status).toMatchObject({ state: "history restored", restoredTo: backupAt });
    const link = w.link();
    expect(link.cursor(BOT)?.logId).toBe(botReset.logId);

    // The renderer: "restored to <time>", the lines after the backup gone, the waiting line delivered, nothing stuck.
    await w.store.resync();
    const chat = await until(() => {
      const lines = w.chat();
      return lines.some((m) => m.role === "user" && m.text.includes("wthree")) && lines.some((m) => m.id === NOTICE_ID) ? lines : null;
    }, { timeout: 30_000, what: "window: restored chat" });
    const notice = chat.find((m) => m.id === NOTICE_ID)!;
    expect(notice.text).toContain(`history was restored to ${localStamp(backupAt)}`);
    expect(chat.filter((m) => m.role === "user" && m.text.includes("wthree"))).toHaveLength(1);
    expect(chat.some((m) => m.text.includes("bravo"))).toBe(false);
    expect(chat.some((m) => m.text.includes("wtwo") && !/lost when this machine's history was restored/.test(m.text))).toBe(false);
    expect(chat.some((m) => m.role === "user" && m.text.includes("wone"))).toBe(true);
    expect(chat.some((m) => /^Not sent/.test(m.text))).toBe(false);
    expect(link.pending().filter((item) => item.state === "waiting" || item.state === "held")).toEqual([]);

    // The next send clears the notice; the server stays healthy.
    await w.window.request({ type: "chat.send", botId: MAIN, text: "/say wfour" });
    await until(() => (w.link().status.state === "live" && !w.chat().some((m) => m.id === NOTICE_ID)) || null, { timeout: 30_000, what: "window: notice cleared" });
    await until(() => w.link().pending().every((item) => item.state === "delivered") || null, { timeout: 30_000, what: "window: wfour delivered" });
    expect(daemon.log).toMatch(/audit: \{"kind":"skipped"/);
    expect(daemon.log).toMatch(/note \(restored\)/);
    again.close();
    await w.window.stop();
    expect(await daemon.stop()).toBe(0);
  }, 300_000);
});
