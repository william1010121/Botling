// Slot admission hardening (Botling 3, from the M5-19 review "I1" and the M5-04d review "U1"):
// 1. The accepting server states the scope; a caller that does not is refused (fail closed), and the frame's own
//    `body.scope` ("local" / "admin" on the wire) is never trusted in its place.
// 2. A legacy command whose target is not its own is refused at admission, before its handler runs.
// Real server.db (in memory), real log, slot engine and legacy apply; a fake engine whose `runs` shows what ran.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, Scope } from "../../src/protocol";
import { entriesOf, harness, kinds, outcomeOf, type Harness } from "./server-intents-harness";
import { EPOCH_A } from "./server-slots-harness";

let open: Harness[] = [];
async function start(): Promise<Harness> {
  const h = await harness();
  open.push(h);
  return h;
}
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

const B1 = "bot:B1";
const MAIN = "bot:MAIN";

/** A command body the way a peer or window frames it; `wire` is what the frame itself claims as scope. */
function bodyOf(h: Harness, cmd: Command, over: { target?: string; n?: number; wire?: Scope } = {}): CmdBody {
  const botId = (cmd as { botId?: string }).botId;
  const target = over.target ?? (botId ? `bot:${botId}` : h.serverStream);
  return {
    slot: { origin: "desktop", originEpoch: EPOCH_A, target, n: over.n ?? 1 }, floor: 1, inc: h.inc, cmd,
    ...(over.wire ? { scope: over.wire } : {}),
  } as CmdBody;
}

const legacyRead = { type: "chat.read", botId: "B1" } as Command; // legacy route, scope read
const intentSend = { type: "chat.send", botId: "B1", text: "hi" } as Command; // intent route, scope reply
const readsOnly = (h: Harness) => h.engine.runs.filter((cmd) => cmd.type === "chat.read");

describe("scope is stated by the caller (M5-19 I1)", () => {
  it("a legacy command received without a stated scope is refused; the frame's body.scope local is ignored", async () => {
    const h = await start();
    for (const wire of ["local", "admin"] as const) {
      const body = bodyOf(h, legacyRead, { wire });
      await expect(h.runtime.receive(body, { reply: () => undefined } as never)).rejects.toThrow("scope");
      await expect(h.runtime.legacy.receive(body, {} as never)).rejects.toThrow("scope");
      await expect(h.runtime.legacy.receive(body, undefined as never)).rejects.toThrow("scope");
    }
    await h.settle();
    expect(readsOnly(h)).toHaveLength(0); // the handler never ran
    expect(kinds(h.db, B1)).toEqual([]); // nothing stored: no receipt, no refusal
    expect(Number(h.db.prepare("SELECT COUNT(*) AS c FROM receipts").get()!.c)).toBe(0);
  });

  it("an intent command received without a stated scope is refused; the frame's body.scope local is ignored", async () => {
    const h = await start();
    const body = bodyOf(h, intentSend, { wire: "local" });
    await expect(h.runtime.receive(body, {} as never)).rejects.toThrow("scope");
    await expect(h.runtime.slots.receive(body, {} as never)).rejects.toThrow("scope");
    await expect(h.runtime.slots.receive(body, undefined as never)).rejects.toThrow("scope");
    await h.settle();
    expect(kinds(h.db, B1)).toEqual([]);
    expect(h.engine.spawns).toEqual([]);
  });

  it("a stated scope that is not a scope at all is refused too", async () => {
    const h = await start();
    await expect(h.runtime.legacy.receive(bodyOf(h, legacyRead, { wire: "local" }), { scope: "" } as never)).rejects.toThrow("scope");
    await expect(h.runtime.slots.receive(bodyOf(h, intentSend, { wire: "local" }), { scope: "root" } as never)).rejects.toThrow("scope");
    expect(readsOnly(h)).toHaveLength(0);
  });

  it("the stated scope decides, whatever the frame claims (legacy and intent)", async () => {
    const h = await start();
    // This server serves only its own window (M1 table): a stated `read` is refused although the frame says `local`.
    const legacy = await h.runtime.receive(bodyOf(h, legacyRead, { wire: "local" }), { scope: "read" });
    expect(outcomeOf(legacy)).toMatchObject({ kind: "refused", reason: "scope" });
    const intent = await h.runtime.receive(bodyOf(h, intentSend, { wire: "admin" }), { scope: "read" });
    expect(outcomeOf(intent)).toMatchObject({ kind: "refused", reason: "scope" });
    await h.settle();
    expect(readsOnly(h)).toHaveLength(0);
    expect(h.engine.spawns).toEqual([]);
    // The same frames with a stated `local` are applied: the stated value, not the frame, is what counts.
    const ok = await h.runtime.receive(bodyOf(h, legacyRead, { n: 2 }), { scope: "local" });
    expect(outcomeOf(ok)).toMatchObject({ kind: "applied" });
    expect(readsOnly(h)).toHaveLength(1);
  });
});

