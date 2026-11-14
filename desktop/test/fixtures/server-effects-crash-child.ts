// Child process of test/unit/server-effects-crash.test.ts (bundled by the test, run under plain Node; no window). It
// opens server.db in <dataDir>, starts the intent runtime over a fake engine whose turns take a while (chunks on a
// timer, checkpoints every 20 ms), and keeps the server busy until it is killed:
// - `chat.send` to random bots (a slot each), some `turn.stop`s of turns it started;
// - routines whose run the engine defers; card answers whose turn the engine defers; turns the engine begins itself.
// Every turn the engine begins is written to <dataDir>/spawns.log ("<botId> <turnId>") and fsync'ed before the turn
// begins, so the parent knows every turn this incarnation began; a turn the engine begins by itself is also marked
// "core <turnId>" first. "ack <turnId>" goes to fd 1 once a chat.send was applied.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { CmdBody, LogId } from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { openServerStore } from "../../src/server/store";
import { FakeTurnEngine } from "./fake-turn-engine";

// The test checks interrupted texts against these (keep them in step with server-effects-crash.test.ts).
const CRASH_CHUNKS = Array.from({ length: 30 }, (_, i) => `c${i} `);
const CRASH_BOTS = ["B1", "B2", "B3"];

const [dataDir] = process.argv.slice(2);

async function main() {
  const store = await openServerStore(dataDir);
  const spawnLog = openSync(join(dataDir, "spawns.log"), "a");
  const engine = new FakeTurnEngine({
    bots: ["MAIN", ...CRASH_BOTS],
    chunks: CRASH_CHUNKS,
    chunkMs: 8,
    onSpawn: (turnId, botId) => {
      writeSync(spawnLog, `${botId} ${turnId}\n`);
      fsyncSync(spawnLog);
    },
  });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 20 });
  const runtime = new IntentRuntime({ store, engine, live, log: () => {} });
  await runtime.start();
  const serverStream = `srv:${store.meta("serverId")}`;
  const inc = String((await store.submit((db) => db.prepare("SELECT logId FROM streams WHERE stream = ?").get(serverStream)!.logId))) as LogId;
  const epoch = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const next = new Map<string, number>();
  const started: Array<{ botId: string; turnId: string }> = [];
  const send = (cmd: CmdBody["cmd"]) => {
    const botId = (cmd as { botId: string }).botId;
    const target = `bot:${botId}`;
    const n = (next.get(target) ?? 0) + 1;
    next.set(target, n);
    return runtime.receive({ slot: { origin: "desktop", originEpoch: epoch, target, n }, floor: 1, inc, cmd } as CmdBody, { scope: "local" });
  };
  writeSync(1, "ready\n");

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const botId = CRASH_BOTS[Math.floor(Math.random() * CRASH_BOTS.length)];
    const roll = Math.random();
    if (roll < 0.55) {
      void send({ type: "chat.send", botId, text: `message ${tick}` }).then((status) => {
        if (status.status === "result" && status.message.outcome.kind === "applied") {
          const { turnId } = status.message.outcome.result as { turnId: string };
          started.push({ botId, turnId });
          writeSync(1, `ack ${turnId}\n`);
        }
      }, () => {});
    } else if (roll < 0.7) {
      engine.routine(botId);
    } else if (roll < 0.82) {
      const card = engine.addCard(botId);
      setTimeout(() => { void send({ type: "chat.answer", botId, messageId: card.id, text: `answer ${tick}` }).catch(() => {}); }, 5);
    } else if (roll < 0.92) {
      // Marked first: a turn the engine begins by itself is unknown to the server until its turn.started commits.
      const turnId = `t-${randomUUID()}`;
      writeSync(spawnLog, `core ${turnId}\n`);
      fsyncSync(spawnLog);
      engine.coreTurn(botId, turnId);
    } else if (started.length) {
      const pick = started[Math.floor(Math.random() * started.length)];
      void send({ type: "turn.stop", botId: pick.botId, turnId: pick.turnId }).catch(() => {});
    }
  }, 35);
  // Never ends by itself: the parent kills it. A safety stop after 30 s.
  setTimeout(() => { clearInterval(timer); closeSync(spawnLog); process.exit(4); }, 30_000).unref();
}

main().catch((error) => {
  writeSync(2, `${error?.stack ?? error}\n`);
  process.exit(2);
});
