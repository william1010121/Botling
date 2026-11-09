// The only door spec/tests/relaypair.spec.test.ts uses into the app's phone pairing (spec/models/relaypair).
// An interface: desktop/spec-adapters/relaypair-adapter.ts implements it.
//
// RelayPair: the real RelayConnector behind a relay played here, and phones played here with the real end-to-end
// crypto. The connector stops before each of its modelled steps for a peer until step() lets it go, so the test
// decides what happens between any two of them. Every call resolves once the connector has nothing left to do
// but wait (for a frame, or at a step).
//
// LanPair: the real PairingStore, one per process on one pairing folder. Each call is one whole operation.
import type { LanView, RelayDown, RelayView } from "../reference/relaypair";

/** The connector's steps that wait for step(), as RelayPair.tla names them. */
export type RelayPairStep = "HsCheck" | "HsKeys" | "Confirm" | "Grant" | "ReqCheck" | "ReqSend";

export interface RelayPairDriver {
  /** pair(): a new one-time code. */
  make(offer: string): Promise<void>;
  /** The clock passes the code's TTL. */
  expire(offer: string): Promise<void>;
  /** A phone scanned the code: the relay opens a peer and the phone sends {h:'pair'}. */
  joinPair(conn: string, offer: string): Promise<void>;
  /** The phone that paired on `device` connects again with its saved session ({h:'hello'}). */
  joinSession(conn: string, device: string): Promise<void>;
  /** The phone reads the next frame on its way to it (answering an ack with its first encrypted frame). */
  recv(conn: string): Promise<RelayDown>;
  /** The phone sends one request. */
  request(conn: string): Promise<void>;
  /** The connection drops: nothing more reaches the phone. */
  drop(conn: string): Promise<void>;
  /** The relay tells the desktop the phone is gone. */
  deskClose(conn: string): Promise<void>;
  /** Lets the peer go on from the step it waits at; returns that step. */
  step(conn: string): Promise<RelayPairStep>;
  /** The step each peer waits at (null: it waits for a frame, or is done). */
  waiting(): Record<string, RelayPairStep | null>;
  /** revoke() of the device `device` paired, to its return. */
  revoke(device: string): Promise<void>;
  observe(): RelayView;
  close(): void;
}

export interface RelayPairDriverOptions {
  conns: readonly string[];
  offers: readonly string[];
  /** An empty folder to work in. */
  root: string;
}

export interface LanPairDriver {
  create(proc: string, code: string): void;
  /** A phone posts the code's secret to this process; its answer. */
  redeem(proc: string, phone: string, code: string): "token" | "invalid";
  revoke(proc: string, phone: string): boolean;
  /** The clock passes the code's TTL. */
  expire(code: string): void;
  observe(): LanView;
}

export interface LanPairDriverOptions {
  procs: readonly string[];
  phones: readonly string[];
  /** An empty folder to work in. */
  root: string;
}
