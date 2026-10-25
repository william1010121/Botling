// One agent turn: start the CLI, stream its reply as text deltas, and stop it (with its whole
// process tree) on request. After `stop()` returns, no further delta or finish callback fires for
// this turn — late output from a dying process is dropped here, not by the UI.
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { cliStartError, executableEnvironment, resolveExecutable } from "../process/executable";

export interface AgentConfig {
  /** Executable to run: `claude`, or a fake CLI script for tests. */
  command: string;
  /** Arguments put before the CLI's own (e.g. the fake CLI's script path when command is node). */
  prefixArgs?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Claude session to start (`--session-id`) or continue (`--resume`). */
  sessionId?: string;
  resume?: boolean;
  /** Tests and live checks: no tools, no session written to ~/.claude. */
  harmless?: boolean;
  model?: string;
}

export type TurnOutcome = { status: "done"; text: string } | { status: "failed"; text: string; error: string };

export interface TurnHandlers {
  onDelta(text: string): void;
  onFinish(outcome: TurnOutcome): void;
}

/** The `claude` arguments for one print-mode turn whose prompt arrives on stdin. */
export function claudeArguments(config: AgentConfig): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (config.sessionId) args.push(config.resume ? "--resume" : "--session-id", config.sessionId);
  if (config.model) args.push("--model", config.model);
  if (config.harmless) args.push("--tools", "", "--strict-mcp-config", "--no-session-persistence");
  return args;
}

/** Environment for the child: the app's, minus what would make claude think it is nested in a session. */
export function childEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return executableEnvironment(env);
}

/**
 * Reads stream-json lines and turns them into text. Partial deltas (`stream_event` /
 * `content_block_delta` / `text_delta`) are used when present; a full `assistant` message only fills
 * in text no delta delivered. `result` ends the turn.
 */
export class StreamJsonReader {
  private buffer = "";
  private text = "";
  private sawDelta = false;
  private pendingBreak = false;
  finished: TurnOutcome | null = null;

  constructor(private handlers: TurnHandlers) {}

  push(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
    }
  }

  get soFar() {
    return this.text;
  }

  private line(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not JSON (a warning on stdout): ignore it, as the Swift side does.
    }
    if (this.finished) return;
    if (message.type === "stream_event" && message.event?.type === "content_block_delta" && message.event.delta?.type === "text_delta") {
      const piece = String(message.event.delta.text ?? "");
      if (piece) {
        this.sawDelta = true;
        if (this.pendingBreak) {
          this.pendingBreak = false;
          this.text += "\n\n";
          this.handlers.onDelta("\n\n");
        }
        this.text += piece;
        this.handlers.onDelta(piece);
      }
    } else if (message.type === "assistant" && !this.sawDelta) {
      const content = Array.isArray(message.message?.content) ? message.message.content : [];
      const full = content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("");
      if (full.startsWith(this.text) && full.length > this.text.length) {
        const piece = full.slice(this.text.length);
        this.text = full;
        this.handlers.onDelta(piece);
      }
    } else if (message.type === "stream_event" && message.event?.type === "content_block_start" && message.event.content_block?.type === "text" && this.text) {
      // A later text block (after a tool call) starts a new paragraph.
      this.pendingBreak = true;
    } else if (message.type === "result") {
      if (message.is_error || (message.subtype && message.subtype !== "success")) {
        this.finished = { status: "failed", text: this.text, error: String(message.result ?? message.subtype ?? "The agent reported an error.").slice(0, 2_000) };
      } else {
        if (!this.text && typeof message.result === "string") {
          this.text = message.result;
          this.handlers.onDelta(message.result);
        }
        this.finished = { status: "done", text: this.text };
      }
      this.handlers.onFinish(this.finished);
    }
  }
}

export class AgentTurn {
  private process: ManagedProcess | null = null;
  private stopped = false;
  private ended = false;
  private reader: StreamJsonReader;
  private stderrTail = "";
  private exitedResolve!: () => void;
  /** Resolves when the CLI process has exited (its group is ended separately). */
  readonly exited = new Promise<void>((resolve) => (this.exitedResolve = resolve));

  constructor(private config: AgentConfig, private handlers: TurnHandlers, private adapter: ProcessTreeAdapter = processTreeAdapter()) {
    // Every callback goes through the `stopped` gate, so nothing reaches the caller after stop().
    this.reader = new StreamJsonReader({
      onDelta: (text) => { if (!this.stopped && !this.ended) handlers.onDelta(text); },
      onFinish: (outcome) => this.end(outcome),
    });
  }

  get pid() {
    return this.process?.pid ?? -1;
  }

  get text() {
    return this.reader.soFar;
  }

  start(prompt: string) {
    const args = [...(this.config.prefixArgs ?? []), ...claudeArguments(this.config)];
    const env = childEnvironment(this.config.env);
    const managed = this.adapter.spawn(resolveExecutable(this.config.command, env), args, { cwd: this.config.cwd, env });
    this.process = managed;
    const child = managed.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (!this.stopped) this.reader.push(chunk); });
    child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2_000); });
    child.once("error", (error) => { this.exitedResolve(); this.end({ status: "failed", text: this.reader.soFar, error: cliStartError("claude", this.config.command, error) }); });
    child.once("close", (code, signal) => {
      this.exitedResolve();
      // A turn without a result line: the CLI crashed or quit.
      this.end({ status: "failed", text: this.reader.soFar, error: `The agent exited (${signal ?? code}) without finishing. ${this.stderrTail.trim()}`.trim() });
    });
    child.stdin.on("error", () => { /* EPIPE when the CLI exits early */ });
    child.stdin.end(prompt);
  }

  private end(outcome: TurnOutcome) {
    if (this.ended || this.stopped) return;
    this.ended = true;
    this.handlers.onFinish(outcome);
    // A finished print-mode CLI exits by itself; make sure helpers it left behind do too.
    if (this.process && this.process.child.exitCode === null) void this.process.terminate({ graceMs: 3_000 });
  }

  /** Stops the turn: from now on no callback fires; the whole tree is ended. */
  async stop(): Promise<TerminateResult & { wasRunning: boolean }> {
    const wasRunning = !this.ended && !this.stopped;
    this.stopped = true;
    if (!this.process) return { killed: [], forced: false, wasRunning };
    const result = await this.process.terminate({ graceMs: 1_500 });
    return { ...result, wasRunning };
  }
}
