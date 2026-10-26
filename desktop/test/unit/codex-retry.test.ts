// Codex waiting to retry a request the API turned away (429 Too Many Requests): codex app-server
// says so with an `error` notification (willRetry: true, "Reconnecting... 1/5"), and logs how long
// it waits in CODEX_HOME/logs_2.sqlite. The bot shows it (BotView.codexRetry, the typing bubble)
// until the turn moves on or ends.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { codexRetryAt, parseRetryLine } from "../../src/core/agent/codex-retry-log";
import { chatState } from "../../src/renderer/payload";
import type { BotView } from "../../src/contract";
import { CoreHarness, MAIN } from "../core-harness";
import { desktop, tempDir, until } from "../helpers";

const recordings: Record<string, string[]> = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "codex-recordings.json"), "utf8"));
const THREAD = "01a1640c-e2db-7742-998a-553a14d4336f";
const TURN = "01a1640c-e80e-7682-b431-5f06a7fbc859";

const config = (): CodexConfig => ({
  cwd: "/tmp/bot", instructions: "You are a test bot.", workerInstructions: "You are a worker.", resumeThread: null,
  model: null, workerModel: null, effort: null, restoredWorkers: [],
});
const items = (outputs: CodexOutput[]) => outputs.filter((o) => o.kind === "item").map((o) => (o as { item: any }).item);

/** What codex-cli 0.163.0 wrote against a server that answered 429 (retry-after 3), on this recording's thread. */
const retryLine = (attempt: number, willRetry = true, info: unknown = { responseStreamDisconnected: { httpStatusCode: 429 } }) => JSON.stringify({
  method: "error",
  params: {
    error: willRetry
      ? { message: `Reconnecting... ${attempt}/5`, codexErrorInfo: info, additionalDetails: "exceeded retry limit, last status: 429 Too Many Requests", misalignment: null }
      : { message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, additionalDetails: null, misalignment: null },
    willRetry, threadId: THREAD, turnId: TURN,
  },
  emittedAtMs: 1793004917288,
});

describe("Codex retry notifications", () => {
  it("an error codex will retry is an apiRetry item (attempt, limit, why); one it gives up on is not", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("hi");
    for (const line of recordings.helloAndApproval!.slice(0, 3)) session.receive(line);
    expect(items(session.receive(retryLine(1)))).toEqual([{ kind: "apiRetry", thread: THREAD, attempt: 1, max: 5, reason: "rateLimited", retryAt: null }]);
    expect(items(session.receive(retryLine(2, true, { responseStreamDisconnected: { httpStatusCode: null } })))).toEqual([{ kind: "apiRetry", thread: THREAD, attempt: 2, max: 5, reason: "connection", retryAt: null }]);
    expect(items(session.receive(retryLine(3, false)))).toEqual([]);
    // Another thread's (a worker's) retry is not the coordinator's.
    expect(items(session.receive(retryLine(1).replace(THREAD, "01a1640c-0000-7000-8000-000000000000")))).toEqual([]);
  });
});

