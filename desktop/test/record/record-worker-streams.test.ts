// Records the real CLIs' worker streams for the shared worker core's contract suite (shared-core spec §5.1).
// Opt-in and never in the default run: `BOTLING_RECORD_STREAMS=<raw folder> npm run test:record`. It spends a
// little usage (small prompts). Each scenario runs in a new empty folder under BOTLING_RECORD_TMP (default
// /Volumes/My-SSD/botling-work/recordings/tmp), with the same CLI arguments the app uses: the real ClaudeWorkers
// (claude worker profile), the real CodexHead (app-server worker thread, handed off by its coordinator), the
// component editor's launch config (maintainerEditorBinding) and the real AgyWorkers (ACP worker profile).
//
// The recording point is each process's stdin/stdout: every ProcessTreeAdapter the heads get is a TeeTreeAdapter
// around the real one (AgyAcpHead takes none yet, so process/tree is mocked here for it). Each process is written
// to <raw>/<engine>/<scenario>.p<n>.jsonl: a header line, then one line per stream line,
//   {"t": <ms since the scenario started>, "d": "in" | "out" | "err" | "exit", "l": "<raw line>"}
// ("err": stderr; "exit": {"code","signal"} when the process closed). What the app made of it (the engine's items
// and reports as they are today) goes to <scenario>.items.jsonl beside it, for checking the expectations by hand.
// Raw recordings may hold paths and account details: they stay out of git. scripts/scrub-worker-streams.mjs makes
// the fixtures in test/fixtures/worker-streams from them.
//
// Filters (comma lists): BOTLING_RECORD_ENGINES (claude,codex,editor,agy), BOTLING_RECORD_SCENARIOS.
import { afterAll, describe, expect, inject, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ManagedProcess, ProcessTreeAdapter } from "../../src/core/process/tree";

/** The sink every TeeTreeAdapter writes to: the scenario being recorded (null: nothing is recorded). */
const tap = vi.hoisted(() => {
  type Sink = { open(command: string, args: string[], managed: { pid: number; child: any }): void };
  const state = { current: null as Sink | null };
  /** A ProcessTreeAdapter that spawns through the real one and hands every process to the current sink. */
  class TeeTreeAdapter {
    constructor(private inner: { platform: string; verified: boolean; spawn(command: string, args: string[], options: any): any }) {}
    get platform() { return this.inner.platform; }
    get verified() { return this.inner.verified; }
    spawn(command: string, args: string[], options: any) {
      const managed = this.inner.spawn(command, args, options);
      state.current?.open(command, args, managed);
      return managed;
    }
  }
  return { state, TeeTreeAdapter };
});

vi.mock("../../src/core/process/tree", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/process/tree")>();
  return { ...real, processTreeAdapter: (platform?: NodeJS.Platform) => new tap.TeeTreeAdapter(real.processTreeAdapter(platform)) as ProcessTreeAdapter };
});

// After the mock: these modules get the teeing processTreeAdapter.
const { processTreeAdapter } = await import("../../src/core/process/tree");
const { ClaudeHead, claudeSessionPermissionConfig } = await import("../../src/core/agent/head");
const { ClaudeWorkers } = await import("../../src/core/agent/claude-workers");
const { CodexHead, CodexThreads } = await import("../../src/core/agent/codex");
const { maintainerEditorBinding } = await import("../../src/core/agent/component-editor");
const { componentEditorAgent } = await import("../../src/core/maintainer-text");
const { AgyAcpHead } = await import("../../src/core/agent/agy-acp");
const { AgyWorkers } = await import("../../src/core/agent/agy-workers");
const { createAgyWorkerHead } = await import("../../src/core/agent/agy-worker-router");
const { validateAgyRuntimePath } = await import("../../src/core/agy-runtime-settings");
const { codexWorkerInstructions } = await import("../../src/core/prompts");
const { Layout, TOOLBOX } = await import("../../src/core/store/workspace");
const { MAINTAINER_ID } = await import("../../src/core/store/records");
type HeadConfig = import("../../src/core/agent/head").HeadConfig;
type BotProfile = import("../../src/core/store/workspace").BotProfile;
type SessionStart = import("../../src/core/bot").SessionStart;

