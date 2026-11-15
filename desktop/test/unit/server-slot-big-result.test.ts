// A command whose result is too large for one log entry (the Botling 3 "panes hang after import" bug, 2026-11-15).
//
// After a 2.x import with 22 plugins the window sent `plugins.panel` as a slot; its result (the panel's source) did not
// fit one frame, so `cmd.applied` could not be stored, the store threw, the session ended with `bye{unsettled}`, and the
// front end re-sent the same slot on its next session, forever (every ~0.5 s): every plugin pane waited behind it.
// The owner now settles such a slot with a refusal that says why (nothing else is stored), so the queue moves on.
// Real server.db (in memory), real log, slot engine and legacy apply; a fake engine whose `run` answers a big result.
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody } from "../../src/protocol";
import { ENTRY_BYTES_LIMIT } from "../../src/server/log";
import { entriesOf, harness, outcomeOf, type Harness } from "./server-intents-harness";
import { EPOCH_A } from "./server-slots-harness";

let open: Harness[] = [];
async function start(result: (cmd: Command) => unknown): Promise<Harness> {
  const h = await harness();
  open.push(h);
  const run = h.engine.run.bind(h.engine);
  h.engine.run = async (cmd: Command) => {
    if (cmd.type !== "plugins.panel") return run(cmd);
    h.engine.runs.push(cmd);
    return result(cmd);
  };
  return h;
}
afterEach(() => {
  for (const h of open) h.close();
  open = [];
});

/** A read sent as a command, the way the session takes it (session-core `cmd`: a read goes through legacy apply). */
function sendRead(h: Harness, cmd: Command, n = 1) {
  const body = { slot: { origin: "desktop", originEpoch: EPOCH_A, target: h.serverStream, n }, floor: 1, inc: h.inc, cmd } as CmdBody;
  return h.runtime.legacy.receive(body, { scope: "local" });
}

const panel = { type: "plugins.panel", name: "note", panel: "main" } as Command;
/** A panel answer like the Note plugin's: CJK text and newlines, so its JSON-escaped UTF-8 is far larger than its length (L-005). */
const bigPanel = () => ({ title: "Note", source: "筆記\n\"pane\"\t".repeat(Math.ceil(ENTRY_BYTES_LIMIT / 8)), settings: {} });

describe("a slot whose result does not fit one entry", () => {
  it("settles with a refusal that says why instead of throwing (which ended the session and re-sent it forever)", async () => {
    const h = await start(bigPanel);
    const status = await sendRead(h, panel);
    expect(outcomeOf(status)).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(String(outcomeOf(status).detail)).toMatch(/plugins\.panel.*too large/);
    // The refusal is what the log keeps for the slot; the giant result is nowhere.
    const last = entriesOf(h.db, h.serverStream).at(-1)!;
    expect(last.kind).toBe("cmd.refused");
    expect(JSON.stringify(last.body).length).toBeLessThan(4_000);
  });

  it("a re-sent copy gets the stored refusal (the handler does not run again) and the next slot of the queue applies", async () => {
    const h = await start(bigPanel);
    await sendRead(h, panel, 1);
    const again = await sendRead(h, panel, 1);
    expect(outcomeOf(again)).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(h.engine.runs.filter((cmd) => cmd.type === "plugins.panel")).toHaveLength(1);
    const next = await sendRead(h, { type: "plugins.list" } as Command, 2);
    expect(outcomeOf(next)).toMatchObject({ kind: "applied" });
  });

  it("a result just under the limit is still stored whole (the guard only takes what cannot fit)", async () => {
    const h = await start(() => ({ title: "Note", source: "x".repeat(ENTRY_BYTES_LIMIT - 4_096), settings: {} }));
    const status = await sendRead(h, panel);
    expect(outcomeOf(status)).toMatchObject({ kind: "applied", result: { title: "Note" } });
    expect(entriesOf(h.db, h.serverStream).at(-1)!.kind).toBe("cmd.applied");
  });
});