describe("Codex's retry log (logs_2.sqlite, read-only)", () => {
  const db = (rows: { ts: number; nanos: number; body: string; thread: string; target?: string }[]) => {
    const dir = tempDir("codex-retry-log");
    const file = join(dir, "logs_2.sqlite");
    const insert = rows.map((r) => `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) VALUES (${r.ts}, ${r.nanos}, 'WARN', '${r.target ?? "codex_core::responses_retry"}', '${r.body}', '${r.thread}');`).join("\n");
    const made = spawnSync("sqlite3", [file, `CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);\n${insert}`]);
    expect(made.status).toBe(0);
    return file;
  };
  const body = (attempt: number, delay: string) => `run_sampling_request{turn_id=${TURN}}: stream disconnected - retrying sampling request (${attempt}/5 in ${delay})... turn_id=${TURN} retries=${attempt} max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests`;

  it("parses Rust's Duration as codex writes it", () => {
    expect(parseRetryLine(body(1, "504.999939833s"))).toEqual({ attempt: 1, max: 5, delayMs: 505_000 });
    expect(parseRetryLine(body(2, "850ms"))).toEqual({ attempt: 2, max: 5, delayMs: 850 });
    expect(parseRetryLine("something else")).toBeNull();
  });

  it("finds when this thread's attempt goes again; another thread, another attempt or no file: unknown", async () => {
    const since = 1_793_004_860_000;
    const file = db([
      { ts: 1_793_004_861, nanos: 250_000_000, body: body(1, "40.000123s"), thread: THREAD },
      { ts: 1_793_004_862, nanos: 0, body: body(1, "99s"), thread: "01a1640c-0000-7000-8000-000000000000" },
      { ts: 1_793_004_863, nanos: 0, body: body(1, "99s"), thread: THREAD, target: "codex_core::other" },
    ]);
    expect(await codexRetryAt({ file, thread: THREAD, attempt: 1, since })).toBe(1_793_004_861_250 + 40_000);
    expect(await codexRetryAt({ file, thread: THREAD, attempt: 2, since })).toBeNull();
    expect(await codexRetryAt({ file, thread: THREAD, attempt: 1, since: since + 3_600_000 })).toBeNull();
    expect(await codexRetryAt({ file: join(tempDir("codex-retry-none"), "logs_2.sqlite"), thread: THREAD, attempt: 1, since })).toBeNull();
    expect(await codexRetryAt({ file, thread: "x'; DROP TABLE logs; --", attempt: 1, since })).toBeNull();
  });
});

describe("the chat page hears of it", () => {
  const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["codex"], job: null, subagentRows: [] };
  const chat = { botId: "B", messages: [], running: { turnId: "t", messageId: "m" }, live: [], tasks: [] };
  it("while a turn is under way", () => {
    const retry = { attempt: 1, max: 5, reason: "rateLimited" as const, retryAt: 1_793_004_901_250 };
    expect(chatState({ ...bot, codexRetry: retry }, chat).state.retrying).toEqual(retry);
    expect(chatState(bot, chat).state.retrying ?? null).toBeNull();
    expect(chatState({ ...bot, working: false, codexRetry: retry }, { ...chat, running: null }).state.retrying ?? null).toBeNull();
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const core of harnesses.splice(0)) await core.kill("SIGKILL");
});

describe("a Codex bot waiting on a rate-limited retry", () => {
  it("says which attempt and when it goes again, until its next step", async () => {
    const dir = tempDir("codex-retry-core");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main/bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
    const home = join(dir, "codex-home");
    mkdirSync(home, { recursive: true });
    const made = spawnSync("sqlite3", [join(home, "logs_2.sqlite"), "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);"]);
    expect(made.status).toBe(0);
    const gate = join(dir, "retry-gate");
    const core = new CoreHarness(dir, { CODEX_HOME: home, FAKE_CODEX_RETRY_GATE: gate });
    harnesses.push(core);
    const before = Date.now();
    const sent = await core.call({ type: "chat.send", botId: MAIN, text: "/ratelimit Back now" });
    const view = async () => ((await core.call({ type: "chat.snapshot", botId: MAIN })).bots as BotView[]).find((bot) => bot.id === MAIN)!;
    const waiting = await until(async () => { const bot = await view(); return bot.codexRetry?.retryAt ? bot : null; }, { what: "the retry with its time" });
    expect(waiting.codexRetry).toMatchObject({ attempt: 1, max: 5, reason: "rateLimited" });
    expect(waiting.codexRetry!.retryAt!).toBeGreaterThanOrEqual(before + 39_000);
    expect(waiting.codexRetry!.retryAt!).toBeLessThanOrEqual(Date.now() + 41_000);
    writeFileSync(gate, "");
    // The retry went through: its first step clears the note while the turn goes on.
    await until(async () => (await core.chat()).live?.length, { what: "the step after the retry" });
    expect((await view()).codexRetry ?? null).toBeNull();
    expect((await view()).working).toBe(true);
    writeFileSync(`${gate}.done`, "");
    await until(() => core.of("turn.finished").find((entry) => (entry.event as { turnId: string }).turnId === sent.turnId), { what: "the turn's end" });
    expect((await view()).codexRetry ?? null).toBeNull();
    expect((await core.chat()).messages.find((line: { id: string }) => line.id === sent.messageId)).toMatchObject({ text: "Back now" });
  });
});
