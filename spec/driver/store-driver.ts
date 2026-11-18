// The only door spec/tests/store.spec.test.ts uses into the app's server.db durability (spec/models/store).
// An interface: desktop/spec-adapters/store-adapter.ts implements it with the real store (openServerStore, its writer
// and durability gate), the real log (LogHub, LogReader) and botlingd's `onLostTail`.
// The machine is simulated with files: each start opens a copy of the files the last run left on "the disk". A crash
// copies them whole (what was committed is in the OS); a power loss copies the WAL cut at a commit, never before the
// last flush (what a power loss keeps, by the WAL's running checksums), and the machine boots again.

export type StoreCmdKind = "ack" | "event";

/** What the real code shows. Indexes stand for the logIds the stream had, in the order the adapter first saw them. */
export interface StoreObservation {
  up: boolean;
  /** The commands of the own stream's entries, in seq order (only while up). */
  log: string[];
  /** How many of them the last flush covered (the open, a flushed batch, the close). */
  synced: number;
  /** The stream's logId now (only while up). */
  logId: number;
  /** The reader is subscribed to this run. */
  readerOn: boolean;
  /** The commands of the entries the reader holds, and the logId it holds them under (-1: none yet). */
  readerLog: string[];
  readerId: number;
}

export interface StoreCommitResult {
  /** The batch was flushed before its promise settled (BatchInfo.durable). */
  durable: boolean;
}

export interface StoreDriver {
  /** Opens the store from the disk (a copy of what the last run left), with this boot of the machine. */
  start(): Promise<void>;
  /** One command, alone in its batch: its entry, plus (ack) the durable row behind its acknowledgement. */
  commit(cmd: string, kind: StoreCmdKind): Promise<StoreCommitResult>;
  /** store.close(). */
  close(): Promise<void>;
  /** The process dies: the disk keeps every commit (the WAL whole). */
  crash(): Promise<void>;
  /** The machine loses power: the disk keeps the first `keep` commits (never fewer than the flushed ones); a new boot. */
  powerLoss(keep: number): Promise<void>;
  /** The reader subscribes with its cursor (none before its first snap). */
  subscribe(): Promise<void>;
  disconnect(): void;
  observe(): StoreObservation;
  /** Lets go of everything (connections, files). */
  dispose(): Promise<void>;
}

export interface StoreDriverOptions {
  /** An empty folder to work in. */
  root: string;
}
