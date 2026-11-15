// Legacy apply (M1 brief §3): every mutating command outside the core set. The core's own handler runs first (it may
// be asynchronous: plugin code, a process, the network); then one writer command stores what it emitted (the event
// tap holds its own writes meanwhile and its waiting events are written at the start of that command,
// TxScope.onEnter) together with the slot's `cmd.applied` / `cmd.refused` and its receipt. A handler that runs longer
// than `holdMs` (50 ms) releases the hold: its later events, and every running turn's, are stored on their own.
//
//   copy → admit (read-only):  retry / duplicate / conflict → the slot engine answers as for any command
//                              hold → dropped (a legacy copy is never kept ahead: the handler must not run before its
//                                     predecessors; the sender's re-send brings it again)
//                              ready, cancelled → the slot engine stores `cmd.cancelled`
//                              ready, but the scope / origin / grant check or the target check (M5-04d U1: a command
//                                for another bot's stream, a server command on a bot's) would refuse it → the slot
//                                engine stores that refusal; the slot is not marked begun and the handler never runs
//                              ready → mark the slot begun in the same transaction (SlotEngine.begin: from now on a
//                                      cancel is too late and gets this slot's real outcome, D59), run the handler once
//                                      (a second copy meanwhile waits for the same run), keep
//                                      its result, then the slot engine applies it: the apply step only looks up that
//                                      result (none: a plain error, nothing stored, the sender re-sends)
//
// A crash after the handler ran and before the receipt committed loses the receipt: the re-send runs the handler
// again. commands.ts says, per command, what that second run does.
import type { Command } from "../../contract";
import { ContractError } from "../../contract";
import { queueKey, type CmdBody } from "../../protocol";
import { admit, checkTarget, cmdHash, SlotRefusal, statedScope, type ApplyContext, type BegunEnd, type ReceiveOptions, type ReceiveStatus, type SlotEngine, type SlotLog } from "../slots";
import type { TxScope, TurnEngine } from "../effects";

type Ran = { ok: true; result: unknown } | { ok: false; detail: string };

/** `checkTarget` as a yes / no: false when the command is not for the stream its slot names (a throw also counts as no, L-009). */
function belongsToTarget(body: CmdBody): boolean {
  try {
    checkTarget(body.slot.target, body.cmd);
    return true;
  } catch {
    return false;
  }
}

const keyOf = (slot: { origin: string; originEpoch: string; target: string; n: number }, hash: string) => `${queueKey(slot)}#${slot.n}#${hash}`;

export class LegacyApply {
  private readonly ran = new Map<string, Ran>();
  private readonly running = new Map<string, Promise<Ran>>();

  constructor(
    private readonly scope: TxScope,
    private readonly log: SlotLog,
    private readonly engine: TurnEngine,
    private readonly slots: () => SlotEngine,
    /** Holds the event tap's own writes (EventTap.hold); returns the release. */
    private readonly holdEvents: () => () => void = () => () => {},
    /** A handler that runs longer than this lets its events be stored on their own (turn events must not wait). */
    private readonly holdMs = 50,
  ) {}

  async receive(body: CmdBody, options: ReceiveOptions): Promise<ReceiveStatus> {
    // The caller's stated scope, never the frame's own `body.scope` (M5-19 I1); a missing one throws before anything is stored.
    const scope = statedScope(options, "legacy");
    const hash = cmdHash({ cmd: body.cmd, scope, basis: body.basis, via: body.via });
    // Set inside the admission transaction when the slot is marked begun (SlotEngine.begin).
    const begun: { end?: (how: BegunEnd) => void } = {};
    let admission;
    try {
      admission = await this.scope.submit((tx) => {
        const admitted = admit(tx, this.log, { slot: body.slot, floor: body.floor, inc: body.inc, cmd: body.cmd, scope, basis: body.basis, ...(body.via ? { via: body.via } : {}), hash });
        // A command the owner refuses (a device without the scope, or no longer valid; a plugin's, N1) never runs its handler (M2).
        // Nor does one for a target it does not belong to (U1): that check used to come after the handler. Same order as the
        // slot engine's decision (scope first, then target); the engine then stores the refusal.
        const denied = admitted.kind === "ready" && !admitted.cancelled
          && (this.slots().denies(tx, { slot: body.slot, cmd: body.cmd, scope, via: body.via }) !== null || !belongsToTarget(body));
        // D59: marked begun in the transaction that found no cancel, so a cancel after this is too late, never noted.
        if (admitted.kind === "ready" && !admitted.cancelled && !denied) begun.end = this.slots().begin(body.slot);
        return { ...admitted, denied };
      });
    } catch (error) {
      begun.end?.("not run");
      throw error;
    }
    if (admission.kind === "hold") return { status: "dropped" };
    if (admission.kind !== "ready" || admission.cancelled || admission.denied) return this.slots().receive(body, options);
    const finish = begun.end ?? (() => undefined);
    const key = keyOf(body.slot, hash);
    let run = this.running.get(key);
    // What the handler emits waits for the command that stores the receipt (TxScope.onEnter writes it first).
    const release = this.holdEvents();
    const timer = setTimeout(release, this.holdMs);
    if (!run) {
      run = this.run(body.cmd);
      this.running.set(key, run);
    }
    let how: BegunEnd = "ran";
    try {
      this.ran.set(key, await run);
      const status = await this.slots().receive(body, options);
      // A result (fresh or the stored one again) means the slot's outcome is committed.
      if (status.status === "result") how = "stored";
      return status;
    } finally {
      finish(how);
      clearTimeout(timer);
      release();
      this.running.delete(key);
      this.ran.delete(key);
    }
  }

  /** The apply step for a legacy command: the result its handler gave, kept by `receive`. */
  apply(context: ApplyContext): { result?: unknown } {
    const ran = this.ran.get(keyOf(context.slot, cmdHash({ cmd: context.cmd, scope: context.scope, basis: context.basis, via: context.via })));
    if (!ran) throw new Error(`legacy: ${context.cmd.type} reached apply without its handler's result (re-send it)`);
    if (!ran.ok) throw new SlotRefusal("invalid", ran.detail);
    return ran.result === undefined ? {} : { result: ran.result };
  }

  private async run(cmd: Command): Promise<Ran> {
    try {
      return { ok: true, result: await this.engine.run(cmd) };
    } catch (error) {
      const detail = error instanceof ContractError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      return { ok: false, detail };
    }
  }
}
