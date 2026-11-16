// M7-08 (plan-change §4.3 check 1): the shell alone passes the airplane check. The M2 airplane-mode script (airplane.test.ts), run against a
// page built with NO in-page plugin (an empty FE-build manifest: the shell's loader refuses every built-in) and a botlingd with NO plugin rows
// (an empty built-in plugins folder, a fresh data folder; the two library rows every data folder has, plugin:ccb-core and plugin:ccb-components,
// have no web part and are the only ones): the page is the shell and its fallback screen (shell/Fallback.tsx), and every message
// goes in through the fallback's plain box. Same counts as M2: every accepted command is on the server exactly once (0 lost, 0 applied
// twice), a "maybe" (the send right before a browser SIGKILL) at most once, nothing ever shown "not sent" or "lost".
//
// What the page is built with and served from (a temp folder, the repo's web-v3/dist is not touched):
//   - `buildPage({ out, noPlugins: true })` (web-v3/build.mjs): the same page, its manifest lists no plugin;
//   - a copy of the built server (out/server/*) beside that page, `out/` of the repo linked for the rest, and an empty `builtin-plugins`
//     folder: botlingd serves `<copy>/../web-v3/dist` and installs no built-in plugin, so the server has no framed `plugin:` row.
// Before the script runs, each run checks the setup (the "shell alone" part below): no `plugin:` row but the app's library on the server, no frame on the page, the
// loader's refusal of each plugin the shell draws a surface for, the fallback where the chat was, and the shell's own sheet ("This device")
// reachable through the drawer. A run whose page is not the shell alone fails there, before any command counts.
//
//   npm run build        (the page is built by this file)
//   PLAYWRIGHT_BROWSERS_PATH=<the Playwright cache> npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/web-v3/shell-alone-airplane.test.ts
//   only the setup check: add `-t "shell alone"`.
//   knobs: V3_ACCEPT_RUNS (5), V3_ACCEPT_CMDS (100), V3_ACCEPT_SEED, V3_ACCEPT_TRACE=1, V3_ENGINES=chromium,webkit (default: both)
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, webkit, type BrowserContext, type BrowserType, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHELL_PLUGINS } from "../../../src/renderer/shell/shell-plugins";
import { desktop } from "../../helpers";
import { writeReport } from "../m1-accept";
import { alive, browserProcesses, KINDS, mulberry32, plan } from "./airplane-faults";
import { diag, freePort, PairCli, phone, Server } from "./page-harness";

const TMP = process.env.V3_PAGE_TMP || (existsSync("/Volumes/My-SSD/botling-work/tmp") ? "/Volumes/My-SSD/botling-work/tmp" : tmpdir());
const ALL = [["chromium", chromium], ["webkit", webkit]] as const;
const ENGINES = ALL.filter(([name]) => !process.env.V3_ENGINES || process.env.V3_ENGINES.split(",").includes(name));
const RUNS = Number(process.env.V3_ACCEPT_RUNS || 5);
const CMDS = Number(process.env.V3_ACCEPT_CMDS || 100);
const SEED = Number(process.env.V3_ACCEPT_SEED || 20261116);
const report: Record<string, unknown> = { runs: RUNS, commands: CMDS, seed: SEED, engines: ENGINES.map(([name]) => name) };
afterAll(() => { writeReport("m7-shell-alone-airplane", report); });

// ---- the shell-alone setup: a page with no plugin, a server with no plugin row ----

interface Build { root: string; script: string }
let build: Build | null = null;

