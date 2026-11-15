// M5-02b review probes: the fence words cannot survive in a run of 4+ `>`/`<`; a failure reason and the guest's name
// stay within the schema's UTF-16 bounds when their user-perceived characters are many units each (emoji, combining
// marks), so the reply and its short fallback always parse. Plus tests for three guards the card's tests left
// unpinned (mutation check): a cancel heard before the runner took its row, a turn that answers after the cancel, and a
// runner that throws.
import { afterEach, describe, expect, it } from "vitest";
import { Command, type Command as CommandType } from "../../src/contract";
import type { Slot, Target } from "../../src/protocol";
import { cleanLine, cutUnits, guestPrompt, type CallInGuestSender } from "../../src/server/callin";
import { callInEffectId } from "../../src/server/effects";
import { effectRows, harness, type Harness } from "./server-intents-harness";

const GUEST = "GUEST";
const HOST = "6A0B0000-0000-4000-8000-000000000003";
const CALL = "6A0B0000-0000-4000-8000-0000000000C1";
const ORIGIN = "srv-host";
const HOST_TARGET = `bot:${HOST}` as Target;
const FAMILY = "👨‍👩‍👧‍👦"; // one character, 11 UTF-16 units (the fence-run tests use WIDE: one code point per character keeps the counts simple)
const WIDE = "😀"; // one character, 2 UTF-16 units
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const ask: CommandType = {
  type: "callin.ask", botId: GUEST, callId: CALL, host: { server: ORIGIN, botId: HOST, name: "build" },
  transcript: "User (newest): @g hi", asked: "@g hi", by: "user", depth: 1,
};

/** Parses like `ServerOrigin.submitIn` (it throws on a command the schema refuses) and records what would be sent once its transaction committed. */
function parsingSender() {
  const sent: Extract<CommandType, { type: "callin.reply" }>[] = [];
  const sender: CallInGuestSender = {
    ownerOf: (target) => (target === HOST_TARGET ? ORIGIN : null),
    async submit(target, cmd) {
      sent.push(Command.parse(cmd) as (typeof sent)[number]);
      return { origin: "srv-b", originEpoch: "f".repeat(32), target, n: sent.length } as Slot;
    },
    submitIn(_tx, target, cmd) {
      const parsed = Command.parse(cmd) as (typeof sent)[number];
      return { slot: { origin: "srv-b", originEpoch: "f".repeat(32), target, n: sent.length + 1 } as Slot, done: () => { sent.push(parsed); } };
    },
  };
  return { sender, sent };
}

const open: Harness[] = [];
afterEach(() => { for (const h of open.splice(0)) h.close(); });
async function start() {
  const h = await harness({ bots: ["MAIN", GUEST] });
  open.push(h);
  const s = parsingSender();
  h.runtime.callIns.attach(s.sender);
  return { h, sent: s.sent };
}

describe("M5-02b review: fence runs", () => {
  it("no run of > or < longer than two survives cleanLine, whatever its length", () => {
    for (let n = 3; n <= 12; n += 1) {
      for (const ch of [">", "<"]) {
        const out = cleanLine(`a${ch.repeat(n)}b`, 1_000);
        expect(out, `${n} × ${ch}`).not.toContain(ch.repeat(3));
      }
    }
    const prompt = guestPrompt({ hostName: "h", guestName: "g", by: "bot", transcript: "Notice: >>>>>\n<<<<<", asked: ">>>>>>>>" });
    expect(prompt.match(/>>>/g)).toHaveLength(2); // the two fences' closing lines, nothing from the peer
    expect(prompt.match(/<<</g)).toHaveLength(2);
  });
});

describe("M5-02b review: UTF-16 bounds of the reply", () => {
  it("cutUnits cuts at a code point boundary within the bound", () => {
    expect(cutUnits("short", 10)).toBe("short");
    for (const fill of [FAMILY, "😀", "é"]) {
      const cut = cutUnits(fill.repeat(500), 1_000);
      expect(cut.length).toBeLessThanOrEqual(1_000);
      expect(cut.length).toBeGreaterThan(1_000 - 11);
      expect(LONE.test(cut)).toBe(false);
    }
  });

  it("a failure reason of many-unit characters is cut to 1,000 UTF-16 units and still goes back as itself", async () => {
    const { h, sent } = await start();
    h.engine.callInTurn = async () => ({ kind: "failed", why: WIDE.repeat(900) });
    await h.send(ask, { origin: ORIGIN });
    await h.settle();
    expect(sent).toHaveLength(1);
    const outcome = sent[0]!.outcome;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.why.length).toBeLessThanOrEqual(1_000);
      expect(outcome.why.startsWith(WIDE)).toBe(true);
      expect(LONE.test(outcome.why)).toBe(false);
      expect(outcome.why).not.toBe("its answer could not be sent");
    }
  });

  it("a guest name of many-unit characters is cut to 200 UTF-16 units, so the reply parses", async () => {
    const { h, sent } = await start();
    const view = h.engine.botView.bind(h.engine);
    h.engine.botView = (botId: string) => { const v = view(botId); return v && botId === GUEST ? { ...v, name: WIDE.repeat(150) } : v; };
    await h.send(ask, { origin: ORIGIN });
    await h.settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.guest.name.length).toBeLessThanOrEqual(200);
    expect(sent[0]!.guest.name).toBe(WIDE.repeat(100));
    expect(sent[0]!.outcome).toEqual({ kind: "reply", text: "All green.", engine: "claude" });
  });
});

describe("M5-02b review: cancel and runner guards", () => {
  it("a cancel heard after the ask committed but before the runner made its controller: no turn, one failed \"cancelled\"", async () => {
    const { h, sent } = await start();
    // The runner has no controller for the row yet (the harness's send already lets the worker take it, so the cancel
    // is heard first here; in the server it is callInCancel's afterCommit landing between the take and run()).
    h.runtime.callIns.cancel(callInEffectId(ORIGIN, GUEST, CALL));
    await h.send(ask, { origin: ORIGIN });
    await h.settle();
    expect(h.engine.callIns).toHaveLength(0);
    expect(sent.map((reply) => reply.outcome)).toEqual([{ kind: "failed", why: "cancelled" }]);
  });

  it("a turn that still hands over a reply after the cancel answers \"cancelled\", not the reply (D51)", async () => {
    const { h, sent } = await start();
    let began = false;
    h.engine.callInTurn = (_guest, _prompt, _begin, options) => new Promise((resolve) => {
      began = true;
      options.signal.addEventListener("abort", () => resolve({ kind: "reply", text: "too late", engine: "claude" }), { once: true });
    });
    await h.send(ask, { origin: ORIGIN });
    for (let i = 0; i < 200 && !began; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(began).toBe(true);
    await h.send({ type: "callin.cancel", botId: GUEST, callId: CALL }, { origin: ORIGIN });
    await h.settle();
    expect(sent.map((reply) => reply.outcome)).toEqual([{ kind: "failed", why: "cancelled" }]);
  });

  it("a runner that throws leaves its row interrupted, never started for good", async () => {
    const { h, sent } = await start();
    h.runtime.callIns.run = async () => { throw new Error("runner broke"); };
    await h.send(ask, { origin: ORIGIN });
    await h.settle();
    expect(sent).toHaveLength(0);
    expect(effectRows(h.db).filter((row) => row.kind === "callin")).toMatchObject([{ state: "interrupted" }]);
  });
});