// setup-env.ts clears BOTLING_* in the test process; test/record/vitest.config.mts passes these on with `provide`.
const options = (inject as (key: string) => Record<string, string> | undefined)("recordStreams") ?? {};
const RAW = options.BOTLING_RECORD_STREAMS ?? "";
const TMP = options.BOTLING_RECORD_TMP || "/Volumes/My-SSD/botling-work/recordings/tmp";
const list = (value: string | undefined) => (value ? value.split(",").map((part) => part.trim()).filter(Boolean) : null);
const ENGINES = list(options.BOTLING_RECORD_ENGINES);
const SCENARIOS = list(options.BOTLING_RECORD_SCENARIOS);
const AGY_RUNTIME = options.BOTLING_AGY_ACP_PATH || join(homedir(), "Library/Application Support/Botling/runtimes/antigravity/1.4.3/agy_acp_server.par");

type Engine = "claude" | "codex" | "editor" | "agy";
type Scenario = "chunked-text" | "failed-tool-then-success" | "empty-report" | "usage-speed" | "cancel" | "process-exit" | "multiple-workers";
const ALL_SCENARIOS: Scenario[] = ["chunked-text", "failed-tool-then-success", "empty-report", "usage-speed", "cancel", "process-exit", "multiple-workers"];

/** One worker's words per scenario (multiple-workers: two). Fixed, small, and the same for every engine. */
const PROMPTS: Record<Scenario, string[]> = {
  "chunked-text": ["Reply with a 400-word explanation of how a hash table works, containing two code spans like `05B44DD6-73BB`. Do not use tools."],
  "failed-tool-then-success": ["Run `git status` in this folder (it is not a repository), then reply with exactly: DONE — git failed as expected."],
  "empty-report": ["Run `true` with your shell tool, then end your turn without writing any text at all: no summary, no confirmation, nothing."],
  "usage-speed": ["Read the file notes.txt in this folder, then reply with how many lines it has and its first word, in one sentence."],
  // Not `sleep`: claude 2.1.x refuses a standalone sleep at once, so the tool would not be running when the run is cut.
  "cancel": [`Run this shell command and wait for it to finish (it takes a minute): perl -e 'select(undef,undef,undef,60); print "waited\\n"'. Then reply with exactly: WAITED.`],
  "process-exit": [`Run this shell command and wait for it to finish (it takes a minute): perl -e 'select(undef,undef,undef,60); print "waited\\n"'. Then reply with exactly: WAITED.`],
  "multiple-workers": ["Reply with exactly: ALPHA. Do not use tools.", "Run `echo beta`, then reply with exactly: BETA."],
};

const NOTES = "apple\nbanana\ncherry\ndate\nelderberry\n";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(check: () => T | undefined | null | false, timeout: number, what: string): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(100);
  }
}
const version = (command: string, args: string[]) => {
  try { return execFileSync(command, args, { encoding: "utf8", timeout: 20_000 }).trim().split("\n")[0]!; } catch { return "unknown"; }
};

/** One process's stream file. */
class Stream {
  private buffers = { out: "", err: "" };
  closed = false;
  constructor(readonly file: string, readonly pid: number, private rec: Recording) {}
  line(d: "in" | "out" | "err" | "exit", l: string) {
    appendFileSync(this.file, `${JSON.stringify({ t: Date.now() - this.rec.t0, d, l })}\n`);
  }
  chunk(d: "in" | "out" | "err", chunk: unknown) {
    if (d === "in") { // writes are whole lines already (JSON + "\n")
      for (const l of String(chunk).split("\n")) if (l.trim()) this.line("in", l);
      return;
    }
    this.buffers[d] += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    let at: number;
    while ((at = this.buffers[d].indexOf("\n")) >= 0) {
      const l = this.buffers[d].slice(0, at);
      this.buffers[d] = this.buffers[d].slice(at + 1);
      if (l.trim()) this.line(d, l);
    }
  }
  close(code: number | null, signal: string | null) {
    for (const d of ["out", "err"] as const) if (this.buffers[d].trim()) this.line(d, this.buffers[d]);
    this.line("exit", JSON.stringify({ code, signal }));
    this.closed = true;
  }
}

