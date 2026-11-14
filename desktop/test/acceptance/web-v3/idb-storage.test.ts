// M2 step 7: the IndexedDB front-end storage (src/fe-link/idb-storage.ts, D45) in headless Chromium (the headless shell)
// and headless WebKit, from the Playwright browsers already installed. Nothing is downloaded, no window is opened, no port
// is opened (the page is served by Playwright's request routing on http://localhost, a secure context).
//
//  1. M1's fe-link storage tests (test/fe-storage-cases.ts) run against IndexedDB, with a check that no write resolves
//     before its transaction's `complete`.
//  2. Crash: a page writes outbox items one write each; right after item k's write resolved (`complete`) the page reports
//     it and the test SIGKILLs every process of the browser (its process group, plus WebKit's XPC helpers that hold the
//     profile's files). On reopen with the same profile every counted item is there, the counter matches the last item
//     (all or nothing), and nothing was reported before its `complete`. CRASH_RUNS runs per engine (default 20).
//
// Profiles are temporary folders under V3_IDB_TMP (default /Volumes/My-SSD/botling-work/tmp when it exists, else the OS
// temp folder), deleted after each run.
//
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/idb-storage.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { desktop } from "../../helpers";
import { writeReport } from "../m1-accept";
import type { CaseResult } from "../../fe-storage-cases";
import type { StoredState } from "../../../src/fe-link";

const RUNS = Number(process.env.CRASH_RUNS || 20);
const TMP = process.env.V3_IDB_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ENGINES = [["chromium", chromium], ["webkit", webkit]] as const;
const ORIGIN = "http://localhost";

