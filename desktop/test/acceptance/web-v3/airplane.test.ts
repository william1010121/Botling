// M2 acceptance check 2 (m2-brief §5): airplane mode, nothing lost, nothing doubled, on the real page (web-v3/dist) in
// headless Chromium and headless WebKit with real IndexedDB, against a real botlingd (fake engine, 127.0.0.1 only).
//
// Per engine, RUNS runs (default 20) of CMDS commands (default 100). Each run has a fresh data folder, a fresh browser
// profile and a fresh pairing, and a seeded fault plan over its commands, with every kind at least once:
//  - offline: `context.setOffline(true)`, a few sends, back online;
//  - reload: the page reloads between two sends;
//  - browser-kill: one send, then at once SIGKILL every process of the browser (its process group and every process
//    holding a file of its profile, as idb-storage.test.ts), then the same profile in a new browser;
//  - server-kill: botlingd SIGKILLed, a few sends, restarted.
// A send counts as accepted when its pending line is on the page (after the outbox write). The send right before a
// browser SIGKILL is "maybe" (the kill may land before its write). At the end of the run, online with the server up:
//  - every accepted command is on the server exactly once (0 acknowledged lost, 0 applied twice);
//  - a "maybe" command is there at most once;
//  - no item was ever shown "not sent" or "lost" (the page's delivery-state record, read before each reload or kill
//    and at the end), and the page shows no "Not sent" line.
// "0 items counted before their IDB complete" is the storage's own guarantee (step 7, idb-storage.test.ts).
//
//   npm run build && node web-v3/build.mjs
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/airplane.test.ts
// Run 1 also times send → delivered for V3_ACCEPT_SPEED_CMDS (default 50) sends first (check 7, reported, not gated).
//   knobs: V3_ACCEPT_RUNS, V3_ACCEPT_CMDS, V3_ACCEPT_SPEED_CMDS, V3_ACCEPT_TRACE=1 (print each fault), V3_ACCEPT_SEED, V3_ENGINES=chromium,webkit
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { writeReport } from "../m1-accept";
import { chatOf, diag, freePort, PairCli, phone, rowsWith, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const RUNS = Number(process.env.V3_ACCEPT_RUNS || 20);
const CMDS = Number(process.env.V3_ACCEPT_CMDS || 100);
const SEED = Number(process.env.V3_ACCEPT_SEED || 20261115);
const report: Record<string, unknown> = { runs: RUNS, commands: CMDS, seed: SEED };
afterAll(() => { writeReport("m2-airplane", report); });

type Fault = "offline" | "reload" | "browser-kill" | "server-kill";
const KINDS: Fault[] = ["offline", "reload", "browser-kill", "server-kill"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Five faults at distinct command positions, every kind at least once, in a seeded order. */
function plan(random: () => number): Map<number, Fault> {
  const kinds = [...KINDS, KINDS[Math.floor(random() * KINDS.length)]!];
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!]; }
  const at = new Set<number>();
  const lo = Math.max(2, Math.floor(CMDS * 0.05)), hi = Math.max(lo + kinds.length, CMDS - 5);
  while (at.size < kinds.length) at.add(lo + Math.floor(random() * (hi - lo)));
  const positions = [...at].sort((x, y) => x - y);
  return new Map(positions.map((p, i) => [p, kinds[i]!]));
}

/** Every process of the browser that uses `profile`: its process group, and any other process holding its files. */
function browserProcesses(profile: string): Array<{ pid: number; command: string }> {
  const rows = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! }));
  const leaders = new Set(rows.filter((row) => row.command.includes(profile)).map((row) => row.pgid));
  const pids = new Set(rows.filter((row) => leaders.has(row.pgid)).map((row) => row.pid));
  const holders = spawnSync("lsof", ["-t", "+D", profile], { encoding: "utf8" }).stdout ?? "";
  for (const pid of holders.split("\n").filter(Boolean)) pids.add(Number(pid));
  pids.delete(process.pid);
  return rows.filter((row) => pids.has(row.pid)).map(({ pid, command }) => ({ pid, command: command.split(" ")[0]!.split("/").pop()! }));
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const text = (run: number, i: number) => `m-r${String(run).padStart(2, "0")}-c${String(i).padStart(3, "0")}`;
const countUser = (messages: { role: string; text: string }[], t: string) => messages.filter((m) => m.role === "user" && m.text === t).length;