describe("legacy target check before the handler (M5-04d U1)", () => {
  it("a bot command sent to another bot's stream is refused without running its handler", async () => {
    const h = await start();
    const run = vi.spyOn(h.engine, "run");
    const status = await h.send(legacyRead, { target: MAIN, n: 1 });
    expect(outcomeOf(status)).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(run).not.toHaveBeenCalled();
    expect(h.engine.runs).toHaveLength(0);
    // The slot is decided as usual: a refusal receipt on the stream the sender named, nothing in the other bot's.
    expect(kinds(h.db, "bot:MAIN")).toEqual(["cmd.refused"]);
    expect(kinds(h.db, B1)).toEqual([]);
    expect(entriesOf(h.db, MAIN)[0].body).toMatchObject({ reason: "invalid" });
  });

  it("a bot command sent to the server stream, and a server command sent to a bot stream, are refused unrun", async () => {
    const h = await start();
    const run = vi.spyOn(h.engine, "run");
    const toServer = await h.send(legacyRead, { target: h.serverStream, n: 1 });
    expect(outcomeOf(toServer)).toMatchObject({ kind: "refused", reason: "invalid" });
    const serverCmd = { type: "plugins.enable", name: "probe.tool", enabled: true } as Command;
    const toBot = await h.send(serverCmd, { target: B1, n: 1 });
    expect(outcomeOf(toBot)).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(run).not.toHaveBeenCalled();
  });

  it("a re-sent copy gets the stored refusal, the next slot of that queue still runs, and the handler ran only for it", async () => {
    const h = await start();
    const run = vi.spyOn(h.engine, "run");
    await h.send(legacyRead, { target: MAIN, n: 1 });
    const again = await h.send(legacyRead, { target: MAIN, n: 1 });
    expect(outcomeOf(again)).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(run).not.toHaveBeenCalled();
    // Slot 2 of the same queue is a command that belongs there: it is admitted and runs (the refusal did not block the queue).
    const own = await h.send({ type: "chat.read", botId: "MAIN" } as Command, { target: MAIN, n: 2 });
    expect(outcomeOf(own)).toMatchObject({ kind: "applied" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.engine.runs[0]).toMatchObject({ type: "chat.read", botId: "MAIN" });
  });

  it("a command on its own target still runs its handler once (2.x behaviour)", async () => {
    const h = await start();
    const own = await h.send(legacyRead, { n: 1 });
    expect(outcomeOf(own)).toMatchObject({ kind: "applied", result: {} });
    const server = await h.send({ type: "plugins.enable", name: "probe.tool", enabled: true } as Command, { n: 1 });
    expect(outcomeOf(server)).toMatchObject({ kind: "applied" });
    expect(h.engine.runs.map((cmd) => cmd.type)).toEqual(["chat.read", "plugins.enable"]);
  });

  it("a refusal for the scope still comes first and the handler does not run (order unchanged)", async () => {
    const h = await start();
    const status = await h.runtime.receive(bodyOf(h, legacyRead, { target: MAIN }), { scope: "read" });
    expect(outcomeOf(status)).toMatchObject({ kind: "refused", reason: "scope" });
    expect(h.engine.runs).toHaveLength(0);
  });
});
