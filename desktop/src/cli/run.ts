// `botling run` (docs/headless-run.md): runs one task with Botling's real core and no GUI, under plain Node.
//
//   node out/cli/run.cjs [run] --task instruction.md --out /logs/botling [--workdir DIR] [--timeout SEC] …
//
// It starts the headless core (out/core/main.cjs, JSON lines on stdio) on a fresh data folder, adds the work folder
// as a project bot, sends the task as the user's message and answers whatever would ask a person (run-loop.ts).
// Once the bot and its workers are all quiet it writes the trajectory to --out and exits:
//   0 the bot finished; 1 an error (a failed last turn, the core gone, bad arguments); 124 --timeout.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "../contract";
import { RunLoop, type RunOutcome, type RunTransport } from "./run-loop";

export const EXIT_OK = 0, EXIT_ERROR = 1, EXIT_TIMEOUT = 124;

export interface RunArgs {
  task: string;
  workdir: string;
  out: string;
  timeoutSec: number;
  settleSec: number;
  model: string | null;
  dataDir: string | null;
  keepBotDir: boolean;
  worktrees: boolean;
  bypass: boolean;
}

const USAGE = `usage: botling run --task <instruction.md> --out <dir> [options]
  --task FILE          the task, sent as the user's message ("-" reads stdin)
  --instruction TEXT   the task as text instead of a file
  --out DIR            where the trajectory goes (made if missing)
  --workdir DIR        the bot's working folder (default: the current folder)
  --timeout SEC        give up after SEC seconds, exit 124 (default 3600; 0: no limit)
  --settle SEC         how long everything must stay quiet to count as finished (default 20)
  --model NAME         the head's model (claude --model), e.g. opus or claude-opus-5-5
  --data-dir DIR       Botling's data folder (default: a fresh temporary one, removed after)
  --keep-bot-dir       leave <workdir>/.bot in place (default: removed when this run made it)
  --no-worktrees       workers work in the folder itself, not app-managed git worktrees
  --ask-permissions    do not bypass permissions: tool approvals are answered "allow once" instead`;