/** Puts `t` in the chat page's text box (a contenteditable: `fill` does not send in WebKit). Then `go()` presses Return. */
async function compose(page: Page, t: string): Promise<() => Promise<void>> {
  await chatOf(page).getByRole("textbox", { name: "Message" }).click();
  await page.keyboard.insertText(t);
  return () => page.keyboard.press("Enter");
}
async function send(page: Page, t: string): Promise<void> { await (await compose(page, t))(); }
async function shown(page: Page, t: string): Promise<void> {
  try {
    await expect.poll(() => rowsWith(page, t), { timeout: 30_000 }).toBeGreaterThan(0);
  } catch (error) {
    const box = await chatOf(page).getByRole("textbox", { name: "Message" }).inputValue().catch((e: unknown) => String(e));
    const banner = await page.locator("[data-testid=conn-banner]").textContent({ timeout: 1_000 }).catch(() => "");
    const rows = await chatOf(page).locator("#messages .row").allTextContents().catch(() => []);
    throw new Error(`${t} not shown: box "${box}", banner "${banner}", last rows ${JSON.stringify(rows.slice(-3))}: ${String(error).slice(0, 200)}`);
  }
}

const SPEED = Number(process.env.V3_ACCEPT_SPEED_CMDS || 50);
const delivered = (page: Page) => page.evaluate(() => Object.values((globalThis as unknown as { botling3Diagnostics: { states: Record<string, string[]> } }).botling3Diagnostics.states).filter((s) => s[s.length - 1] === "delivered").length);
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

interface RunResult { speed?: { n: number; medianMs: number; p99Ms: number; maxMs: number; loadAvg: number[] }; run: number; faults: string[]; accepted: number; maybe: number; maybeFound: number; lost: string[]; doubled: string[]; failedShown: string[]; ms: number; killed: string[] }