let script: Promise<string> | null = null;
function bundle(): Promise<string> {
  script ??= build({
    entryPoints: [join(desktop, "test/fe-storage-page.ts")],
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", logLevel: "silent",
  }).then((result) => result.outputFiles[0]!.text);
  return script;
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>idb storage</title></head><body><script src="/page.js"></script></body></html>`;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BOTLING_"))) as Record<string, string>;

async function preparePage(context: BrowserContext): Promise<Page> {
  const code = await bundle();
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/page.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: code });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
    return route.fulfill({ status: 404, body: "" });
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  return page;
}

async function launch(type: BrowserType, profile: string): Promise<BrowserContext> {
  return type.launchPersistentContext(profile, { headless: true, env: cleanEnv() });
}

/** Every process of the browser that uses `profile`: its process group, and any other process holding the profile's files. */
function browserProcesses(profile: string): Array<{ pid: number; command: string }> {
  const rows = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }));
  const leaders = new Set(rows.filter((row) => row.command.includes(profile)).map((row) => row.pgid));
  const pids = new Set(rows.filter((row) => leaders.has(row.pgid)).map((row) => row.pid));
  // lsof exits 1 when some file could not be listed, with the found pids on stdout all the same.
  const holders = spawnSync("lsof", ["-t", "+D", profile], { encoding: "utf8" }).stdout ?? "";
  for (const pid of holders.split("\n").filter(Boolean)) pids.add(Number(pid));
  pids.delete(process.pid);
  return rows.filter((row) => pids.has(row.pid)).map(({ pid, command }) => ({ pid, command: command.split(" ")[0]!.split("/").pop()! }));
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function storageCases(name: string, type: BrowserType) {
  const profile = mkdtempSync(join(TMP, `idb-cases-${name}-`));
  try {
    const context = await launch(type, profile).catch((error: unknown) => {
      throw new Error(`${name} could not start (not installed in the Playwright cache?): ${String(error).split("\n")[0]}`);
    });
    try {
      const page = await preparePage(context);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const results = await page.evaluate(() => (window as unknown as { __storageCases(): Promise<CaseResult[]> }).__storageCases());
      return { engine: name, version: context.browser()?.version() ?? "", userAgent: await page.evaluate(() => navigator.userAgent), errors, results };
    } finally {
      await context.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

interface CrashRun { run: number; killAt: number; counted: number; reportedBeforeComplete: number; found: number; counter: number | null; killed: string[]; ok: boolean; detail: string }

async function crashRun(type: BrowserType, run: number): Promise<CrashRun> {
  const profile = mkdtempSync(join(TMP, `idb-crash-`));
  const db = "botling3-fe-crash";
  const epoch = run.toString(16).padStart(32, "0");
  const killAt = 1 + ((run * 13) % 40); // spread over the first 40 items
  let counted = 0;
  let early = 0;
  let killed: Array<{ pid: number; command: string }> = [];
  try {
    const context = await launch(type, profile);
    let done!: () => void;
    const fired = new Promise<void>((resolve) => { done = resolve; });
    let targets: Array<{ pid: number; command: string }> = [];
    await context.exposeBinding("__counted", (_source, n: number, afterComplete: boolean) => {
      if (!afterComplete) early += 1;
      if (n !== counted + 1) early += 1; // a gap or a repeat would mean a count out of order
      counted = Math.max(counted, n);
      if (n === killAt && !killed.length) {
        // Right after item k's `complete`: SIGKILL every process of the browser at once.
        for (const { pid } of targets) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
        killed = targets;
        done();
      }
    });
    const page = await preparePage(context);
    // The storage opened once (the profile's IndexedDB files exist) before the processes holding them are listed.
    await page.evaluate(async (name) => { await (window as unknown as { __load(n: string): Promise<unknown> }).__load(name); }, db);
    targets = browserProcesses(profile);
    void page.evaluate(([name, e]) => (window as unknown as { __crashLoop(n: string, e: string): Promise<void> }).__crashLoop(name, e), [db, epoch] as const).catch(() => undefined);
    await Promise.race([fired, new Promise((_, reject) => setTimeout(() => reject(new Error(`item ${killAt} was never counted (counted ${counted})`)), 60_000))]);
    for (let i = 0; i < 100 && killed.some(({ pid }) => alive(pid)); i += 1) await new Promise((r) => setTimeout(r, 50));
    const survivors = killed.filter(({ pid }) => alive(pid));
    await context.close().catch(() => undefined);
    if (survivors.length) throw new Error(`still running after SIGKILL: ${survivors.map((s) => s.command).join(", ")}`);

    const reopened = await launch(type, profile);
    try {
      const page2 = await preparePage(reopened);
      const state = await page2.evaluate((name) => (window as unknown as { __load(n: string): Promise<StoredState> }).__load(name), db) as StoredState;
      const ns = state.items.map((item) => item.slot.n).sort((a, b) => a - b);
      const found = ns.length;
      const counter = state.counters["bot:b1"] ?? null;
      const problems: string[] = [];
      if (state.epoch !== epoch) problems.push(`epoch ${String(state.epoch)}`);
      if (!ns.every((n, i) => n === i + 1)) problems.push(`items not 1..${found}: ${ns.join(",")}`);
      if (found < counted) problems.push(`${counted - found} counted item(s) lost`);
      if (found > 0 && counter !== found + 1) problems.push(`counter ${String(counter)} with ${found} items (not all or nothing)`);
      for (const item of state.items) {
        const text = (item.cmd as unknown as { text: string }).text;
        if (text !== `message ${item.slot.n} ${"x".repeat((item.slot.n * 37) % 1500)}` || item.slot.originEpoch !== epoch) problems.push(`item ${item.slot.n} damaged`);
      }
      if (early) problems.push(`${early} item(s) reported before complete or out of order`);
      if (!killed.some((k) => /Networking/.test(k.command)) && /pw_run|Playwright/.test(killed.map((k) => k.command).join(" "))) problems.push("WebKit's network process (it holds the IndexedDB files) was not killed");
      return { run, killAt, counted, reportedBeforeComplete: early, found, counter, killed: killed.map((k) => k.command), ok: problems.length === 0, detail: problems.join("; ") || "ok" };
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

describe("IndexedDB front-end storage in headless browsers", () => {
  for (const [name, type] of ENGINES) {
    it(`${name}: M1's fe-link storage tests pass on IndexedDB`, async () => {
      const report = await storageCases(name, type);
      const file = writeReport(`idb-storage-cases-${name}`, report);
      const failed = report.results.filter((result) => !result.ok);
      console.log(`${name} ${report.version}: ${report.results.length - failed.length}/${report.results.length} cases passed (report ${file})`);
      for (const result of failed) console.log(`  FAILED ${result.name}: ${result.detail}`);
      expect(report.errors).toEqual([]);
      expect(report.results.length).toBe(3);
      expect(failed).toEqual([]);
    }, 120_000);

    it(`${name}: SIGKILL right after an item's complete loses nothing counted (${RUNS} runs)`, async () => {
      const runs: CrashRun[] = [];
      const started = Date.now();
      for (let run = 1; run <= RUNS; run += 1) {
        const result = await crashRun(type, run);
        runs.push(result);
        if (!result.ok) console.log(`  run ${run} FAILED: ${result.detail}`);
      }
      const summary = {
        engine: name, runs: runs.length, passed: runs.filter((r) => r.ok).length,
        countedLost: runs.reduce((sum, r) => sum + Math.max(0, r.counted - r.found), 0),
        reportedBeforeComplete: runs.reduce((sum, r) => sum + r.reportedBeforeComplete, 0),
        inFlightKept: runs.filter((r) => r.found > r.counted).length,
        killedProcesses: [...new Set(runs.flatMap((r) => r.killed))],
        seconds: Math.round((Date.now() - started) / 1000),
      };
      const file = writeReport(`idb-crash-${name}`, { summary, runs });
      console.log(`${name}: ${summary.passed}/${summary.runs} crash runs passed, ${summary.countedLost} counted lost, ${summary.reportedBeforeComplete} reported early, in-flight write kept in ${summary.inFlightKept}; killed ${summary.killedProcesses.join(", ")} (report ${file})`);
      expect(summary.countedLost).toBe(0);
      expect(summary.reportedBeforeComplete).toBe(0);
      expect(runs.filter((r) => !r.ok)).toEqual([]);
    }, 900_000);
  }
});
