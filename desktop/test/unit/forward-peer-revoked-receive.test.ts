// M7-12c (security follow-up to M7-12a, residual R1): B checks the forwarding peer again where it decides a copy.
//
// A window copy (origin `desktop`, stamped `manage`) is decided on B as a user, so no roster check of its origin can
// notice that the peer which delivered it was revoked after the frame arrived. `OwnerInbox` therefore passes the
// delivering session's peer in `ReceiveOptions.peer`, the slot engine hands it to `slotAuthorize`, and the check runs
// inside the decision transaction: for a copy held ahead and applied later too (it keeps its peer). A copy that did
// not come through a peer (`peer` undefined: the local socket, a device) is decided as before.
//
// Real OwnerInbox + SlotEngine + `slotAuthorize` on B; A's side is a hand-written frame (the forwarder is not needed).
import { describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import type { CmdBody, MessageOf, Slot, WireMessage } from "../../src/protocol";
import { OwnerInbox, type InboxSession } from "../../src/server/forward";
import { WINDOW_ORIGIN } from "../../src/server/forward/window-scope";
import { slotAuthorize, type DeviceRoster } from "../../src/server/session";
import { SlotEngine, type ApplyFn } from "../../src/server/slots";
import { until } from "../helpers";
import { FakeLog, memoryStore } from "./server-slots-harness";

const A = "srv-a";
const B = "srv-b";
const BOT = "6A0B0000-0000-4000-8000-0000000000B1";
const EPOCH = "c".repeat(32);
const INC = "inc-00000001"; // the slot harness log's incarnation
const TARGET = `bot:${BOT}` as const;
const send = (text: string): Command => ({ type: "chat.send", botId: BOT, text });

const frame = (origin: string, n: number, scope: CmdBody["scope"]): WireMessage =>
  ({ t: "cmd", slot: { origin, originEpoch: EPOCH, target: TARGET, n }, floor: 1, inc: INC, cmd: send(`slot ${n}`), scope }) as never;

async function ownerSide(peerOf: () => string | null) {
  const b = memoryStore();
  const applied: number[] = [];
  const results: Array<MessageOf<"cmd.result">> = [];
  const state = { peerValid: true };
  const apply: ApplyFn = ({ slot, log, tx }) => {
    log.appendEntry(tx, slot.target, "test.intent", { n: slot.n }, slot);
    applied.push(slot.n);
    return { result: { n: slot.n } };
  };
  const roster: DeviceRoster = { memberId: B, device: () => null, server: (member) => member === A && state.peerValid };
  const engine = new SlotEngine({ submit: (c) => b.writer.submit(c), log: new FakeLog(), apply, authorize: slotAuthorize(roster), basis: { turnRunning: () => true, card: () => ({ open: true, rev: 1 }) } });
  const inbox = new OwnerInbox({ self: B, runtime: { receive: (body: CmdBody, options: never) => engine.receive(body, options), slots: engine, legacy: { receive: (body: CmdBody, options: never) => engine.receive(body, options) } } as never, log: () => undefined });
  const session: InboxSession = {
    get peer() { return peerOf(); }, state: "open",
    sendWire: (m: WireMessage) => { if (m.t === "cmd.result") results.push(m as MessageOf<"cmd.result">); return true; },
    bye: () => undefined,
  };
  return {
    state, applied, results,
    deliver: (message: WireMessage) => { inbox.onMessage(session, structuredClone(message)); },
    result: (n: number) => results.find((r) => r.slot.n === n),
    close: async () => { await b.writer.close(); b.db.close(); },
  };
}

describe("M7-12c: the forwarding peer is checked again where B decides a window copy", () => {
  it("control: a valid peer's window copy applies as in M7-12a", async () => {
    const w = await ownerSide(() => A);
    try {
      w.deliver(frame(WINDOW_ORIGIN, 1, "manage"));
      await until(() => w.result(1), { what: "the answer" });
      expect(w.result(1)!.outcome).toMatchObject({ kind: "applied" });
      expect(w.applied).toEqual([1]);
    } finally { await w.close(); }
  });

  it("a peer revoked between forward and receive: the copy is refused, not applied", async () => {
    const w = await ownerSide(() => A);
    try {
      // The frame was accepted from A's session; A is revoked before the slot is decided.
      w.state.peerValid = false;
      w.deliver(frame(WINDOW_ORIGIN, 1, "manage"));
      await until(() => w.result(1), { what: "the refusal" });
      expect(w.result(1)!.outcome).toMatchObject({ kind: "refused", reason: "origin" });
      expect(w.applied).toEqual([]);
    } finally { await w.close(); }
  });

  it("a copy held ahead is decided with the peer's state at decision time (revoked while it waited)", async () => {
    const w = await ownerSide(() => A);
    try {
      w.deliver(frame(WINDOW_ORIGIN, 2, "manage")); // above next: held, nothing decided yet
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(w.result(2)).toBeUndefined();
      w.state.peerValid = false; // A's revocation lands while slot 2 waits in memory
      w.deliver(frame(WINDOW_ORIGIN, 1, "manage")); // the predecessor arrives: both are decided now
      await until(() => w.result(1) && w.result(2), { what: "both answers" });
      expect(w.result(1)!.outcome).toMatchObject({ kind: "refused", reason: "origin" });
      expect(w.result(2)!.outcome).toMatchObject({ kind: "refused", reason: "origin" });
      expect(w.applied).toEqual([]);
    } finally { await w.close(); }
  });

  it("a peer session that names no peer is refused too (fail closed)", async () => {
    const w = await ownerSide(() => null);
    try {
      w.deliver(frame(WINDOW_ORIGIN, 1, "manage"));
      await until(() => w.result(1), { what: "the refusal" });
      expect(w.result(1)!.outcome).toMatchObject({ kind: "refused", reason: "origin" });
      expect(w.applied).toEqual([]);
    } finally { await w.close(); }
  });
});

describe("M7-12c: slotAuthorize and the peer option", () => {
  const slot = (origin: string): Slot => ({ origin, originEpoch: EPOCH, target: TARGET, n: 1 });
  const tx = null as never;
  const roster = (valid: boolean): DeviceRoster => ({ memberId: B, device: () => null, server: (m) => m === A && valid });

  it("refuses a window copy whose delivering peer is not a valid server now; a copy without a peer is as before", () => {
    const input = { slot: slot(WINDOW_ORIGIN), cmd: send("x"), scope: "manage" as const };
    expect(slotAuthorize(roster(true))(tx, { ...input, peer: A })).toBeNull();
    expect(slotAuthorize(roster(false))(tx, { ...input, peer: A })).toMatchObject({ reason: "origin" });
    expect(slotAuthorize(roster(true))(tx, { ...input, peer: "srv-unknown" })).toMatchObject({ reason: "origin" });
    expect(slotAuthorize(roster(true))(tx, { ...input, peer: null })).toMatchObject({ reason: "origin" });
    // No peer (the local socket, a device): the check does not apply.
    expect(slotAuthorize(roster(false))(tx, input)).toBeNull();
  });

  it("a roster without a server hook cannot vouch for a peer (fail closed)", () => {
    const noHook: DeviceRoster = { memberId: B, device: () => null };
    expect(slotAuthorize(noHook)(tx, { slot: slot(WINDOW_ORIGIN), cmd: send("x"), scope: "manage", peer: A })).toMatchObject({ reason: "origin" });
  });
});