/** One scenario of one engine: its processes' streams and what the app made of them. */
class Recording {
  readonly t0 = Date.now();
  readonly streams: Stream[] = [];
  constructor(readonly dir: string, readonly engine: Engine, readonly scenario: Scenario, readonly cli: string, private records: (command: string) => boolean) {
    mkdirSync(dir, { recursive: true });
    for (const name of [`${scenario}.items.jsonl`]) writeFileSync(join(dir, name), "");
  }
  open(command: string, args: string[], managed: { pid: number; child: any }) {
    if (!this.records(command)) return;
    const n = this.streams.length + 1;
    const stream = new Stream(join(this.dir, `${this.scenario}.p${n}.jsonl`), managed.pid, this);
    this.streams.push(stream);
    writeFileSync(stream.file, `${JSON.stringify({ engine: this.engine, cli: this.cli, recordedAt: new Date().toISOString(), scenario: this.scenario, process: n, command: basename(command), args })}\n`);
    const child = managed.child;
    child.stdout.on("data", (chunk: unknown) => stream.chunk("out", chunk));
    child.stderr.on("data", (chunk: unknown) => stream.chunk("err", chunk));
    child.once("close", (code: number | null, signal: string | null) => stream.close(code, signal));
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: unknown, ...rest: unknown[]) => { stream.chunk("in", chunk); return write(chunk, ...rest); };
  }
  item(value: unknown) {
    appendFileSync(join(this.dir, `${this.scenario}.items.jsonl`), `${JSON.stringify({ t: Date.now() - this.t0, item: value })}\n`);
  }
  /** Ends whatever is left of its processes' groups (a SIGKILLed CLI leaves its `sleep` behind). */
  sweep() {
    for (const stream of this.streams) { try { process.kill(-stream.pid, "SIGKILL"); } catch { /* gone */ } }
  }
}

function folder(engine: Engine, scenario: Scenario): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, `${engine}-${scenario}-`));
  writeFileSync(join(dir, "notes.txt"), NOTES);
  return dir;
}

/** The coordinator head's config as core/main.ts `headConfig` gives it for the packaged app (BOTLING_HARMLESS=0), for a project bot. */
function claudeBase(cwd: string, sessionId: string = randomUUID()): HeadConfig {
  return {
    command: "claude", cwd, sessionId, resume: false,
    allowedTools: [...TOOLBOX, "Bash"], disallowedTools: [], pluginDirs: [], env: { CLAUDE_CODE_ARTIFACT: "1" },
    model: null, addDirs: [], effort: null,
    ...claudeSessionPermissionConfig({ autoMode: true, allowRules: [], claudeBypassPermissions: false }),
    harmless: false, harmlessTools: [], systemPrompt: "You are a Botling bot.",
  };
}

const profile = (dir: string): BotProfile => ({ id: randomUUID().toUpperCase(), name: "Recorder", role: "bot", avatar: "circle", folder: dir, memoryPath: "memory.md", storeDir: join(dir, ".store"), tools: [...TOOLBOX, "Bash"], job: null, problem: null });

/** What a driver reports back for the scenario. */
interface Outcome { workers: string[]; ended: { id: string; status: string; summary: string }[] }
type Item = { kind: string; [key: string]: any };

/** Waits for the scenario's interruption point (a tool started in the worker), then a moment more. */
async function midRun(items: Item[], parent: (item: Item) => boolean) {
  await until(() => items.find((item) => item.kind === "toolUse" && parent(item)), 120_000, "the worker's tool to start");
  await sleep(1_500);
}

// ------------------------------------------------------------------------------------------------
// Claude: the real ClaudeWorkers (claude-workers.ts), each worker a ClaudeHead on the teeing adapter.

