// spec/driver/store-driver.ts against the real server.db: openServerStore (its writer, durability gate and boot
// check), LogHub / LogReader for the reader, and botlingd's `onLostTail` (lostTailRewind). Translation only:
// - "the disk" is a folder; a start opens the store there with this machine boot's id (`boot-<n>`);
// - a crash copies the folder's server.db and server.db-wal whole into the next folder (what was committed is in the
//   OS); a power loss copies the WAL cut where it ended after commit `keep` (each batch's end and each flush are noted
//   with the WAL's size) and boots the machine again. No checkpoint runs in between (the runs are far below SQLite's
//   1000-page auto-checkpoint), so the WAL only grows until a clean close folds it into server.db;
// - a command is one batch: an entry of the bot stream (`turn.started` with the command as turnId), plus for an
//   acknowledged one the slot row behind its `cmd.result` (writeNext, the `slots` table);
// - the reader keeps what a front end keeps: its cursor, and the commands of the entries it holds (after a snap: the
//   store's entries up to the snap's seq, which the snap stands for).
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, ftruncateSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StoreCmdKind, StoreCommitResult, StoreDriver, StoreDriverOptions, StoreObservation } from "../../spec/driver/store-driver";
import type { Message, Slot, StreamId } from "../src/protocol";
import { appendEntries, ensureStream, LogHub, lostTailRewind, readEntries, readStream, type LogReader } from "../src/server/log";
import { writeNext } from "../src/server/slots/tables";
import { openServerStore, type BatchInfo, type ServerStore } from "../src/server/store";

const STREAM = "bot:alpha" as StreamId;
const QUEUE = { origin: "fe-spec", originEpoch: "e1", target: STREAM } as unknown as Pick<Slot, "origin" | "originEpoch" | "target">;