/** Builds the empty-manifest page and the server copy beside it. */
async function makeBuild(): Promise<Build> {
  const root = mkdtempSync(join(TMP, "shell-alone-build-"));
  const { buildPage } = await import("../../../web-v3/build.mjs");
  await buildPage({ out: join(root, "web-v3", "dist"), noPlugins: true });
  const out = join(desktop, "out");
  const mirror = join(root, "out");
  mkdirSync(join(mirror, "server"), { recursive: true });
  mkdirSync(join(mirror, "builtin-plugins"));
  for (const name of readdirSync(out)) if (name !== "server" && name !== "builtin-plugins") symlinkSync(join(out, name), join(mirror, name));
  // The server's own folder is copied (its main.cjs finds its files by __dirname, which a link would resolve back to the repo's out/).
  for (const name of readdirSync(join(out, "server"))) {
    if (name.endsWith(".map")) continue;
    const from = join(out, "server", name);
    if (statSync(from).isDirectory()) cpSync(from, join(mirror, "server", name), { recursive: true }); else copyFileSync(from, join(mirror, "server", name));
  }
  return { root, script: join(mirror, "server", "main.cjs") };
}
beforeAll(async () => { build = await makeBuild(); }, 600_000);
afterAll(() => { if (build) rmSync(build.root, { recursive: true, force: true }); });

/** The plugins the app writes into every data folder as its own library (no web part, nothing a page runs): the only `plugin:` rows a server with no plugin installed has. */
const LIBRARY_ROWS = ["plugin:ccb-components", "plugin:ccb-core"];

/**
 * The server's `plugin:` rows that are not the app's library: none on a server with no plugin installed. A row with a web part (`files.web`) is
 * a framed plugin row; it is named as such.
 */
function pluginRows(dataDir: string): string[] {
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const rows = db.prepare("SELECT key, body FROM rows WHERE deleted = 0 AND substr(key, 1, 7) = 'plugin:' ORDER BY key").all() as { key: string; body: unknown }[];
    return rows.filter((row) => !LIBRARY_ROWS.includes(row.key)).map((row) => {
      let web = false;
      try { web = typeof (JSON.parse(String(row.body)) as { files?: { web?: unknown } }).files?.web === "string"; } catch { /* a body that is not JSON has no web part */ }
      return web ? `${row.key} (framed)` : row.key;
    });
  } finally { db.close(); }
}

const FALLBACK_BOX = "textarea[aria-label=Message]";
const lineRows = (page: Page, t: string) => page.locator(".fallback-lines li").filter({ hasText: t }).count();

/** What the page logged about the in-page loader (console warnings), kept per page. */
function watchLoader(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") lines.push(message.text()); });
  return lines;
}

/** A bot is open in the fallback (its box can send): the snapshot has come. */
async function botOpen(page: Page): Promise<void> {
  await page.locator(".fallback-bots button[aria-pressed=true]").first().waitFor({ timeout: 60_000 });
}

/** Waits for the fallback (the page's chat column is the shell's own screen) and an open bot. */
async function fallbackUp(page: Page): Promise<void> {
  await page.locator(`.chat-fallback ${FALLBACK_BOX}`).waitFor({ timeout: 60_000 });
  await botOpen(page);
}

