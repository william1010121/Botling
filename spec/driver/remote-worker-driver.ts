// The one door spec/tests/remote-worker.spec.test.ts will use into the app's remote workers (multi-machine phase 1,
// spec/models/remoteworker/RemoteWorker.tla), once they exist. The adapter (desktop/spec-adapters/remote-worker-adapter.ts,
// not written yet) runs the real Core and the real `botling-agent` with a scripted claude in place of the real one, and
// a transport it holds in its hands in place of ssh or the relay: frames wait on it until the test delivers them, and
// it can end a connection keeping only the first frames on their way to the agent. Requests and connections are
// numbered from 1, as in the model; runs are the claude processes the agent started, from 1.
import type { Path, View } from "../reference/remote-worker";

export interface RemoteWorkerSession {
  // the machine (the user, the install line on the machine, the app's own update)
  /** ssh: the user picks a host and Botling shows its host key; relay: the install line prints a URL and a code. */
  pair(path: Path): Promise<void>;
  approve(): Promise<void>;
  decline(): Promise<void>;
  /** The device code's time runs out. */
  expire(): Promise<void>;
  /** The user revokes the machine; the first `keep` frames on their way to the agent still arrive. */
  revoke(keep: number): Promise<void>;
  /** Botling updates itself to a newer version (it restarts, not connected). */
  appUpdate(): Promise<void>;
  // the app
  connect(): Promise<void>;
  upgrade(): Promise<void>;
  /** The user hands the machine a new worker. */
  start(): Promise<void>;
  cancel(): Promise<void>;
  /** The user answers request k's card. */
  answer(k: number): Promise<void>;
  // the transport
  /** The connection ends; the first `keep` frames on their way to the agent still arrive. */
  drop(keep: number): Promise<void>;
  /** The app takes the next frame on connection g. */
  appRecv(g: number): Promise<void>;
  /** The agent takes the next frame on connection g. */
  agentRecv(g: number): Promise<void>;
  // the agent and claude
  /** The agent notices its connection ended. */
  notice(): Promise<void>;
  out(run: number): Promise<void>;
  ask(run: number, k: number): Promise<void>;
  finish(run: number): Promise<void>;
  /** What the app shows now. */
  view(): View;
  /** The claude processes running the session on the machine. */
  alive(): number[];
  close(): Promise<void>;
}

export interface RemoteWorkerDriver {
  open(): Promise<RemoteWorkerSession>;
}
