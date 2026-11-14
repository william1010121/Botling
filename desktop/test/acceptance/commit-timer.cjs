// Test-only preload for the latency run (test/acceptance/latency.test.ts): loaded into the built botlingd with
// NODE_OPTIONS=--require, it times every write transaction on server.db at the node:sqlite boundary, without touching
// the server's code: BEGIN IMMEDIATE → COMMIT (the whole group commit) and the COMMIT call alone (the WAL flush with
// synchronous = FULL and fullfsync = ON), plus the number of commands (savepoints) in the batch. One JSON line per
// commit goes to V3_COMMIT_LOG, written in chunks every 250 ms. Any other process that inherits NODE_OPTIONS (the
// fake engine, plugin hosts) is left alone.
"use strict";
const file = process.env.V3_COMMIT_LOG;
if (file && /server[\\/]main\.cjs$/.test(process.argv[1] || "")) {
  const { appendFileSync } = require("node:fs");
  const { DatabaseSync } = require("node:sqlite");
  const { performance } = require("node:perf_hooks");
  const open = new WeakMap();
  const lines = [];
  const flush = () => { if (lines.length) { try { appendFileSync(file, lines.splice(0).join("")); } catch { /* the timer never stops the server */ } } };
  setInterval(flush, 250).unref();
  process.on("exit", flush);
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function timedExec(sql) {
    if (sql === "BEGIN IMMEDIATE") {
      open.set(this, { begin: performance.now(), size: 0 });
      return exec.call(this, sql);
    }
    const txn = open.get(this);
    if (txn && sql === "SAVEPOINT cmd") txn.size++;
    if (txn && sql === "COMMIT") {
      const before = performance.now();
      const result = exec.call(this, sql);
      const end = performance.now();
      open.delete(this);
      let location = "";
      try { location = this.location() || ""; } catch { /* closed */ }
      if (location.endsWith("server.db")) lines.push(`${JSON.stringify({ at: Date.now(), txnMs: +(end - txn.begin).toFixed(3), commitMs: +(end - before).toFixed(3), size: txn.size })}\n`);
      return result;
    }
    return exec.call(this, sql);
  };
}