/** The page is the shell alone: nothing a plugin draws, the fallback where the chat was, the shell's sheet reachable. */
async function assertShellAlone(page: Page, dataDir: string, loader: string[], { sheet = false } = {}): Promise<void> {
  expect(pluginRows(dataDir), "the server has a plugin row besides the app's library").toEqual([]);
  await fallbackUp(page);
  expect(await page.locator("iframe").count(), "a frame on the page").toBe(0);
  expect(await page.locator("#chat-frame, .chat-frame").count(), "the chat page").toBe(0);
  expect(await page.locator(".chat-fallback [role=status]").first().textContent()).toBe("Chat is unavailable.");
  expect(await page.locator("aside.rail.rail-unavailable").count(), "the rail's unavailable line").toBe(1);
  expect(await page.locator(".bot-row, .rail-search").count(), "the sidebar plugin's rail").toBe(0);
  const refused = () => [...new Set(loader.map((line) => /in-page loader refused "([^"]+)"/.exec(line)?.[1]).filter((name): name is string => !!name))].sort();
  await expect.poll(refused, { timeout: 30_000 }).toEqual([...SHELL_PLUGINS].sort());
  expect(loader.filter((line) => /failed to load|in-page plugin/.test(line)), "a plugin ran or failed").toEqual([]);
  if (!sheet) return;
  // The shell's own sheet: the drawer button in the fallback's header opens the rail's line, which holds "This device".
  await page.locator(".chat-fallback .web-nav-button").click();
  await page.locator("aside.rail-unavailable .web-rail-footer button", { hasText: "This device" }).click();
  await page.getByRole("dialog", { name: "This device" }).waitFor({ timeout: 15_000 });
  await page.locator(".v3-sheet-scrim").click({ position: { x: 4, y: 4 } });
  await page.getByRole("dialog", { name: "This device" }).waitFor({ state: "detached", timeout: 15_000 });
  // Close the drawer again (its scrim would cover the box): a tap beside it.
  await page.locator(".web-scrim").click({ position: { x: 350, y: 400 } });
  await page.locator(".web-root[data-nav=closed]").waitFor({ timeout: 15_000 });
}

/** Pairs a fresh browser with `server` through the pairing sheet. */
async function pairPage(page: Page, server: Server, dataDir: string): Promise<void> {
  const cli = new PairCli(dataDir);
  const link = await cli.link();
  await page.goto(server.page);
  await page.getByLabel("Pairing link").fill(link);
  await page.getByRole("button", { name: "Pair" }).click();
  await page.getByTestId("pair-code").waitFor({ timeout: 30_000 });
  cli.type("y");
  await cli.line((l) => l.startsWith("Paired: "), "paired");
  await fallbackUp(page);
}

const newServer = async (dataDir: string) => {
  const server = new Server(dataDir, await freePort(), { BOTLING_BUILTIN_PLUGINS: join(build!.root, "out", "builtin-plugins") }, build!.script);
  await server.ready();
  return server;
};

// ---- the airplane script (airplane.test.ts, through the fallback's box) ----

const text = (run: number, i: number) => `s-r${String(run).padStart(2, "0")}-c${String(i).padStart(3, "0")}`;
const countUser = (messages: { role: string; text: string }[], t: string) => messages.filter((m) => m.role === "user" && m.text === t).length;

/** Puts `t` in the fallback's box (once the last send has left it and its button is back: the box refuses a second send while one is in flight). Then `go()` presses Return. */
async function compose(page: Page, t: string): Promise<() => Promise<void>> {
  const box = page.locator(FALLBACK_BOX);
  await expect.poll(async () => (await box.inputValue()) === "" && (await page.getByRole("button", { name: "Send" }).isEnabled()), { timeout: 30_000, interval: 20 }).toBe(true);
  await box.click();
  await page.keyboard.insertText(t);
  return () => page.keyboard.press("Enter");
}
async function send(page: Page, t: string): Promise<void> { await (await compose(page, t))(); }
async function shown(page: Page, t: string): Promise<void> {
  try {
    await expect.poll(() => lineRows(page, t), { timeout: 30_000 }).toBeGreaterThan(0);
  } catch (error) {
    const box = await page.locator(FALLBACK_BOX).inputValue().catch((e: unknown) => String(e));
    const banner = await page.locator("[data-testid=conn-banner]").textContent({ timeout: 1_000 }).catch(() => "");
    const alert = await page.locator(".fallback-problem").textContent({ timeout: 1_000 }).catch(() => "");
    const rows = await page.locator(".fallback-lines li").allTextContents().catch(() => []);
    throw new Error(`${t} not shown: box "${box}", banner "${banner}", problem "${alert}", last rows ${JSON.stringify(rows.slice(-3))}: ${String(error).slice(0, 200)}`);
  }
}

interface RunResult { run: number; faults: string[]; accepted: number; maybe: number; maybeFound: number; lost: string[]; doubled: string[]; failedShown: string[]; refused: string[]; ms: number; killed: string[] }

async function oneRun(engine: string, type: BrowserType, run: number): Promise<RunResult> {
  const random = mulberry32(SEED + run * 7919 + (engine === "webkit" ? 1 : 0));
  const faults = plan(random, CMDS);
  const root = mkdtempSync(join(TMP, `shell-alone-${engine}-${run}-`));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const profile = join(root, "profile");
  const t0 = Date.now();
  const accepted: string[] = [];
  const maybe: string[] = [];
  const failedShown = new Set<string>();
  const killed = new Set<string>();
  const done: string[] = [];
  const refusedBy = new Set<string>();
  let context: BrowserContext | null = null;
  let page: Page;
  let loader: string[] = [];
  let server: Server | null = null;
  const record = async () => {
    for (const states of Object.values((await diag(page)).states)) for (const s of states) if (s === "not sent" || s === "lost") failedShown.add(s);
  };
  const open = async () => {
    ({ context, page } = await phone(type, profile));
    loader = watchLoader(page);
    await page.goto(server!.page);
    await fallbackUp(page);
    // A new browser draws the chat from the server's snapshot: wait for the last accepted line before going on.
    if (accepted.length) await shown(page, accepted[accepted.length - 1]!);
  };
  try {
    server = await newServer(dataDir);
    ({ context, page } = await phone(type, profile));
    loader = watchLoader(page);
    await pairPage(page, server, dataDir);
    await assertShellAlone(page, dataDir, loader, { sheet: run === 1 });
    for (const name of loader.map((line) => /in-page loader refused "([^"]+)"/.exec(line)?.[1])) if (name) refusedBy.add(name);

    let i = 0;
    const next = async () => { const t = text(run, ++i); await send(page, t); await shown(page, t); accepted.push(t); };
    // A fault's burst sends several commands, which may pass the next planned position: each fault fires at the first command at or after its
    // position (after the last command if need be), so every planned fault is done, and `done` records where it really happened.
    const due = [...faults].sort(([x], [y]) => x - y);
    while (i < CMDS || done.length < due.length) {
      const [at, fault] = due[done.length] ?? [Infinity, undefined];
      if (!fault || i + 1 < at) { await next(); continue; }
      done.push(`${i + 1}:${fault}`);
      const burst = 2 + Math.floor(random() * 4);
      if (process.env.V3_ACCEPT_TRACE) console.log(`run ${run} at ${i + 1}: ${fault}`);
      if (fault === "offline") {
        await context!.setOffline(true);
        for (let k = 0; k < burst; k++) await next();
        await context!.setOffline(false);
      } else if (fault === "reload") {
        await record();
        await page.reload();
        await fallbackUp(page);
        if (accepted.length) await shown(page, accepted[accepted.length - 1]!);
        await next();
      } else if (fault === "server-kill") {
        await server.stop("SIGKILL");
        for (let k = 0; k < burst; k++) await next();
        await server.restart();
      } else {
        await record();
        const t = text(run, ++i);
        await send(page, t);
        const targets = browserProcesses(profile);
        if (!targets.length) throw new Error(`run ${run}: browser-kill found no process of the browser`);
        for (const { pid } of targets) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        for (const { command } of targets) killed.add(command);
        maybe.push(t);
        for (let w = 0; w < 100 && targets.some(({ pid }) => alive(pid)); w++) await new Promise((r) => setTimeout(r, 50));
        await (context as BrowserContext | null)?.close().catch(() => undefined);
        await open();
      }
    }
    // Settle: online, server up; every accepted command reaches the server.
    await expect.poll(async () => { const m = await server!.messages(); return accepted.filter((t) => countUser(m, t) === 0).length; }, { timeout: 120_000, interval: 1_000 }).toBe(0);
    await page.waitForTimeout(2_000);
    await record();
    // Still the shell alone at the end: no frame came, no plugin row appeared.
    expect(pluginRows(dataDir), "a plugin row appeared besides the app's library").toEqual([]);
    expect(await page.locator("iframe").count(), "a frame appeared").toBe(0);
    const messages = await server.messages();
    const users = messages.filter((m) => m.role === "user").map((m) => m.text);
    const lost = accepted.filter((t) => countUser(messages, t) === 0);
    const doubled = [...new Set(users.filter((t, k) => users.indexOf(t) !== k))];
    const strange = users.filter((t) => !accepted.includes(t) && !maybe.includes(t));
    if (await page.getByText(/Not sent/).count()) failedShown.add("Not sent line on the page");
    if (strange.length) doubled.push(...strange.map((t) => `unexpected ${t}`));
    return { run, faults: done, accepted: accepted.length, maybe: maybe.length, maybeFound: maybe.filter((t) => countUser(messages, t) === 1).length, lost, doubled, failedShown: [...failedShown], refused: [...refusedBy].sort(), ms: Date.now() - t0, killed: [...killed] };
  } finally {
    await (context as BrowserContext | null)?.close().catch(() => undefined);
    await server?.stop("SIGTERM").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("M7-08: the shell alone", () => {
  for (const [engine, type] of ENGINES) {
    it(`${engine}: the shell alone shows the fallback, no frame and no plugin row, and its own sheet opens`, async () => {
      const root = mkdtempSync(join(TMP, `shell-alone-setup-${engine}-`));
      const dataDir = join(root, "data");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      let context: BrowserContext | null = null;
      let server: Server | null = null;
      try {
        server = await newServer(dataDir);
        let page: Page;
        ({ context, page } = await phone(type, join(root, "profile")));
        const loader = watchLoader(page);
        await pairPage(page, server, dataDir);
        await assertShellAlone(page, dataDir, loader, { sheet: true });
        // One message through the fallback reaches the server once.
        await send(page, "setup-1");
        await shown(page, "setup-1");
        await expect.poll(async () => countUser(await server!.messages(), "setup-1"), { timeout: 30_000 }).toBe(1);
      } finally {
        await context?.close().catch(() => undefined);
        await server?.stop("SIGTERM").catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    }, 600_000);
  }
});

describe(`M7-08 / M2 check 2 through the fallback: airplane mode with no plugin, ${RUNS} runs × ${CMDS} commands (headless, real IndexedDB)`, () => {
  for (const [engine, type] of ENGINES) {
    it(`${engine}: 0 accepted lost, 0 applied twice, 0 shown failed`, async () => {
      const runs: RunResult[] = [];
      const summary: Record<string, unknown> = { runs };
      report[engine] = summary;
      for (let run = 1; run <= RUNS; run++) {
        const result = await oneRun(engine, type, run);
        runs.push(result);
        console.log(`${engine} run ${run}: ${result.accepted} accepted, maybe ${result.maybeFound}/${result.maybe}, lost ${result.lost.length}, doubled ${result.doubled.length}, failed shown ${result.failedShown.length}, ${result.ms} ms [${result.faults.join(" ")}]`);
        expect(result.lost, `run ${run}`).toEqual([]);
        expect(result.doubled, `run ${run}`).toEqual([]);
        expect(result.failedShown, `run ${run}`).toEqual([]);
      }
      Object.assign(summary, {
        accepted: runs.reduce((s, r) => s + r.accepted, 0), lost: 0, doubled: 0, failedShown: 0,
        maybe: runs.reduce((s, r) => s + r.maybe, 0), maybeFound: runs.reduce((s, r) => s + r.maybeFound, 0),
        faults: Object.fromEntries(KINDS.map((k) => [k, runs.reduce((s, r) => s + r.faults.filter((f) => f.endsWith(`:${k}`)).length, 0)])),
        killed: [...new Set(runs.flatMap((r) => r.killed))], ms: runs.reduce((s, r) => s + r.ms, 0),
      });
    }, 4 * 3_600_000);
  }
});