async function oneRun(engine: string, type: BrowserType, run: number): Promise<RunResult> {
  const random = mulberry32(SEED + run * 7919 + (engine === "webkit" ? 1 : 0));
  const faults = plan(random);
  const root = mkdtempSync(join(TMP, `airplane-${engine}-${run}-`));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const profile = join(root, "profile");
  const server = new Server(dataDir, await freePort());
  const t0 = Date.now();
  const accepted: string[] = [];
  const maybe: string[] = [];
  const failedShown = new Set<string>();
  const killed = new Set<string>();
  let context: BrowserContext | null = null;
  let page: Page;
  const record = async () => {
    for (const states of Object.values((await diag(page)).states)) for (const s of states) if (s === "not sent" || s === "lost") failedShown.add(s);
  };
  const open = async () => {
    ({ context, page } = await phone(type, profile));
    await page.goto(server.page);
    await chatOf(page).locator(".composer").waitFor({ timeout: 60_000 });
    // The chat is drawn from the server's snapshot: until it comes, a new browser shows no lines (a send then shows
    // only in the banner's waiting count), so wait for the last accepted line before going on.
    if (accepted.length) await shown(page, accepted[accepted.length - 1]!);
  };
  try {
    await server.ready();
    ({ context, page } = await phone(type, profile));
    const cli = new PairCli(dataDir);
    const link = await cli.link();
    await page.goto(server.page);
    await page.getByLabel("Pairing link").fill(link);
    await page.getByRole("button", { name: "Pair" }).click();
    await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
    cli.type("y");
    await cli.line((l) => l.startsWith("Paired: "), "paired");
    await chatOf(page).locator(".composer").waitFor({ timeout: 30_000 });

    // Check 7 (reported, not gated), run 1 only: send → delivered over the loopback WebSocket, one at a time while the
    // fake engine streams its replies (the load), timed in the page from Enter to the item's `delivered` state.
    let speed: RunResult["speed"];
    if (run === 1 && SPEED > 0) {
      const times: number[] = [];
      for (let k = 1; k <= SPEED; k++) {
        const t = `s-r01-c${String(k).padStart(3, "0")}`;
        const before = await delivered(page);
        const go = await compose(page, t);
        const start = Date.now();
        await go();
        await page.waitForFunction((n) => Object.values((globalThis as unknown as { botling3Diagnostics: { states: Record<string, string[]> } }).botling3Diagnostics.states).filter((s) => s[s.length - 1] === "delivered").length > n, before, { polling: 5, timeout: 30_000 });
        times.push(Date.now() - start);
        accepted.push(t);
      }
      const sorted = [...times].sort((x, y) => x - y);
      speed = { n: sorted.length, medianMs: pct(sorted, 50), p99Ms: pct(sorted, 99), maxMs: sorted[sorted.length - 1]!, loadAvg: (await import("node:os")).loadavg().map((x) => Number(x.toFixed(1))) };
    }

    let i = 0;
    const next = async () => { const t = text(run, ++i); await send(page, t); await shown(page, t); accepted.push(t); };
    while (i < CMDS) {
      const fault = faults.get(i + 1);
      if (!fault) { await next(); continue; }
      const burst = 2 + Math.floor(random() * 4);
      if (process.env.V3_ACCEPT_TRACE) console.log(`run ${run} at ${i + 1}: ${fault}`);
      if (fault === "offline") {
        await context!.setOffline(true);
        for (let k = 0; k < burst && i < CMDS; k++) await next();
        await context!.setOffline(false);
      } else if (fault === "reload") {
        await record();
        await page.reload();
        await chatOf(page).locator(".composer").waitFor({ timeout: 60_000 });
        if (accepted.length) await shown(page, accepted[accepted.length - 1]!);
        await next();
      } else if (fault === "server-kill") {
        await server.stop("SIGKILL");
        for (let k = 0; k < burst && i < CMDS; k++) await next();
        await server.restart();
      } else {
        await record();
        const t = text(run, ++i);
        await send(page, t);
        const targets = browserProcesses(profile);
        for (const { pid } of targets) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        for (const { command } of targets) killed.add(command);
        maybe.push(t);
        for (let w = 0; w < 100 && targets.some(({ pid }) => alive(pid)); w++) await new Promise((r) => setTimeout(r, 50));
        await (context as BrowserContext | null)?.close().catch(() => undefined);
        await open();
      }
    }
    // Settle: online, server up; every accepted command reaches the server.
    await expect.poll(async () => { const m = await server.messages(); return accepted.filter((t) => countUser(m, t) === 0).length; }, { timeout: 120_000, interval: 1_000 }).toBe(0);
    await page.waitForTimeout(2_000);
    await record();
    const messages = await server.messages();
    const users = messages.filter((m) => m.role === "user").map((m) => m.text);
    const lost = accepted.filter((t) => countUser(messages, t) === 0);
    const doubled = [...new Set(users.filter((t, k) => users.indexOf(t) !== k))];
    const strange = users.filter((t) => !accepted.includes(t) && !maybe.includes(t));
    if (await chatOf(page).getByText(/Not sent/).count()) failedShown.add("Not sent line on the page");
    if (strange.length) doubled.push(...strange.map((t) => `unexpected ${t}`));
    return { ...(speed ? { speed } : {}), run, faults: [...faults].map(([at, f]) => `${at}:${f}`), accepted: accepted.length, maybe: maybe.length, maybeFound: maybe.filter((t) => countUser(messages, t) === 1).length, lost, doubled, failedShown: [...failedShown], ms: Date.now() - t0, killed: [...killed] };
  } finally {
    await (context as BrowserContext | null)?.close().catch(() => undefined);
    await server.stop("SIGTERM").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe(`M2 check 2: airplane mode on the page, ${RUNS} runs × ${CMDS} commands (headless, real IndexedDB)`, () => {
  for (const [engine, type] of ENGINES) {
    it(`${engine}: 0 accepted lost, 0 applied twice, 0 shown failed`, async () => {
      const runs: RunResult[] = [];
      const summary: Record<string, unknown> = { runs };
      report[engine] = summary;
      for (let run = 1; run <= RUNS; run++) {
        const result = await oneRun(engine, type, run);
        runs.push(result);
        if (result.speed) console.log(`${engine} send → delivered: median ${result.speed.medianMs} ms, p99 ${result.speed.p99Ms} ms, max ${result.speed.maxMs} ms (n ${result.speed.n}, load ${result.speed.loadAvg.join(" ")})`);
        console.log(`${engine} run ${run}: ${result.accepted} accepted, maybe ${result.maybeFound}/${result.maybe}, lost ${result.lost.length}, doubled ${result.doubled.length}, failed shown ${result.failedShown.length}, ${result.ms} ms [${result.faults.join(" ")}]`);
        expect(result.lost, `run ${run}`).toEqual([]);
        expect(result.doubled, `run ${run}`).toEqual([]);
        expect(result.failedShown, `run ${run}`).toEqual([]);
      }
      Object.assign(summary, {
        accepted: runs.reduce((s, r) => s + r.accepted, 0), lost: 0, doubled: 0, failedShown: 0,
        maybe: runs.reduce((s, r) => s + r.maybe, 0), maybeFound: runs.reduce((s, r) => s + r.maybeFound, 0),
        faults: Object.fromEntries(KINDS.map((k) => [k, runs.reduce((s, r) => s + r.faults.filter((f) => f.endsWith(`:${k}`)).length, 0)])),
        killed: [...new Set(runs.flatMap((r) => r.killed))], ms: runs.reduce((s, r) => s + r.ms, 0), speed: runs[0]?.speed,
      });
    }, 4 * 3_600_000);
  }
});
