// TEMPORARY (not kept): runs the mutant batch for the cold-cache guards in one connection. Each mutant must make the related tests fail.
import { it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILES = ["test/unit/bot-cold-resume.test.ts", "test/unit/bot-store-contract.test.ts", "test/unit/bot-head-transitions.test.ts"];
const D = "src/core/bot/delivery.ts", H = "src/core/bot/head.ts";
const mutants: [string, string, string, string][] = [
  ["M3 shuttingDown guard", D, "!this.host.shuttingDown && ", ""],
  ["M2 tidying guard", D, " && !this.host.tidying", ""],
  ["M2b tidy-origin guard", D, 'turn.origin !== "tidy" && ', ""],
  ["M2c ownWork guard", D, " && !this.ownWorkRunning", ""],
  ["M5 turn.head reset", D, "if (turn.head === cold) turn.head = null;", ""],
  ["M18 given = undefined", D, "        given = undefined;\n", ""],
  ["M17a throttle off", H, "if (now - this.lastModelSavedAt >= 60_000 || now < this.lastModelSavedAt)", "if (true)"],
  ["M17b throttle > (boundary)", H, "now - this.lastModelSavedAt >= 60_000", "now - this.lastModelSavedAt > 60_000"],
  ["M17c clock back", H, " || now < this.lastModelSavedAt", ""],
  ["M17d never saves", H, "if (now - this.lastModelSavedAt >= 60_000 || now < this.lastModelSavedAt)", "if (false)"],
  ["M9 sessionResumed drops clock", H, "started: true, ...(this.session.lastModelAt !== undefined ? { lastModelAt: this.session.lastModelAt } : {}) }; this.briefing = false; }", "started: true }; this.briefing = false; }"],
  ["M13 newSession carries clock", H, "this.session = { sessionId: randomUUID(), started: false };", "this.session = { sessionId: randomUUID(), started: false, ...(this.session.lastModelAt !== undefined ? { lastModelAt: this.session.lastModelAt } : {}) };"],
  ["M14 briefing in cacheCold", H, " || this.briefing || this.lastModelAt === null", " || this.lastModelAt === null"],
  ["M16 started in cacheCold", H, "!this.session.started || this.briefing", "this.briefing"],
  ["M15 adopted TTL", H, "(adopted ? CACHE_TTL_MS : WARM_WINDOW_MS)", "WARM_WINDOW_MS"],
  ["M19 null clock forces", H, " || this.lastModelAt === null) return false;", ") return false;"],
];
const run = () => spawnSync("node_modules/.bin/vitest", ["run", ...FILES], { encoding: "utf8", env: { ...process.env, CI: "1" } });

it("every mutant is killed, the unmutated tree passes", () => {
  const originals = new Map<string, string>();
  for (const f of [D, H]) originals.set(f, readFileSync(f, "utf8"));
  const out: string[] = [];
  let survivors = 0;
  try {
    const base = run();
    out.push(`BASELINE exit ${base.status}`);
    if (base.status !== 0) out.push(base.stdout.slice(-3000));
    for (const [name, file, from, to] of mutants) {
      const src = originals.get(file)!;
      if (src.split(from).length !== 2) { out.push(`${name}: PATTERN NOT UNIQUE/FOUND`); survivors++; continue; }
      writeFileSync(file, src.replace(from, to));
      const r = run();
      writeFileSync(file, src);
      const killed = r.status !== 0;
      if (!killed) survivors++;
      out.push(`${name}: ${killed ? "KILLED" : "SURVIVED"} (exit ${r.status})`);
    }
    expect(base.status).toBe(0);
  } finally {
    for (const [f, text] of originals) writeFileSync(f, text);
    console.log("MUTATION RESULTS\n" + out.join("\n"));
  }
  expect(survivors).toBe(0);
}, 600_000);
