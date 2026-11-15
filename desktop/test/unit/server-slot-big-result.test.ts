// A command whose result is too large for one log entry (the Botling 3 "panes hang after import" bug, 2026-11-15, and
// its follow-up N2 in v3-panel-frame-review.md).
//
// After a 2.x import with 22 plugins the window sent `plugins.panel` as a slot; its result (the panel's source) did not
// fit one frame, so `cmd.applied` could not be stored, the store threw, the session ended with `bye{unsettled}`, and the
// front end re-sent the same slot on its next session, forever. The first fix settled such a slot as `refused{invalid}`.
// That is wrong for a command whose handler already ran (`plugins.call`: the plugin's method and its side effects): the
// caller was told "not sent" for a call that ran. Now the owner keeps the result beside the receipt (`slot_results`), the
// slot settles `applied` with a small marker (`resultKept`), and the front end fetches the result with a `slot.result`
// req, whose answer may be large (`res.part`s). A result too large even for that is still `applied`, marked not kept.
// Real server.db (in memory), real log, slot engine and legacy apply; a fake engine whose `run` answers a big result.
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import { KeptResultMarker, type CmdBody, type Slot } from "../../src/protocol";
import { ENTRY_BYTES_LIMIT } from "../../src/server/log";
import { KEPT_RESULT_MAX_BYTES, keepResult, keptResult } from "../../src/server/slots";
import { entriesOf, harness, outcomeOf, type Harness } from "./server-intents-harness";
import { EPOCH_A } from "./server-slots-harness";

let open: Harness[] = [];
async function start(result: (cmd: Command) => unknown): Promise<Harness> {
  const h = await harness();
  open.push(h);
  const run = h.engine.run.bind(h.engine);
  h.engine.run = async (cmd: Command) => {
    if (cmd.type !== "plugins.call") return run(cmd);
    h.engine.runs.push(cmd);
    return result(cmd);
  };
  return h;
}
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

const slotOf = (h: Harness, n: number): Slot => ({ origin: "desktop", originEpoch: EPOCH_A, target: h.serverStream, n } as Slot);
function send(h: Harness, cmd: Command, n = 1) {
  const body = { slot: slotOf(h, n), floor: 1, inc: h.inc, cmd } as CmdBody;
  return h.runtime.legacy.receive(body, { scope: "local" });
}

const call = { type: "plugins.call", name: "note", method: "load", params: {}, from: "frame" } as Command;
/** A plugin's answer with CJK text and newlines, so its JSON-escaped UTF-8 is far larger than its length (L-005). */
const bigAnswer = () => ({ result: { doc: "筆記\n\"pane\"\t".repeat(Math.ceil(ENTRY_BYTES_LIMIT / 8)) } });
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("a slot whose result does not fit one entry", () => {
  it("settles applied (the handler ran) with a small marker; the owner keeps the whole result for the caller", async () => {
    const h = await start(bigAnswer);
    const status = await send(h, call);
    const outcome = outcomeOf(status);
    expect(outcome.kind).toBe("applied");
    expect(KeptResultMarker.parse(outcome.result)).toEqual({ resultKept: { bytes: bytesOf(bigAnswer()), kept: true } });
    // The log keeps only the marker; the giant result is in slot_results, nowhere else.
    const last = entriesOf(h.db, h.serverStream).at(-1)!;
    expect(last.kind).toBe("cmd.applied");
    expect(JSON.stringify(last.body).length).toBeLessThan(4_000);
    expect(await h.runtime.keptResult(slotOf(h, 1))).toEqual({ found: true, result: bigAnswer() });
  });

  it("a re-sent copy gets the same marker (the handler does not run again) and the next slot of the queue applies", async () => {
    const h = await start(bigAnswer);
    const first = outcomeOf(await send(h, call, 1));
    const again = outcomeOf(await send(h, call, 1));
    expect(again).toEqual(first);
    expect(h.engine.runs.filter((cmd) => cmd.type === "plugins.call")).toHaveLength(1);
    const next = await send(h, { type: "plugins.list" } as Command, 2);
    expect(outcomeOf(next)).toMatchObject({ kind: "applied" });
  });

  it("a result just under the limit is still stored whole in the entry (the marker only takes what cannot fit)", async () => {
    const h = await start(() => ({ result: { doc: "x".repeat(ENTRY_BYTES_LIMIT - 4_096) } }));
    const status = await send(h, call);
    expect(outcomeOf(status)).toMatchObject({ kind: "applied", result: { result: { doc: expect.any(String) } } });
    expect(KeptResultMarker.safeParse(outcomeOf(status).result).success).toBe(false);
    expect(entriesOf(h.db, h.serverStream).at(-1)!.kind).toBe("cmd.applied");
    expect(await h.runtime.keptResult(slotOf(h, 1))).toEqual({ found: false });
  });

  it("a result too large even to keep is still applied (never refused: it ran), marked not kept", async () => {
    const huge = { result: { doc: "y".repeat(KEPT_RESULT_MAX_BYTES + 10) } };
    const h = await start(() => huge);
    const outcome = outcomeOf(await send(h, call));
    expect(outcome.kind).toBe("applied");
    expect(KeptResultMarker.parse(outcome.result)).toEqual({ resultKept: { bytes: bytesOf(huge), kept: false } });
    expect(await h.runtime.keptResult(slotOf(h, 1))).toEqual({ found: false });
  });

  it("only the newest kept results stay (row and byte caps), oldest first out", async () => {
    const h = await start(() => null);
    const kept = (n: number) => h.writer.submit((tx) => keptResult(tx, slotOf(h, n)).found);
    const limits = { rows: 3, bytes: 10_000 };
    for (let n = 1; n <= 4; n += 1) await h.writer.submit((tx) => keepResult(tx, slotOf(h, n), { n, pad: "z".repeat(1_000) }, limits));
    expect(await Promise.all([1, 2, 3, 4].map(kept))).toEqual([false, true, true, true]);
    await h.writer.submit((tx) => keepResult(tx, slotOf(h, 5), { pad: "z".repeat(8_500) }, limits));
    expect(await Promise.all([2, 3, 4, 5].map(kept))).toEqual([false, false, true, true]);
  });
});
