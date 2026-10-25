// A bot's head: one long-lived `claude -p --input-format stream-json` process (as the Swift app's
// `ClaudeAgentProcess`). Messages go in as JSON lines on stdin; replies, tool calls and permission
// requests come out as stream-json lines. It runs in its own process group (see process/tree.ts)
// so ending it ends every tool command and helper it started.
//
// This class only speaks the protocol. Turn bookkeeping, approvals, gates and restarts are the
// bot's (bot.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { imageMediaType } from "../attachments";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { childEnvironment } from "./runner";
import { parseLine, type StreamItem } from "./stream";

export interface HeadConfig {
  /** `claude`, or the fake CLI's interpreter for tests. */
  command: string;
  /** Put before claude's own arguments (the fake CLI's script path). */
  prefixArgs?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  sessionId: string;
  /** Go on with `sessionId` (`--resume`) instead of starting it (`--session-id`). */
  resume: boolean;
  model?: string | null;
  /** More folders it may use (`--add-dir`). */
  addDirs?: string[];
  /** How hard it thinks (`--effort`); null: the model's default. */
  effort?: string | null;
  /** Tools it uses without asking (`--allowedTools`); anything else is asked about. */
  allowedTools: string[];
  /** Appended to claude's system prompt. */
  systemPrompt?: string | null;
  /**
   * Development and live tests: no MCP servers, no CLAUDE.md/hooks/plugins (`--safe-mode`), no
   * session written to ~/.claude, and only `harmlessTools` (default none) exist at all.
   */
  harmless?: boolean;
  harmlessTools?: string[];
  /** Plugins' Claude parts (`--plugin-dir`); none in harmless mode. */
  pluginDirs?: string[];
  /** false: nothing is asked about (a temporary team, 1.x's `asksPermission` off): no permission prompt tool. */
  askPermission?: boolean;
}

/** claude's arguments for a long-lived head (cf. `ClaudeAgentProcess.arguments`). */
export function headArguments(config: HeadConfig): string[] {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    config.resume ? "--resume" : "--session-id", config.sessionId,
    "--permission-mode", config.harmless ? "default" : "acceptEdits",
  ];
  if (config.askPermission !== false) {
    // Approvals are asked on stdout and answered on stdin.
    args.push("--permission-prompt-tool", "stdio");
    // Bots ask in the chat; AskUserQuestion would arrive as a permission request with no way to answer it.
    args.push("--disallowedTools", "AskUserQuestion");
  }
  const allowed = config.harmless ? [] : config.allowedTools;
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", config.effort);
  // The app's own instructions (Prompts.swift's). Not in harmless mode: they rely on Read/Write/Edit
  // (memory.md, routines), and a live run with no tools but these instructions wrote fake tool calls
  // as text for minutes instead of answering (Phase 2a).
  if (config.systemPrompt && !config.harmless) args.push("--append-system-prompt", config.systemPrompt);
  if (!config.harmless) for (const dir of config.pluginDirs ?? []) args.push("--plugin-dir", dir);
  if (!config.harmless) for (const dir of config.addDirs ?? []) args.push("--add-dir", dir);
  if (config.harmless) {
    args.push("--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--tools", (config.harmlessTools ?? []).join(","));
  }
  return args;
}

export interface HeadExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** The app ended it (finish, terminate); false: it crashed or quit by itself. */
  expected: boolean;
  /** It printed nothing at all before exiting (a resume of an unknown session, a bad flag). */
  silent: boolean;
}

export interface HeadHandlers {
  onItem(item: StreamItem): void;
  onExit(exit: HeadExit): void;
}

export class ClaudeHead {
  private process: ManagedProcess | null = null;
  private buffer = "";
  private stderrTail = "";
  private printed = false;
  private expected = false;
  private closed = false;
  private exitedResolve!: () => void;
  /** Resolves when the CLI process has exited. */
  readonly exited = new Promise<void>((resolve) => (this.exitedResolve = resolve));
  running = false;

  constructor(readonly config: HeadConfig, private handlers: HeadHandlers, private adapter: ProcessTreeAdapter = processTreeAdapter()) {}

  get pid() {
    return this.process?.pid ?? -1;
  }

  start() {
    const args = [...(this.config.prefixArgs ?? []), ...headArguments(this.config)];
    const managed = this.adapter.spawn(this.config.command, args, { cwd: this.config.cwd, env: childEnvironment(this.config.env) });
    this.process = managed;
    this.running = true;
    const child = managed.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4_000); });
    child.stdin.on("error", () => { /* EPIPE once it exited */ });
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null, extra = "") => {
      if (reported) return;
      reported = true;
      this.running = false;
      this.closed = true;
      if (this.buffer.trim()) this.line(this.buffer.trim());
      this.buffer = "";
      this.exitedResolve();
      this.handlers.onExit({ code, signal, stderr: `${this.stderrTail}${extra}`.trim(), expected: this.expected, silent: !this.printed });
    };
    child.once("error", (error) => report(null, null, `Could not start ${this.config.command}: ${error.message}`));
    child.once("close", (code, signal) => report(code, signal));
  }

  private read(chunk: string) {
    this.printed = true;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
    }
  }

  private line(line: string) {
    for (const item of parseLine(line)) {
      if (item.kind === "unsupportedRequest") {
        // A request the app does not handle gets an error at once, so claude does not wait.
        this.write({ type: "control_response", response: { subtype: "error", request_id: item.requestId, error: "Not supported by Botling." } });
        continue;
      }
      this.handlers.onItem(item);
    }
  }

  private write(value: unknown) {
    if (this.closed || !this.process) return;
    this.process.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /**
   * A user message. `uuid` lets claude report its progress under that id. Pictures go in as base64
   * blocks so the model sees them (AgentProcess.swift's `write`); one claude does not take (another
   * type, over 4.5 MB, unreadable) is left to the path the text already names.
   */
  send(text: string, uuid: string, images: string[] = []) {
    const blocks: Record<string, unknown>[] = [];
    for (const path of images) {
      const mediaType = imageMediaType(path);
      if (!mediaType) continue;
      let data: Buffer;
      try { data = readFileSync(path); } catch { continue; }
      if (data.length > 4_500_000) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });
    }
    const content = blocks.length ? [{ type: "text", text }, ...blocks] : text;
    this.write({ type: "user", message: { role: "user", content }, uuid: uuid.toLowerCase() });
  }

  /** Answers a permission request: run it (with its input unchanged), or not (`message` says why to claude). */
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    const decision = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: message ?? "The user did not allow this." };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: decision } });
  }

  /** Stops the turn under way; claude ends it with an error result and the session goes on. */
  interrupt(): string {
    const requestId = `interrupt-${randomUUID()}`;
    this.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
    return requestId;
  }

  /** Closes stdin: claude finishes what it is doing, then exits (going to sleep). */
  finish() {
    this.expected = true;
    if (this.closed || !this.process) return;
    this.closed = true;
    this.process.child.stdin.end();
  }

  /** Ends the process and its whole tree now. */
  async terminate(graceMs = 1_500): Promise<TerminateResult> {
    this.expected = true;
    this.closed = true;
    if (!this.process) return { killed: [], forced: false };
    return this.process.terminate({ graceMs });
  }
}