export function storeDriver({ root }: StoreDriverOptions): StoreDriver {
  let gen = 0;
  let disk = join(root, "g0");
  mkdirSync(disk, { recursive: true });
  let boot = 0;
  let store: ServerStore | null = null;
  let hub: LogHub | null = null;
  let reader: LogReader | null = null;
  let lastBatch: BatchInfo | null = null;
  /** Commits on the disk (as the OS shows it), and how many the last flush covered. */
  let commits = 0;
  let synced = 0;
  /** WAL size where it ended while `n` commits were in it (the last such moment). */
  let walAt = new Map<number, number>();
  let nextN = 1;
  const logIds: string[] = [];
  const idOf = (logId: string) => {
    if (!logIds.includes(logId)) logIds.push(logId);
    return logIds.indexOf(logId);
  };
  const rd = { on: false, logId: null as string | null, seq: 0, awaitingSnap: false, log: [] as string[] };

  const wal = () => join(disk, "server.db-wal");
  const walSize = () => (existsSync(wal()) ? statSync(wal()).size : 0);
  const noteWal = () => { walAt.set(commits, walSize()); };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const storeEntries = (upTo = Infinity): string[] => {
    const db = hub!.reader();
    const out: string[] = [];
    let from = 1;
    for (;;) {
      const { entries } = readEntries(db, STREAM, from, { maxEntries: 500, maxBytes: 4 * 1024 * 1024 });
      if (!entries.length) return out;
      for (const entry of entries) {
        if (entry.seq > upTo) return out;
        out.push(String(entry.body.turnId));
        from = entry.seq + 1;
      }
    }
  };

  const receive = (message: Message): void => {
    if (!("stream" in message) || message.stream !== STREAM) return;
    switch (message.t) {
      case "batch":
        if (rd.awaitingSnap || message.logId !== rd.logId || message.from !== rd.seq + 1) throw new Error(`store adapter: batch out of order (${message.logId} from ${message.from})`);
        for (const entry of message.entries) { rd.log.push(String(entry.body.turnId)); rd.seq = entry.seq; }
        return;
      case "snap":
        rd.logId = message.logId; rd.seq = message.seq; rd.awaitingSnap = false; rd.log = storeEntries(message.seq);
        return;
      case "reset":
        rd.logId = message.logId; rd.awaitingSnap = true; rd.log = [];
        return;
      default:
    }
  };

  /** The process is gone: its objects are let go (a clean close of a copy nobody opens again). */
  const abandon = async () => {
    reader?.close(); reader = null; rd.on = false;
    hub?.close(); hub = null;
    const old = store; store = null;
    await old?.close();
  };

  /** The next disk: server.db and the WAL (cut at `bytes`, or whole) copied into a new folder. */
  const copyDisk = (bytes: number | null) => {
    const from = disk;
    disk = join(root, `g${++gen}`);
    mkdirSync(disk, { recursive: true });
    copyFileSync(join(from, "server.db"), join(disk, "server.db"));
    if (existsSync(join(from, "server.db-wal"))) {
      copyFileSync(join(from, "server.db-wal"), wal());
      if (bytes !== null) {
        const fd = openSync(wal(), "r+");
        try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
      }
    }
  };

  return {
    async start() {
      store = await openServerStore(disk, {
        bootId: `boot-${boot}`, compaction: false, onLostTail: lostTailRewind(),
        onBatch: (info) => { lastBatch = info; },
      });
      hub = new LogHub(store);
      synced = commits;
      noteWal();
      if (!readStream(hub.reader(), STREAM)) {
        // The stream, flushed (a meta row marks the batch), so no power loss takes it from under a later commit.
        await store.submit((db) => {
          ensureStream(db, STREAM);
          db.prepare("INSERT INTO meta (key, value) VALUES ('spec.stream', '1') ON CONFLICT (key) DO NOTHING").run();
        });
        noteWal();
      }
    },
    async commit(cmd: string, kind: StoreCmdKind): Promise<StoreCommitResult> {
      const n = nextN++;
      lastBatch = null;
      await store!.submit((db) => {
        appendEntries(db, STREAM, [{ kind: "turn.started", body: { botId: "alpha", turnId: cmd, messageId: "m" } }]);
        if (kind === "ack") writeNext(db, QUEUE, n);
      });
      const durable = lastBatch!.durable;
      commits += 1;
      if (durable) synced = commits;
      noteWal();
      hub!.committed([STREAM]);
      await tick();
      return { durable };
    },
    async close() {
      reader?.close(); reader = null; rd.on = false;
      hub?.close(); hub = null;
      await store!.close(); store = null;
      // The clean close folded the WAL into server.db: every commit is in the file now.
      synced = commits;
      walAt = new Map([[commits, 0]]);
    },
    async crash() {
      // Copied first: the abandoned store's close folds its own folder's WAL, never the copy.
      copyDisk(null);
      await abandon();
    },
    async powerLoss(keep: number) {
      if (keep < synced || keep > commits) throw new Error(`store adapter: a power loss keeps ${synced}..${commits} commits, not ${keep}`);
      const bytes = walAt.get(keep);
      if (bytes === undefined) throw new Error(`store adapter: no WAL size noted for ${keep} commits`);
      copyDisk(bytes);
      await abandon();
      commits = keep;
      synced = keep;
      for (const n of [...walAt.keys()]) if (n > keep) walAt.delete(n);
      boot += 1;
    },
    async subscribe() {
      reader = hub!.attach(receive);
      rd.on = true;
      lastBatch = null;
      const cursor = rd.logId !== null && !rd.awaitingSnap ? { logId: rd.logId, seq: rd.seq } : null;
      const result = await reader.sub(STREAM, cursor as never);
      if (!result.ok) throw new Error(`store adapter: sub refused (${result.reason})`);
      await tick();
      // A rewind's retire was a durable batch: flushed.
      if (lastBatch?.durable) synced = commits;
      noteWal();
    },
    disconnect() {
      reader?.close(); reader = null; rd.on = false;
    },
    observe(): StoreObservation {
      const up = store !== null;
      return {
        up,
        log: up ? storeEntries() : [],
        synced,
        logId: up ? idOf(readStream(hub!.reader(), STREAM)!.logId) : -1,
        readerOn: rd.on,
        readerLog: [...rd.log],
        readerId: rd.logId === null ? -1 : idOf(rd.logId),
      };
    },
    async dispose() {
      await abandon();
    },
  };
}