export function parseArgs(argv: string[], readText: (file: string) => string = (file) => readFileSync(file === "-" ? 0 : file, "utf8")): RunArgs {
  const args = argv[0] === "run" ? argv.slice(1) : argv;
  const value = (flag: string): string | null => {
    const at = args.indexOf(flag);
    if (at < 0) return null;
    const next = args[at + 1];
    if (next === undefined || (next.startsWith("--") && next !== "-")) throw new Error(`${flag} needs a value`);
    return next;
  };
  const known = new Set(["--task", "--instruction", "--out", "--workdir", "--timeout", "--settle", "--model", "--data-dir", "--keep-bot-dir", "--no-worktrees", "--ask-permissions", "--help", "-h"]);
  for (const arg of args) if (arg.startsWith("-") && arg !== "-" && !known.has(arg)) throw new Error(`unknown option ${arg}`);
  const number = (flag: string, fallback: number) => {
    const text = value(flag);
    if (text === null) return fallback;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a number of seconds`);
    return n;
  };
  const file = value("--task"), inline = value("--instruction");
  if (!file && !inline) throw new Error("give --task FILE or --instruction TEXT");
  const task = inline ?? readText(file!);
  if (!task.trim()) throw new Error("the task is empty");
  const out = value("--out");
  if (!out) throw new Error("give --out DIR");
  return {
    task, out: resolve(out), workdir: resolve(value("--workdir") ?? process.cwd()),
    timeoutSec: number("--timeout", 3600), settleSec: number("--settle", 20),
    model: value("--model"), dataDir: value("--data-dir") ? resolve(value("--data-dir")!) : null,
    keepBotDir: args.includes("--keep-bot-dir"), worktrees: !args.includes("--no-worktrees"), bypass: !args.includes("--ask-permissions"),
  };
}

/** settings.json for a run with nobody present: no update checks, results kept local, permissions as asked. */
export function runSettings(args: Pick<RunArgs, "bypass" | "worktrees">): Record<string, unknown> {
  return {
    claudeBypassPermissions: args.bypass, codexBypassPermissions: args.bypass,
    resultPublishingChoice: "localOnly", updateCheckEnabled: false,
    ...(args.worktrees ? {} : { worktreesEnabled: false }),
  };
}

/** The Botling variables a run takes from its environment: which engine and CLI, the fakes tests use, the model. */
const PASSED = new Set(["BOTLING_AGENT", "BOTLING_CLAUDE_PATH", "BOTLING_CODEX_PATH", "BOTLING_MODEL", "BOTLING_CODEX_MODEL", "BOTLING_CODEX_EFFORT", "BOTLING_NODE_PATH", "BOTLING_FAKE_CLI", "BOTLING_FAKE_CODEX"]);

/** The core's environment: the real CLI, a real bot (not dev's harmless mode), nothing that waits on a person. */
export function coreEnvironment(base: NodeJS.ProcessEnv, dataDir: string, args: Pick<RunArgs, "model" | "bypass">): Record<string, string> {
  const env: Record<string, string> = {};
  // Botling's own variables from wherever this was started (a Botling app's shell names its data, its 1.x import,
  // its commands) are left out but for the few that choose the engine; the run's data folder starts empty.
  for (const [key, value] of Object.entries(base)) if (value !== undefined && (!key.startsWith("BOTLING_") || PASSED.has(key))) env[key] = value;
  Object.assign(env, {
    BOTLING_DATA_DIR: dataDir,
    BOTLING_AGENT: base.BOTLING_AGENT ?? "claude",
    BOTLING_HARMLESS: "0",
    // Never sleep, never tidy notes at the end: the run is one task.
    BOTLING_IDLE_MS: String(7 * 24 * 3600_000), BOTLING_QUIT_TIDY_MS: "0",
    BOTLING_APPROVAL_TIMEOUT_MS: String(24 * 3600_000),
  });
  if (args.model) env.BOTLING_MODEL = args.model;
  // claude refuses bypassPermissions as root outside a sandbox it is told about; a task container is one.
  if (args.bypass && env.IS_SANDBOX === undefined && process.getuid?.() === 0) env.IS_SANDBOX = "1";
  return env;
}

/** The core over its stdio: requests by id, events to listeners. */
export class CoreProcess implements RunTransport {
  readonly child: ChildProcessWithoutNullStreams;
  private listeners: ((event: any) => void)[] = [];
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private counter = 0;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly events: unknown[] = [];

  constructor(script: string, env: Record<string, string>, stderrFile: string) {
    this.child = spawn(process.execPath, [script], { env, stdio: "pipe" });
    const log = createWriteStream(stderrFile, { flags: "a" });
    this.child.stderr.pipe(log);
    this.child.stdin.on("error", () => {});
    this.exited = new Promise((done) => this.child.once("exit", (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`core exited (code ${code}, signal ${signal})`));
      this.pending.clear();
      done({ code, signal });
    }));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message && typeof message === "object" && "event" in message) {
        this.events.push(message.event);
        for (const listener of this.listeners) listener(message.event);
      } else if (message && typeof message.id === "string") {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.ok) waiting.resolve(message.result);
        else waiting.reject(new Error(`${message.error?.code ?? "error"}: ${message.error?.message ?? "refused"}`));
      }
    });
  }

  call(cmd: Record<string, unknown>): Promise<any> {
    const id = `run${++this.counter}`;
    return new Promise((resolve, reject) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) { reject(new Error("core is not running")); return; }
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ v: PROTOCOL_VERSION, id, cmd }) + "\n");
    });
  }

  onEvent(listener: (event: any) => void): void { this.listeners.push(listener); }

  /** Closing stdin is the core's quit (it ends heads and workers, writes its files); killed if it lingers. */
  async stop(graceMs = 15_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const done = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref())]);
    if (!done) { this.child.kill("SIGKILL"); await this.exited; }
  }
}

interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }

/** Claude's transcripts written since `since` (every session: head and workers), and the tokens they used. */
export function claudeTranscripts(root: string, since: number): { files: string[]; usage: Usage; sessions: number } {
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const files: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) { try { if (statSync(path).mtimeMs >= since) files.push(path); } catch { /* gone */ } }
    }
  };
  walk(root);
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry?.message;
      if (entry?.type !== "assistant" || !message?.usage) continue;
      // A streamed message is written once per content block with the same id and usage: count it once.
      const key = `${message.id ?? entry.uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const field of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) usage[field] += Number(message.usage[field]) || 0;
    }
  }
  return { files, usage, sessions: files.length };
}

