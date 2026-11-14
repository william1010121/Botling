// Child process of test/unit/server-store-crash.test.ts (bundled by the test, run under plain Node or Electron's Node
// with ELECTRON_RUN_AS_NODE=1; no window). It opens server.db in <dataDir> and commits scripted transactions until it
// is killed: transaction i writes exactly three rows tagged i (an entry, a receipt and a list row). Every fifth
// transaction is joined in its batch by a command that writes a row tagged i in stream "fail" and then throws, so its
// savepoint must leave nothing behind. After each acknowledged transaction it writes "ack <i>\n" to fd 1 (a
// synchronous write, so the parent hears an ack no later than the moment it was given).
import { writeSync } from "node:fs";
import { openServerStore, type Db } from "../../src/server/store";

const [dataDir, totalArg = "100000", windowArg = "16"] = process.argv.slice(2);
const total = Number(totalArg);
const window = Number(windowArg);

function transaction(i: number) {
  return (db: Db) => {
    const body = JSON.stringify({ i, pad: "p".repeat(200 + (i % 7) * 300) });
    db.prepare("INSERT INTO entries (stream, seq, hlc, kind, body, slot, hash) VALUES ('crash', ?, ?, 'test', ?, NULL, ?)")
      .run(i, String(i), body, `h${i}`);
    db.prepare("INSERT INTO receipts (origin, originEpoch, target, n, cmdHash, outcome, seq) VALUES ('crash', 'e1', 'bot:crash', ?, ?, 'applied', ?)")
      .run(i, `c${i}`, i);
    db.prepare("INSERT INTO lists (botId, name, body) VALUES ('crash', ?, ?)").run(`t${i}`, body);
    return i;
  };
}

function failing(i: number) {
  return (db: Db) => {
    db.prepare("INSERT INTO entries (stream, seq, hlc, kind, body, slot, hash) VALUES ('fail', ?, '0', 'test', 'x', NULL, 'h')").run(i);
    throw new Error(`scripted failure ${i}`);
  };
}

async function main() {
  const store = await openServerStore(dataDir);
  writeSync(1, "ready\n");
  let next = 1;
  let inFlight = 0;
  await new Promise<void>((done) => {
    const pump = () => {
      // Submit a burst of random size (1..window) so batches of different sizes form, then refill as acks arrive.
      const burst = 1 + Math.floor(Math.random() * window);
      for (let k = 0; k < burst && inFlight < window && next <= total; k++) {
        const i = next++;
        inFlight++;
        if (i % 5 === 0) store.submit(failing(i)).catch(() => {});
        store.submit(transaction(i)).then((n) => {
          writeSync(1, `ack ${n}\n`);
          inFlight--;
          if (next > total && inFlight === 0) done();
          else pump();
        }, (error) => {
          writeSync(2, `unexpected failure of ${i}: ${error}\n`);
          process.exit(3);
        });
      }
    };
    pump();
  });
  await store.close();
  writeSync(1, "done\n");
}

main().catch((error) => {
  writeSync(2, `${error?.stack ?? error}\n`);
  process.exit(2);
});
