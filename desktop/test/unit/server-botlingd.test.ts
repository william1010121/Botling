// botlingd end to end under plain Node, no window (M1 step 9). The built server (out/server/main.cjs) runs the 2.x core
// with the fake engine on a temp data folder; a scripted front end talks to it over the Unix socket:
// - hello with the local token → welcome; a wrong token → bye{token}; the socket and token are 0600;
// - the srv: stream's snap gives the inc; chat.send → cmd.result{applied} and the bot stream's entries (the user's line
//   carrying its slot, the turn, the reply);
// - a finished line naming a local picture gets a content reference, and content.open answers it (step 13 wired);
// - req answers read commands (chat.snapshot in the 2.x shape, plugins.loaded: plugins loaded in the Node host) and
//   refuses mutating ones; status shows the server; backup writes a copy; a second start is refused by the lock;
// - restart: the client resumes from its cursor with no entry twice and none missing; a re-sent slot gets its stored
//   outcome; a new slot is applied;
// - the main-v3 server client (Botling 3 window's main, headless) connects to the real botlingd and gets a chat.snapshot.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryFeStorage } from "../../src/fe-link";
import { ServerClient } from "../../src/main-v3/server-client";
import type { Entry, Message, MessageOf, Slot } from "../../src/protocol";
import { BotlingdProcess, botlingdCommand, mainBotOf, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";

const root = testRoot("botlingd");
const dataDir = join(root, "data");
const files = join(root, "files");
const running: BotlingdProcess[] = [];
/** The main bot this data folder minted on its first start (M5-04g). */
let MAIN = "";
afterAll(async () => {
  for (const daemon of running) await daemon.stop("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

function start(): BotlingdProcess {
  const daemon = new BotlingdProcess(dataDir);
  running.push(daemon);
  return daemon;
}

const kinds = (entries: Entry[]) => entries.map((entry) => entry.kind);
const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

describe("botlingd (plain Node, no window, fake engine)", () => {
  let cursor: { logId: string; seq: number } | null = null;
  let before: Entry[] = [];
  let firstResultSeq = 0;
  const originEpoch = "0123456789abcdef0123456789abcdef";
  const picture = join(files, "picture.png");

  it("serves a scripted front end: hello, srv: snap, chat.send → cmd.result and entries, content, reads", async () => {
    mkdirSync(files, { recursive: true });
    writeFileSync(picture, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const daemon = start();
    await daemon.ready();
    MAIN = mainBotOf(dataDir);
    expect(statSync(daemon.socket).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "botlingd.token")).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);

    // A wrong token: bye{token}.
    const stranger = new ScriptClient("stranger");
    await expect(stranger.connect(daemon.socket, "x".repeat(32))).rejects.toThrow(/closed/);
    expect(stranger.received).toEqual([expect.objectContaining({ t: "bye", reason: "token" })]);

    const client = new ScriptClient("script", originEpoch);
    const welcome = await client.connect(daemon.socket, daemon.token);
    expect(welcome).toMatchObject({ protocol: { min: 1, max: 1 }, servers: [expect.objectContaining({ state: "live" })] });
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    expect((srvSnap.view as { bots: string[] }).bots).toContain(MAIN);
    const inc = srvSnap.logId;
    await client.sub(`bot:${MAIN}`);
    await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `bot:${MAIN}`, "bot snap");

    const slot: Slot = { origin: "script", originEpoch, target: `bot:${MAIN}`, n: 1 };
    const text = `/say Here it is: ![picture](${pathToFileURL(picture).href})`;
    client.cmd(slot, { type: "chat.send", botId: MAIN, text }, inc);
    const result = await client.wait(isResult(slot), "cmd.result");
    expect(result.outcome.kind).toBe("applied");
    firstResultSeq = result.seq!;
    const finished = await until(() => client.entriesOf(`bot:${MAIN}`).find((entry) => entry.kind === "turn.finished") ?? null, { timeout: 60_000, what: "turn.finished" });
    const entries = client.entriesOf(`bot:${MAIN}`);
    const userLine = entries.find((entry) => entry.kind === "message.added" && (entry.body as { message: { role: string } }).message.role === "user");
    expect(userLine?.slot).toEqual(slot);
    expect(kinds(entries)).toEqual(expect.arrayContaining(["message.added", "turn.queued", "turn.started", "cmd.applied", "turn.finished"]));
    const replyId = (finished.body as { messageId: string }).messageId;
    expect((finished.body as { text: string }).text).toContain("Here it is");

    // Step 13 through the real botlingd: the reply names a local picture → a reference; content.open answers it.
    const url = pathToFileURL(picture).href;
    const found = await until(async () => {
      const answer = await client.content({ t: "content.find", botId: MAIN, line: replyId, url });
      return answer.t === "content.found" && answer.ref ? answer : null;
    }, { timeout: 30_000, what: "content reference" }) as MessageOf<"content.found">;
    const ref = found.ref!;
    const file = await client.content({ t: "content.open", owner: ref.owner, id: ref.id, variant: "original", entry: ref.entry });
    expect(file).toMatchObject({ t: "content.file", id: ref.id, type: "image/png" });
    expect(existsSync((file as MessageOf<"content.file">).path)).toBe(true);
    const denied = await client.content({ t: "content.open", owner: ref.owner, id: ref.id, variant: "original", entry: { stream: client.srv, seq: 1 } });
    expect(denied).toMatchObject({ t: "content.gone", reason: "denied" });

    // Reads: chat.snapshot in the 2.x shape; plugins loaded through the Node plugin host; a mutating req is refused.
    const snapshot = await client.req({ type: "chat.snapshot", botId: MAIN });
    expect(snapshot.ok).toBe(true);
    const chat = (snapshot as { result: { chat: { messages: Array<{ id: string; text: string }> } } }).result.chat;
    expect(chat.messages.some((message) => message.id === replyId && message.text.includes("Here it is"))).toBe(true);
    expect((snapshot as { result: Record<string, unknown> }).result).toHaveProperty("bots");
    const plugins = await client.req({ type: "plugins.list" });
    expect(plugins.ok).toBe(true);
    expect(JSON.stringify((plugins as { result: unknown }).result)).toContain("botling.routines");
    await until(() => /plugin host: loaded in \d+ ms; per plugin \{"botling\./.test(daemon.log) || null, { timeout: 30_000, what: "plugins loaded in the Node host" });
    const refused = await client.req({ type: "chat.send", botId: MAIN, text: "no" });
    expect(refused).toMatchObject({ ok: false, error: { code: "bad_request" } });

    // CLI while it runs: status, backup; a second start is refused by the data-folder lock.
    const status = botlingdCommand(dataDir, ["status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true, pid: daemon.child.pid, answers: true });
    const backup = botlingdCommand(dataDir, ["backup"]);
    expect(backup.code).toBe(0);
    expect(existsSync(backup.stdout.trim())).toBe(true);
    const second = botlingdCommand(dataDir, ["start"]);
    expect(second.code).toBe(75);
    expect(second.stderr).toMatch(/already uses/);

    // The cursor this front end keeps: halfway, at the slot's outcome.
    before = client.entriesOf(`bot:${MAIN}`);
    cursor = { logId: before[0].logId, seq: firstResultSeq };
    client.close();
    expect(daemon.log).not.toMatch(/cannot send/);
    expect(await daemon.stop()).toBe(0);
    expect(existsSync(daemon.socket)).toBe(false);
  }, 180_000);

  it("after a restart the front end resumes from its cursor: no entry twice, none missing", async () => {
    expect(cursor).not.toBeNull();
    const daemon = start();
    await daemon.ready();
    const client = new ScriptClient("script", originEpoch);
    await client.connect(daemon.socket, daemon.token);
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    await client.sub(`bot:${MAIN}`, cursor);
    const head = before[before.length - 1].seq;
    await until(() => client.entriesOf(`bot:${MAIN}`).some((entry) => entry.seq >= head) || null, { what: "catch-up to the old head" });
    // No snap and no reset: the cursor was good.
    expect(client.received.some((m) => (m.t === "snap" || m.t === "reset") && (m as { stream: string }).stream === `bot:${MAIN}`)).toBe(false);
    const batches = client.received.filter((m): m is MessageOf<"batch"> => m.t === "batch" && m.stream === `bot:${MAIN}`);
    const seqs = batches.flatMap((batch) => batch.entries.map((entry) => entry.seq));
    expect(seqs[0]).toBe(cursor!.seq + 1);
    expect(new Set(seqs).size).toBe(seqs.length); // none twice
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => cursor!.seq + 1 + i)); // none missing
    for (const entry of before.filter((e) => e.seq > cursor!.seq)) expect(client.entriesOf(`bot:${MAIN}`).find((e) => e.seq === entry.seq)?.hash).toBe(entry.hash);

    // The slot sent before the restart, sent again: its stored outcome. A new slot: applied.
    const inc = srvSnap.logId;
    const old: Slot = { origin: "script", originEpoch, target: `bot:${MAIN}`, n: 1 };
    client.cmd(old, { type: "chat.send", botId: MAIN, text: `/say Here it is: ![picture](${pathToFileURL(picture).href})` }, inc);
    const again = await client.wait(isResult(old), "stored outcome");
    expect(again).toMatchObject({ outcome: { kind: "applied" }, seq: firstResultSeq });
    const next: Slot = { ...old, n: 2 };
    client.cmd(next, { type: "chat.send", botId: MAIN, text: "/say again" }, inc);
    expect((await client.wait(isResult(next), "second result")).outcome.kind).toBe("applied");
    const second = await until(() => client.entriesOf(`bot:${MAIN}`).find((entry) => entry.kind === "turn.finished" && entry.seq > head) ?? null, { timeout: 60_000, what: "second turn" });
    expect((second.body as { text: string }).text).toContain("again");
    client.close();

    // Botling 3's window main, headless: the server client attaches to this botlingd and reads a chat.snapshot.
    const appData = join(root, "app");
    mkdirSync(appData, { recursive: true });
    const audit: string[] = [];
    const window = new ServerClient(
      { script: join(desktop, "out", "core", "main.cjs"), env: { BOTLING_APP_DATA_DIR: appData, BOTLING_SERVER_DATA_DIR: dataDir }, onEvent: () => undefined, audit: (line) => audit.push(line) },
      { storage: () => new MemoryFeStorage(), launch: () => { throw new Error("botlingd is running: no launch expected"); } },
    );
    try {
      window.start();
      await window.ready();
      const response = await window.request({ type: "chat.snapshot", botId: MAIN });
      expect(response, audit.join("\n")).toMatchObject({ ok: true });
      const shown = (response as { result: { chat: { messages: Array<{ text: string }> } } }).result.chat.messages.map((message) => message.text);
      expect(shown.some((line) => line.includes("Here it is"))).toBe(true);
    } finally {
      await window.stop();
    }
    expect(daemon.log).not.toMatch(/cannot send/);
    expect(await daemon.stop()).toBe(0);
    // Nothing of the data folder is left locked; the backups folder holds the CLI's copy.
    expect(readdirSync(join(dataDir, "backups")).some((name) => name.startsWith("server-manual-"))).toBe(true);
  }, 180_000);
});