function copyIfThere(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  try { cpSync(from, to, { recursive: true, dereference: false, errorOnExist: false, force: true }); return true; } catch { return false; }
}

/** The chat from its first line: the snapshot's newest page and every older page before it. */
async function wholeChat(core: RunTransport, botId: string): Promise<{ snapshot: any; messages: any[] }> {
  const snapshot = await core.call({ type: "chat.snapshot", botId });
  let messages: any[] = snapshot?.chat?.messages ?? [];
  let more = snapshot?.chat?.history?.hasMore === true;
  while (more && messages.length) {
    const page = await core.call({ type: "chat.history", botId, before: messages[0].id });
    messages = [...(page.messages ?? []), ...messages];
    more = page.hasMore === true && (page.messages?.length ?? 0) > 0;
  }
  return { snapshot, messages };
}

export interface RunResult { exitCode: number; outcome: RunOutcome | null; summary: Record<string, unknown> }

export async function run(args: RunArgs, options: { coreScript?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): Promise<RunResult> {
  const log = options.log ?? ((line: string) => process.stderr.write(`[botling run] ${line}\n`));
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  if (!existsSync(args.workdir) || !statSync(args.workdir).isDirectory()) throw new Error(`no folder at ${args.workdir}`);
  mkdirSync(args.out, { recursive: true });
  const ownData = !args.dataDir;
  const dataDir = args.dataDir ?? mkdtempSync(join(tmpdir(), "botling-run-"));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify(runSettings(args), null, 2));
  const botDir = join(args.workdir, ".bot");
  const hadBotDir = existsSync(botDir);
  writeFileSync(join(args.out, "instruction.md"), args.task);

  const coreScript = options.coreScript ?? join(__dirname, "..", "core", "main.cjs");
  const core = new CoreProcess(coreScript, coreEnvironment(env, dataDir, args), join(args.out, "core.log"));
  const loop: { current: RunLoop | null } = { current: null };
  let botId: string | null = null;
  let outcome: RunOutcome | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const exited = core.exited.then(({ code, signal }) => { loop.current?.fail(`the core exited (code ${code}, signal ${signal})`); return { code, signal }; });
  // Killed from outside (the harness's own timeout): still stop the core and write what there is.
  const interrupted = () => loop.current?.fail("interrupted by a signal");
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  try {
    await core.call({ type: "boot.commit" });
    const added = await core.call({ type: "projects.add", folder: args.workdir });
    botId = added.botId as string;
    log(`bot ${botId} in ${args.workdir}`);
    const current = new RunLoop({ transport: core, botId, settleMs: args.settleSec * 1000, log });
    loop.current = current;
    if (args.timeoutSec > 0) timer = setTimeout(() => { timedOut = true; current.fail(`timed out after ${args.timeoutSec} s`); }, args.timeoutSec * 1000);
    await current.start(args.task);
    outcome = await current.done;
  } catch (error) {
    outcome = { status: "error", finalText: "", lastTurn: null, error: (error as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
  }
  log(`${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`);

  // The trajectory, through the contract while the core still runs.
  const workers: string[] = [];
  let chatMessages = 0;
  if (botId && core.child.exitCode === null) {
    try {
      const { snapshot, messages } = await wholeChat(core, botId);
      chatMessages = messages.length;
      const bot = (snapshot?.bots ?? []).find((b: any) => b.id === botId) ?? null;
      writeFileSync(join(args.out, "chat.json"), JSON.stringify({ bot, messages }, null, 2));
      writeFileSync(join(args.out, "chat.md"), chatMarkdown(messages));
      mkdirSync(join(args.out, "workers"), { recursive: true });
      const ids = new Set<string>([...(loop.current?.stats.workers ?? []), ...((bot?.subagentRows ?? []).map((row: any) => row.id))]);
      for (const id of ids) {
        try {
          const view = await core.call({ type: "subagent.view", botId, subagentId: id });
          writeFileSync(join(args.out, "workers", `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`), JSON.stringify(view, null, 2));
          workers.push(id);
        } catch (error) { log(`worker ${id}: ${(error as Error).message}`); }
      }
    } catch (error) { log(`could not read the chat: ${(error as Error).message}`); }
  }
  await core.stop();
  await exited;
  // Botling's own files (chat archive, worker ledgers and logs) and claude's transcripts, after the core wrote them out.
  if (botId) copyIfThere(join(dataDir, "projects", botId), join(args.out, "botling", "data"));
  copyIfThere(botDir, join(args.out, "botling", "bot-dir"));
  const claudeHome = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
  const transcripts = claudeTranscripts(join(claudeHome, "projects"), startedAt - 1000);
  for (const file of transcripts.files) copyIfThere(file, join(args.out, "claude-transcripts", file.slice(join(claudeHome, "projects").length + 1)));
  if (!hadBotDir && !args.keepBotDir) rmSync(botDir, { recursive: true, force: true });
  if (ownData) rmSync(dataDir, { recursive: true, force: true });

  const exitCode = timedOut ? EXIT_TIMEOUT : outcome.status === "completed" ? EXIT_OK : EXIT_ERROR;
  const endedAt = Date.now();
  const summary = {
    status: timedOut ? "timeout" : outcome.status, exitCode, error: outcome.error,
    workdir: args.workdir, model: args.model, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
    durationSec: Math.round((endedAt - startedAt) / 100) / 10,
    lastTurn: outcome.lastTurn, turns: loop.current?.stats.turns ?? 0, failedTurns: loop.current?.stats.failedTurns ?? 0,
    approvalsAnswered: loop.current?.stats.approvalsAnswered ?? 0, choicesAnswered: loop.current?.stats.choicesAnswered ?? 0,
    workers: workers.length, chatMessages, claudeSessions: transcripts.sessions, tokens: transcripts.usage,
    finalText: outcome.finalText,
  };
  writeFileSync(join(args.out, "summary.json"), JSON.stringify(summary, null, 2));
  return { exitCode, outcome, summary };
}

function chatMarkdown(messages: any[]): string {
  const parts = messages.map((m) => {
    const steps = (m.steps ?? []).map((s: any) => `- ${s.kind}${s.tool ? ` ${s.tool}` : ""}: ${String(s.title).slice(0, 300)}${s.failed ? " (failed)" : ""}`).join("\n");
    return `## ${m.role}${m.engine ? ` (${m.engine})` : ""} · ${m.time}\n\n${m.text}${steps ? `\n\nSteps:\n${steps}` : ""}`;
  });
  return parts.join("\n\n---\n\n") + "\n";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { process.stdout.write(USAGE + "\n"); process.exit(argv.length ? 0 : 1); }
  let args: RunArgs;
  try { args = parseArgs(argv); } catch (error) { process.stderr.write(`botling run: ${(error as Error).message}\n${USAGE}\n`); process.exit(EXIT_ERROR); }
  try {
    const result = await run(args);
    process.stdout.write(JSON.stringify({ status: result.summary.status, exitCode: result.exitCode, out: args.out }) + "\n");
    process.exit(result.exitCode);
  } catch (error) {
    process.stderr.write(`botling run: ${(error as Error).message}\n`);
    process.exit(EXIT_ERROR);
  }
}

if (require.main === module) void main();
