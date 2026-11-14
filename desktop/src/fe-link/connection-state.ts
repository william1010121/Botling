// The front end's connection-state machine (protocol v1 §13.3): the only states the UI may show. M1 has one server, so
// the states that need a roster or other machines ("machine stale", "gone", "needs pairing") never occur here (M2).
//
// The shown state is derived from a few facts, in this order:
//   update required    welcome.minFeVersion is above this front end (or no common protocol); final until a reload
//   offline            not attached, and the link has been trying for longer than the offline delay
//   connecting         not attached (first dial, or a reconnect after the session ended)
//   history restored   attached, a `reset` came, and the UI has not dismissed the notice (it wins over catching up: the
//                      snap that follows every reset would otherwise flash "catching up" over the notice)
//   catching up        attached, and a stream still waits for its snap or catch-up pages (the owner's `srv:` snap
//                      included: until it comes the inc is unknown and commands wait)
//   live               attached, nothing of the above
// Writes (§13.3 "Writes"): sent in live / catching up / history restored; kept in the outbox otherwise.
import type { ConnectionState } from "../protocol";

export interface ConnModel {
  state: ConnectionState;
  /** When `state` last changed. */
  since: number;
  attached: boolean;
  offline: boolean;
  catching: boolean;
  /** When the last `reset` came, while its notice is shown (`history restored`). */
  restoredAt: number | null;
  /** When the link was last attached (the "as of <time>" of offline). */
  asOf: number | null;
  /** Set once `update required`: the version the server asks for. */
  minFeVersion: string | null;
}

export type ConnEvent =
  /** A session was welcomed; `catching`: snaps or pages are already due. */
  | { type: "welcome"; catching: boolean }
  | { type: "update required"; minFeVersion: string }
  | { type: "catching"; catching: boolean }
  | { type: "reset" }
  | { type: "restore seen" }
  /** The session ended (closed, dead, refused). */
  | { type: "lost" }
  /** The offline delay passed without a session. */
  | { type: "offline" };

export function initialConn(now: number): ConnModel {
  return { state: "connecting", since: now, attached: false, offline: false, catching: false, restoredAt: null, asOf: null, minFeVersion: null };
}

function derive(model: Omit<ConnModel, "state" | "since">): ConnectionState {
  if (model.minFeVersion !== null) return "update required";
  if (!model.attached) return model.offline ? "offline" : "connecting";
  if (model.restoredAt !== null) return "history restored";
  if (model.catching) return "catching up";
  return "live";
}

export function connReduce(model: ConnModel, event: ConnEvent, now: number): ConnModel {
  if (model.minFeVersion !== null) return model; // final until the front end reloads
  const next = { ...model };
  switch (event.type) {
    case "welcome": next.attached = true; next.offline = false; next.catching = event.catching; break;
    case "update required": next.minFeVersion = event.minFeVersion; next.attached = false; next.catching = false; break;
    case "catching": if (next.attached) next.catching = event.catching; break;
    case "reset": if (next.attached) next.restoredAt = now; break;
    case "restore seen": next.restoredAt = null; break;
    case "lost": if (next.attached) next.asOf = now; next.attached = false; next.catching = false; break;
    case "offline": if (!next.attached) next.offline = true; break;
  }
  const state = derive(next);
  return { ...next, state, since: state === model.state ? model.since : now };
}

/** Whether commands go out in this state, or wait in the outbox (§13.3). */
export function writesSent(state: ConnectionState): boolean {
  return state === "live" || state === "catching up" || state === "history restored";
}

/** True when version `a` is below `b` (dotted numbers; a pre-release suffix is ignored). */
export function versionBelow(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[+-]/)[0].split(".").map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