async function recordClaude(rec: Recording, scenario: Scenario, dir: string): Promise<Outcome> {
  const items: Item[] = [];
  const workers: InstanceType<typeof ClaudeWorkers> = new ClaudeWorkers({
    file: join(dir, ".store", "claude-workers.json"), ownerSessionId: () => "00000000-0000-4000-8000-000000000000",
    base: () => claudeBase(dir), cwd: () => dir, subagentModel: () => null, maxRunning: () => 4,
    // Short keep-alive: the process gets its stdin closed soon after a result, so its natural exit is recorded too.
    keepAliveMs: 1_500,
  }, (item) => {
    items.push(item as Item); rec.item(item);
    if (item.kind === "permission") workers.answer(item.requestId, true, item.input);
  }, (id, text, run) => { rec.item({ kind: "report", id, run, text }); return true; },
  (config, handlers) => new ClaudeHead(config, handlers, processTreeAdapter()));
  const ids: string[] = [];
  for (const [i, instructions] of PROMPTS[scenario].entries()) {
    const handed = await workers.tool("app_handoff", { name: `${scenario}${PROMPTS[scenario].length > 1 ? `-${i + 1}` : ""}`, instructions }) as { task_id: string };
    ids.push(handed.task_id);
  }
  if (scenario === "cancel") {
    await midRun(items, (item) => item.parent === ids[0]);
    await workers.stopWorker(ids[0]!);
  } else if (scenario === "process-exit") {
    await midRun(items, (item) => item.parent === ids[0]);
    process.kill(rec.streams[0]!.pid, "SIGKILL");
  }
  const ended = await until(() => {
    const done = items.filter((item) => item.kind === "subagentEnded" && ids.includes(item.id));
    return done.length === ids.length ? done : null;
  }, 240_000, "the workers to end");
  // A kept-alive process exits by itself after keepAliveMs; then close what is left.
  await until(() => rec.streams.every((stream) => stream.closed) || null, 20_000, "the worker processes to exit").catch(() => {});
  await workers.close();
  return { workers: ids, ended: ended.map((item) => ({ id: item.id, status: item.status, summary: item.summary })) };
}

// ------------------------------------------------------------------------------------------------
// Codex: the real CodexHead (one app-server); its coordinator hands the scenario's words to app-managed workers.

async function recordCodex(rec: Recording, scenario: Scenario, dir: string): Promise<Outcome> {
  const items: Item[] = [];
  let exited = false;
  const p = profile(dir);
  const head: InstanceType<typeof CodexHead> = new CodexHead({
    command: "codex", cwd: dir, sessionId: randomUUID(), resume: false, threads: new CodexThreads(join(dir, ".store", "codex-threads")),
    instructions: "You are a Botling coordinator bot. Do exactly what the user asks with the app tools.",
    workerInstructions: codexWorkerInstructions(p, "en"),
    model: options.BOTLING_RECORD_CODEX_MODEL || null, workerModel: null, effort: "low", workerEffort: null, workerFast: null,
    routinesFile: null, autoMode: true, bypassPermissions: false, writableRoots: [], retryLog: null,
  }, {
    onItem: (item) => {
      items.push(item as Item); rec.item(item);
      if (item.kind === "permission") head.answer(item.requestId, true, item.input);
    },
    onExit: (exit) => { exited = true; rec.item({ kind: "exit", ...exit }); },
  }, processTreeAdapter());
  head.start();
  const words = PROMPTS[scenario];
  const calls = words.map((text, i) => `Call ${i + 1}: name "${scenario}${words.length > 1 ? `-${i + 1}` : ""}", instructions exactly:\n<<<\n${text}\n>>>`).join("\n\n");
  head.send(`Call the app_handoff tool ${words.length === 1 ? "exactly once" : `exactly ${words.length} times, once per call below`}, with these arguments (instructions verbatim, without the markers).\n\n${calls}\n\nAfter the tool returns, end your turn with the single word: dispatched.`);
  const ids = (await until(() => {
    const started = items.filter((item) => item.kind === "subagentStarted").map((item) => item.id as string);
    return started.length === words.length ? started : null;
  }, 180_000, "the coordinator's handoffs"));
  const host = (head as unknown as { workerHost: { stopWorker(id: string): Promise<boolean> } }).workerHost;
  if (scenario === "cancel") {
    await midRun(items, (item) => item.parent === ids[0]);
    await host.stopWorker(ids[0]!);
  } else if (scenario === "process-exit") {
    await midRun(items, (item) => item.parent === ids[0]);
    process.kill(rec.streams[0]!.pid, "SIGKILL");
    await until(() => exited || null, 30_000, "the app-server to exit");
    return { workers: ids, ended: items.filter((item) => item.kind === "subagentEnded").map((item) => ({ id: item.id, status: item.status, summary: item.summary })) };
  }
  const ended = await until(() => {
    const done = items.filter((item) => item.kind === "subagentEnded" && ids.includes(item.id));
    return done.length === ids.length ? done : null;
  }, 240_000, "the workers to end");
  // The coordinator's report turn is not part of the worker's stream: end the app-server here (as the app does on quit).
  await sleep(500);
  await head.terminate(1_500);
  return { workers: ids, ended: ended.map((item) => ({ id: item.id, status: item.status, summary: item.summary })) };
}

