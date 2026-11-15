// The owner's side of forwarding (M3 step 9, protocol v1 §11.2 step 4, §11.3, D58, D59, D67): `cmd` and `cancel`
// frames a peer server forwards for targets this server owns, decided by the same slot engine as a front end's
// (server/slots, unchanged), answered on the same peer session.
//
//   cmd     → IntentRuntime.receive under the scope the forwarding server stated; cmd.result / cmd.retry go back to
//             that session (the result of a copy held ahead and applied later too). One queue's copies run one after
//             another in the order the session carried them (D58), as the session core does for a front end; a copy
//             this server cannot settle (the store failed, the path threw, or a copy above a gap it kept no copy of)
//             ends the peer session with bye{unsettled}: the forwarder starts again from its lowest row.
//   cancel  → SlotEngine.cancel, always answered (D59): the stored cmd.result, or cancel.noted after the commit; a
//             cancel for a slot whose handler began waits for that outcome while the session lasts.
//
// Scope: the forwarding server states it (§11.1) and the owner's checks (slotAuthorize: origin valid now, roster scope
// allows the command) decide. `local` and `admin` mean "the desktop window on its own server" and are never taken from
// a peer: a forwarded copy stating one (or none) is decided as stated `read`, which the owner refuses unless the
// command is a read (the owner's refusal, stored; the forwarder never refuses, F3).
// M7-12a: a window command the attached server stamped `manage` passes through this unchanged (window-scope.ts: the
// owner's slotAuthorize decides it as a user); only a stated `local`, `admin` or none still means `read`.
// A target this server does not own is not forwarded again (no loops, §11.2 step 5): a `srv:` target of another server
// ends the session (`bye{role}`: the forwarder's directory is wrong); a `bot:` target goes to the slot engine, which
// refuses a bot this server does not have.
import { queueKey, type CmdBody, type Message, type Scope, type WireMessage } from "../../protocol";
import { routeOf, type IntentRuntime } from "../intents";
import { cancelAnswer } from "../slots";

/** A peer session as the owner side uses it. */
export interface InboxSession {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
  bye(reason: "unsettled" | "role", detail: string): void;
}

export interface OwnerInboxOptions {
  self: string;
  runtime: Pick<IntentRuntime, "receive" | "slots" | "legacy">;
  log(line: string): void;
}

/** The scope the owner decides a forwarded copy under (never `local` or `admin` from a peer). */
export function peerScope(stated: Scope | undefined): Scope {
  return stated === undefined || stated === "local" || stated === "admin" ? "read" : stated;
}

interface PerSession { chains: Map<string, Promise<void>>; closed: Promise<void>; close: () => void }

export class OwnerInbox {
  private readonly sessions = new WeakMap<InboxSession, PerSession>();

  constructor(private readonly options: OwnerInboxOptions) {}

  /** `cmd` and `cancel` from a peer; false for any other frame. */
  onMessage(session: InboxSession, message: WireMessage): boolean {
    if (message.t !== "cmd" && message.t !== "cancel") return false;
    const state = this.state(session);
    if (message.slot.target.startsWith("srv:") && message.slot.target !== `srv:${this.options.self}`) {
      session.bye("role", `${message.slot.target} is not this server's: a command is forwarded only to its owner`);
      return true;
    }
    const key = queueKey(message.slot);
    const work = message.t === "cmd"
      ? () => { const { t: _t, ...body } = message; return this.cmd(session, state, body as CmdBody); }
      : () => this.cancel(session, state, message as Extract<Message, { t: "cancel" }>);
    const run = (state.chains.get(key) ?? Promise.resolve())
      .then(work)
      .catch((error) => this.unsettled(session, `${message.t} for slot ${message.slot.n} of ${message.slot.target} was not settled: ${errorText(error)}`));
    state.chains.set(key, run);
    void run.then(() => { if (state.chains.get(key) === run) state.chains.delete(key); });
    return true;
  }

  /** The session ended: a cancel waiting on a running handler stops waiting (the forwarder sends it again). */
  closed(session: InboxSession): void {
    this.sessions.get(session)?.close();
    this.sessions.delete(session);
  }

  private state(session: InboxSession): PerSession {
    let state = this.sessions.get(session);
    if (!state) {
      let close!: () => void;
      const closed = new Promise<void>((resolve) => { close = resolve; });
      state = { chains: new Map(), closed, close };
      this.sessions.set(session, state);
    }
    return state;
  }

  private open(session: InboxSession, state: PerSession): boolean {
    return session.state === "open" && this.sessions.get(session) === state;
  }

  private async cmd(session: InboxSession, state: PerSession, body: CmdBody): Promise<void> {
    if (!this.open(session, state)) return;
    const scope = peerScope(body.scope);
    const reply = (message: Message) => { if (session.state === "open") session.sendWire(message as WireMessage); };
    const route = routeOf(body.cmd.type).kind;
    const runtime = this.options.runtime;
    const status = route === "intent" || route === "legacy"
      ? await runtime.receive(body, { scope, reply })
      : await runtime.legacy.receive(body, { scope, reply });
    if (status.status === "dropped") this.unsettled(session, `cmd ${body.cmd.type} (slot ${body.slot.n}) came before an earlier slot of its queue (D58)`);
  }

  private async cancel(session: InboxSession, state: PerSession, message: Extract<Message, { t: "cancel" }>): Promise<void> {
    if (!this.open(session, state)) return;
    const status = await Promise.race([this.options.runtime.slots.cancel(message.slot), state.closed.then(() => null)]);
    if (status && session.state === "open") session.sendWire(cancelAnswer(message.slot, status) as WireMessage);
  }

  private unsettled(session: InboxSession, detail: string): void {
    this.options.log(`forward: ${detail}`);
    if (session.state === "open") session.bye("unsettled", detail);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