// ------------------------------------------------------------------------------------------------
// Component editor: a ClaudeHead with the launch config the Maintainer's route gives (codex.ts performEditor).

async function recordEditor(rec: Recording, scenario: Scenario, dir: string): Promise<Outcome> {
  const library = join(dir, "plugins");
  mkdirSync(join(library, "ccb-core", "claude", "agents"), { recursive: true });
  writeFileSync(join(library, "ccb-core", "claude", "agents", "component-editor.md"), componentEditorAgent("sonnet"));
  writeFileSync(join(library, "notes.txt"), NOTES);
  const owner: BotProfile = { id: MAINTAINER_ID, name: "Maintainer", role: "manager", avatar: "circle", folder: library, memoryPath: "memory.md", storeDir: Layout.bot(dir, MAINTAINER_ID), tools: [...TOOLBOX, "Bash"], job: null, problem: null };
  const route = maintainerEditorBinding(owner, dir, (_profile, session) => ({ ...claudeBase(library, session.sessionId), resume: session.resume }))(owner, { sessionId: randomUUID(), resume: false } as SessionStart);
  if (!route?.launch) throw new Error(`No component editor route: ${route?.error ?? "not the Maintainer"}`);
  const items: Item[] = [];
  const heads = PROMPTS[scenario].map((text, i) => {
    const id = `editor-${i + 1}`;
    let head: InstanceType<typeof ClaudeHead>;
    head = new ClaudeHead({ ...route.launch!, monitorWorker: true, sessionId: randomUUID(), resume: false }, {
      onItem: (item) => {
        const tagged = { ...item, editor: id } as Item;
        items.push(tagged); rec.item(tagged);
        if (item.kind === "permission") head.answer(item.requestId, true, item.input);
        // As in the app, a finished editor would stay for corrections; here its stdin closes so the exit is recorded.
        if (item.kind === "result") setTimeout(() => head.finish(), 300);
      },
      onExit: (exit) => { const tagged = { kind: "exit", editor: id, ...exit }; items.push(tagged); rec.item(tagged); },
    }, processTreeAdapter());
    head.start();
    head.send(text, randomUUID());
    return { id, head };
  });
  if (scenario === "cancel") {
    await midRun(items, (item) => item.editor === heads[0]!.id);
    await heads[0]!.head.terminate(1_000); // performEditor's stop: retireEditor → terminate(1000)
  } else if (scenario === "process-exit") {
    await midRun(items, (item) => item.editor === heads[0]!.id);
    process.kill(rec.streams[0]!.pid, "SIGKILL");
  }
  await until(() => heads.every(({ id }) => items.some((item) => item.kind === "exit" && item.editor === id)) || null, 240_000, "the editors to exit");
  return {
    workers: heads.map(({ id }) => id),
    ended: heads.map(({ id }) => {
      const result = items.find((item) => item.kind === "result" && item.editor === id);
      return { id, status: result ? (result.ok ? "completed" : "failed") : "exited", summary: result?.text ?? "" };
    }),
  };
}

// ------------------------------------------------------------------------------------------------
// Antigravity: the real AgyWorkers, each worker an AgyAcpHead in worker mode (process/tree is mocked for it).

async function recordAgy(rec: Recording, scenario: Scenario, dir: string): Promise<Outcome> {
  const items: Item[] = [];
  const p = profile(dir);
  const workers: InstanceType<typeof AgyWorkers> = new AgyWorkers({
    command: AGY_RUNTIME, transport: "acp", cwd: dir, sessionId: randomUUID(), resume: false,
    acpHome: `${dir}.agy-home`, bypassPermissions: false, model: null, effort: null,
    systemPrompt: "You are a Botling coordinator bot.",
    workerInstructions: codexWorkerInstructions(p, "en").replace("independent Codex session", "independent execution session"),
  }, (item) => {
    items.push(item as Item); rec.item(item);
    if (item.kind === "permission") workers.answer(item.requestId, true, item.input);
  }, (id, text, run) => rec.item({ kind: "report", id, run, text }),
  (config, handlers) => createAgyWorkerHead(config, handlers, (c, h) => new AgyAcpHead(c, h as never)));
  const ids: string[] = [];
  for (const [i, instructions] of PROMPTS[scenario].entries()) {
    const handed = await workers.tool("app_handoff", { name: `${scenario}${PROMPTS[scenario].length > 1 ? `-${i + 1}` : ""}`, instructions }) as { task_id: string };
    ids.push(handed.task_id);
  }
  if (scenario === "cancel") {
    await midRun(items, (item) => item.parent === ids[0]);
    await workers.cancelTask(ids[0]!);
  } else if (scenario === "process-exit") {
    await midRun(items, (item) => item.parent === ids[0]);
    process.kill(rec.streams[0]!.pid, "SIGKILL");
  }
  const ended = await until(() => {
    const done = items.filter((item) => item.kind === "subagentEnded" && ids.includes(item.id));
    return done.length >= ids.length ? done : null;
  }, 240_000, "the workers to end");
  await workers.close().catch(() => {});
  return { workers: ids, ended: ended.map((item) => ({ id: item.id, status: item.status, summary: item.summary })) };
}

// ------------------------------------------------------------------------------------------------

function agyUnavailable(): string | null {
  try { validateAgyRuntimePath(AGY_RUNTIME, TMP); return null; } catch (error) { return (error as Error).message; }
}

const ENGINE_SETUP: Record<Engine, { cli: () => string; records: (command: string) => boolean; record: typeof recordClaude; unavailable?: () => string | null }> = {
  claude: { cli: () => version("claude", ["--version"]), records: (command) => basename(command) === "claude", record: recordClaude },
  codex: { cli: () => version("codex", ["--version"]), records: (command) => basename(command) === "codex", record: recordCodex },
  editor: { cli: () => version("claude", ["--version"]), records: (command) => basename(command) === "claude", record: recordEditor },
  agy: { cli: () => `agy_acp_server.par ${basename(join(AGY_RUNTIME, ".."))}`, records: (command) => command === AGY_RUNTIME, record: recordAgy, unavailable: agyUnavailable },
};

const summary: Record<string, unknown>[] = [];
afterAll(() => {
  tap.state.current = null;
  if (RAW && summary.length) appendFileSync(join(RAW, "summary.jsonl"), summary.map((row) => JSON.stringify(row)).join("\n") + "\n");
});

describe.skipIf(!RAW)("record real worker streams", () => {
  for (const engine of (["claude", "codex", "editor", "agy"] as Engine[]).filter((name) => !ENGINES || ENGINES.includes(name))) {
    describe(engine, () => {
      const setup = ENGINE_SETUP[engine];
      for (const scenario of ALL_SCENARIOS.filter((name) => !SCENARIOS || SCENARIOS.includes(name))) {
        it(scenario, async (context) => {
          const why = setup.unavailable?.();
          if (why) { summary.push({ engine, scenario, skipped: why }); context.skip(why); return; }
          const dir = folder(engine, scenario);
          const rec = new Recording(join(RAW, engine), engine, scenario, setup.cli(), setup.records);
          tap.state.current = rec;
          try {
            const outcome = await setup.record(rec, scenario, dir);
            summary.push({ engine, scenario, cli: rec.cli, processes: rec.streams.length, ...outcome });
            console.log(`${engine}/${scenario}:`, JSON.stringify(outcome.ended));
            expect(rec.streams.length).toBeGreaterThan(0);
          } finally {
            tap.state.current = null;
            rec.sweep();
            for (const path of [dir, `${dir}.agy-home`]) rmSync(path, { recursive: true, force: true });
          }
        }, 420_000);
      }
    });
  }
});
