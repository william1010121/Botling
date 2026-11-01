import { ClaudeRequestTracker } from "../token-speed";
import { claudeMonitorDecision, MONITOR_HOOK } from "./monitor-policy";
import { claudeAutoRiskSettings } from "./auto-risk-policy";
import { claudeHotEffortEnabled, settingsChange, type HotSettings } from "./hot-settings";
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
import { claudeEnvironment } from "./runner";
import { cliStartError, resolveExecutable } from "../process/executable";
import { ClaudeTokenFlowMeter } from "../token-flow-claude";
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
  /** Explicit tool inventory for an app execution role; omitted for ordinary heads. */
  tools?: string[];
  /** Only an app-owned coordinator sets false. Missing ownership denies Monitor. */
  monitorWorker?: boolean;
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
  /** false: nothing is asked about (`asksPermission` off): no permission prompt tool. */
  askPermission?: boolean;
  /** With `resume`: go on in a copy of that session (`--fork-session`), leaving it as it was. */
  forkSession?: boolean;
  /** false: its transcript is not kept (`--no-session-persistence`). */
  persistSession?: boolean;
  /** Tools it may not use at all (`--disallowedTools`, beside AskUserQuestion when it asks). */
  disallowedTools?: string[];
  /**
   * Claude Code's auto mode (`--permission-mode auto`, 1.x's `autoMode`): its classifier approves safe
   * actions itself and blocks risky ones; only what it still asks about comes as a permission request.
   * Off: `acceptEdits`, and every tool not allowed is asked about.
   */
  autoMode?: boolean;
  /** Explicit app opt-in; harmless test sessions still retain their restrictions. */
  bypassPermissions?: boolean;
  /** Permission rules let through without asking ("Bash(rm -rf build)"): calls the user allowed after auto mode blocked them (`--settings`). */
  allowRules?: string[];
  /**
   * The app's own tools (app_handoff, …), served by this process's host over the SDK control channel: `--mcp-config`
   * names an in-process ("sdk") server and claude sends its MCP requests as `mcp_message` control requests, answered
   * by `HeadHandlers.onAppTool`. Its tools are allowed without asking (`mcp__<server>__<tool>`). None in harmless mode.
   */
  appMcp?: { server: string; tools: AppToolSpec[] } | null;
  /**
   * Native subagents are off: Agent and Task are removed (`--disallowedTools`; spike S6: the init list names it Task,
   * calls name it Agent), and a PreToolUse hook denies any call that still comes with this reason, in case a CLI
   * version ignores the disallow. None in harmless mode.
   */
  agentGuard?: string | null;
}

/** One app tool as MCP's tools/list gives it. */
export interface AppToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

/** The PreToolUse hook that keeps native subagents out of a head whose workers the app manages. */
export const AGENT_GUARD_HOOK = "botling-agent-guard";
const NATIVE_AGENT_TOOLS = ["Agent", "Task"];

/** The hook's answer: every Agent/Task call is denied with `reason` (shown to the model as "PreToolUse:Agent hook error: <reason>"). */
export function agentGuardDecision(input: any, reason: string): Record<string, unknown> {
  if (input?.hook_event_name !== "PreToolUse" || !NATIVE_AGENT_TOOLS.includes(input?.tool_name)) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** Only normal bot sessions explicitly carry the app setting. Auxiliary sessions omit it. */
export function claudeSessionPermissionConfig(session: { autoMode?: boolean; allowRules?: string[]; claudeBypassPermissions?: boolean }) {
  return { autoMode: session.autoMode ?? false, allowRules: session.allowRules ?? [], bypassPermissions: session.claudeBypassPermissions === true };
}

/** claude's arguments for a long-lived head (cf. `ClaudeAgentProcess.arguments`). */
export function headArguments(config: HeadConfig): string[] {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    config.resume ? "--resume" : "--session-id", config.sessionId,
    "--permission-mode", config.harmless ? "default" : config.bypassPermissions ? "bypassPermissions" : config.autoMode ? "auto" : "acceptEdits",
  ];
  if (config.forkSession && config.resume) args.push("--fork-session");
  if (config.persistSession === false && !config.harmless) args.push("--no-session-persistence");
  // Approvals are asked on stdout and answered on stdin.
  if (config.askPermission !== false) args.push("--permission-prompt-tool", "stdio");
  // Bots ask in the chat; AskUserQuestion would arrive as a permission request with no way to answer it.
  const guard = !!config.agentGuard && !config.harmless;
  const disallowed = [...new Set([...(config.askPermission !== false ? ["AskUserQuestion"] : []), ...(guard ? NATIVE_AGENT_TOOLS : []), ...(config.disallowedTools ?? [])])];
  if (disallowed.length) args.push("--disallowedTools", disallowed.join(","));
  const app = config.appMcp && !config.harmless ? config.appMcp : null;
  const allowed = config.harmless ? [] : [...new Set([...config.allowedTools, ...(app?.tools.map((tool) => `mcp__${app.server}__${tool.name}`) ?? [])])];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (config.tools && !config.harmless) args.push("--tools", config.tools.join(","));
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", config.effort);
  // In `--settings`, as a command may hold commas (AgentProcess.swift's `settingsJSON`).
  if (!config.harmless) {
    const settings = { ...JSON.parse(allowSettings(config.allowRules ?? [])), ...claudeAutoRiskSettings(config.autoMode, config.bypassPermissions) };
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
  }
  // The app's own instructions (Prompts.swift's). Not in harmless mode: they rely on Read/Write/Edit
  // (memory.md, routines), and a live run with no tools but these instructions wrote fake tool calls
  // as text for minutes instead of answering (Phase 2a).
  if (config.systemPrompt && !config.harmless) args.push("--append-system-prompt", config.systemPrompt);
  if (!config.harmless) for (const dir of config.pluginDirs ?? []) args.push("--plugin-dir", dir);
  if (!config.harmless) for (const dir of config.addDirs ?? []) args.push("--add-dir", dir);
  if (app) args.push("--mcp-config", JSON.stringify({ mcpServers: { [app.server]: { type: "sdk", name: app.server } } }));
  if (config.harmless) {
    args.push("--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--tools", (config.harmlessTools ?? []).join(","));
  }
  return args;
}

/** `{"permissions":{"allow":[…]}}`: the flag settings layer's allow rules; the user's own settings files stay as they are. */
export function allowSettings(rules: string[]): string {
  return JSON.stringify(rules.length ? { permissions: { allow: rules } } : {});
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
  /** An app tool call (`HeadConfig.appMcp`): its result (JSON-able), or a thrown error the model reads. */
  onAppTool?(name: string, args: Record<string, unknown>): Promise<unknown>;
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
  private monitorInit: string | null = null;
  private monitorPolicyFailed = false;
  private monitorInitTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedMessages: unknown[] = [];
  /** Control requests the app waits on (`set_model`, …): resolved with whether claude answered success. */
  private controls = new Map<string, { resolve(ok: boolean): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(readonly config: HeadConfig, private handlers: HeadHandlers, private adapter: ProcessTreeAdapter = processTreeAdapter()) {}

  get pid() {
    return this.process?.pid ?? -1;
  }

  start() {
    const args = [...(this.config.prefixArgs ?? []), ...headArguments(this.config)];
    const env = claudeEnvironment(this.config.env);
    const managed = this.adapter.spawn(resolveExecutable(this.config.command, env), args, { cwd: this.config.cwd, env });
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
      if (this.monitorInitTimer) clearTimeout(this.monitorInitTimer);
      this.queuedMessages = [];
      this.running = false;
      this.closed = true;
      this.settleControls();
      if (this.buffer.trim()) this.line(this.buffer.trim());
      this.buffer = "";
      this.exitedResolve();
      this.handlers.onExit({ code, signal, stderr: `${this.stderrTail}${extra}`.trim(), expected: this.expected, silent: !this.printed });
    };
    child.once("error", (error) => report(null, null, cliStartError("claude", this.config.command, error)));
    child.once("close", (code, signal) => report(code, signal));
    // The SDK control hook runs before execution, including auto/bypass mode.
    // Unsupported CLIs fail closed before any queued user input is sent.
    // The app's tools and the native-subagent guard register in the same initialize, before any input.
    const monitor = !this.config.harmless && (!this.config.tools || this.config.tools.includes("Monitor"));
    const guard = !this.config.harmless && !!this.config.agentGuard;
    const app = !this.config.harmless && this.config.appMcp ? this.config.appMcp : null;
    if (monitor || guard || app) {
      this.monitorInit = `monitor-policy-${randomUUID()}`;
      this.monitorInitTimer = setTimeout(() => this.failMonitorPolicy(), 10_000);
      this.monitorInitTimer.unref();
      const hooks = [...(monitor ? [{ matcher: "^Monitor$", hookCallbackIds: [MONITOR_HOOK] }] : []), ...(guard ? [{ matcher: "^(Agent|Task)$", hookCallbackIds: [AGENT_GUARD_HOOK] }] : [])];
      this.write({ type: "control_request", request_id: this.monitorInit, request: { subtype: "initialize",
        ...(hooks.length ? { hooks: { PreToolUse: hooks } } : {}), ...(app ? { sdkMcpServers: [app.server] } : {}) } });
    }
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

  private flowMeter?: ClaudeTokenFlowMeter;
  private speed = new ClaudeRequestTracker();
  private failMonitorPolicy() {
    this.monitorPolicyFailed = true;
    if (this.monitorInitTimer) clearTimeout(this.monitorInitTimer);
    this.queuedMessages = [];
    this.stderrTail += "\nBotling could not register its tool policy (coordinator-only monitor enforcement, the native subagent guard, the app tools); no queued user input was sent.";
    void this.process?.terminate({ graceMs: 0 });
  }

  private line(line: string) {
    this.flowMeter ??= new ClaudeTokenFlowMeter(this.config.sessionId);
    const measurements = this.flowMeter.observe(line);
    let message: any;
    try { message = JSON.parse(line); } catch { /* parseLine handles other input */ }
    if (this.monitorInit && message?.type === "control_response" && message.response?.request_id === this.monitorInit) {
      if (this.monitorPolicyFailed) return;
      if (message.response.subtype !== "success") { this.failMonitorPolicy(); return; }
      if (this.monitorInitTimer) clearTimeout(this.monitorInitTimer);
      this.monitorInit = null;
      for (const queued of this.queuedMessages.splice(0)) this.write(queued);
      return;
    }
    const control = message?.type === "control_response" ? this.controls.get(message.response?.request_id) : undefined;
    if (control) {
      this.controls.delete(message.response.request_id);
      clearTimeout(control.timer);
      control.resolve(message.response.subtype === "success");
      return;
    }
    if (message?.type === "control_request" && message.request?.subtype === "hook_callback" && message.request.callback_id === MONITOR_HOOK) {
      this.write({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: claudeMonitorDecision(message.request.input, this.config.monitorWorker !== false) } });
      return;
    }
    if (message?.type === "control_request" && message.request?.subtype === "hook_callback" && message.request.callback_id === AGENT_GUARD_HOOK) {
      this.write({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: agentGuardDecision(message.request.input, this.config.agentGuard ?? "Native subagents are off here.") } });
      return;
    }
    if (message?.type === "control_request" && message.request?.subtype === "mcp_message") { void this.appMcp(message); return; }
    for (const request of this.speed.observe(message, Date.now())) this.handlers.onItem({ kind: "request", request });
    for (const item of parseLine(line)) {
      if (item.kind === "unsupportedRequest") {
        // A request the app does not handle gets an error at once, so claude does not wait.
        this.write({ type: "control_response", response: { subtype: "error", request_id: item.requestId, error: "Not supported by Botling." } });
        continue;
      }
      this.handlers.onItem(item);
    }
    for (const measurement of measurements) this.handlers.onItem({ kind: "measurement", provider: "claude", measurement });
  }

  /** One MCP request for the app's in-process server (`HeadConfig.appMcp`), answered on the control channel. */
  private async appMcp(message: any) {
    const app = this.config.harmless ? null : this.config.appMcp;
    const rpc = message.request.message ?? {};
    const answer = (mcp: Record<string, unknown>) => this.write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { mcp_response: { jsonrpc: "2.0", ...mcp } } } });
    if (!app || message.request.server_name !== app.server) {
      this.write({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Unknown MCP server." } });
      return;
    }
    if (rpc.id === undefined || rpc.id === null) { answer({ result: {} }); return; } // a notification
    const id = rpc.id;
    switch (rpc.method) {
      case "initialize": answer({ id, result: { protocolVersion: typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: app.server, version: "1" } } }); return;
      case "ping": answer({ id, result: {} }); return;
      case "tools/list": answer({ id, result: { tools: app.tools } }); return;
      case "tools/call": {
        const name = String(rpc.params?.name ?? "");
        const args = rpc.params?.arguments && typeof rpc.params.arguments === "object" && !Array.isArray(rpc.params.arguments) ? rpc.params.arguments as Record<string, unknown> : {};
        let text: string, isError = false;
        try {
          if (!app.tools.some((tool) => tool.name === name) || !this.handlers.onAppTool) throw new Error(`Unknown app tool ${name}.`);
          const result = await this.handlers.onAppTool(name, args);
          text = typeof result === "string" ? result : JSON.stringify(result);
        } catch (error) { text = (error as Error).message; isError = true; }
        answer({ id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
        return;
      }
      default: answer({ id, error: { code: -32601, message: `Unsupported MCP method ${String(rpc.method)}.` } });
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
    if (this.monitorPolicyFailed) return;
    const blocks: Record<string, unknown>[] = [];
    for (const path of images) {
      const mediaType = imageMediaType(path);
      if (!mediaType) continue;
      let data: Buffer;
      try { data = readFileSync(path); } catch { continue; }
      if (data.length > 4_500_000) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });
    }
    this.speed.boundary(null, Date.now());
    const content = blocks.length ? [{ type: "text", text }, ...blocks] : text;
    const message = { type: "user", message: { role: "user", content }, uuid: uuid.toLowerCase() };
    if (this.monitorInit) this.queuedMessages.push(message); else this.write(message);
  }

  /** Answers a permission request: run it (with its input unchanged), or not (`message` says why to claude). */
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    const decision = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: message ?? "The user did not allow this." };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: decision } });
  }

  /** Lets these permission rules through from now on in the running session (`apply_flag_settings`, 1.x's `allow(rules:)`). */
  allow(rules: string[]) {
    this.write({ type: "control_request", request_id: `allow-${randomUUID()}`, request: { subtype: "apply_flag_settings", settings: { permissions: { allow: rules }, ...(!this.config.harmless ? claudeAutoRiskSettings(this.config.autoMode, this.config.bypassPermissions) : {}) } } });
  }

  /** A control request whose answer the app waits for: true when claude answers success (false: error, no answer in time, or it exited). */
  private control(request: Record<string, unknown>, prefix: string, timeoutMs: number): Promise<boolean> {
    if (this.closed || !this.process || this.monitorPolicyFailed) return Promise.resolve(false);
    const requestId = `${prefix}-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.controls.delete(requestId); resolve(false); }, timeoutMs);
      timer.unref?.();
      this.controls.set(requestId, { resolve, timer });
      const message = { type: "control_request", request_id: requestId, request };
      // Before the monitor hook is registered nothing else goes in: it waits with the queued messages.
      if (this.monitorInit) this.queuedMessages.push(message); else this.write(message);
    });
  }

  private settleControls() {
    for (const { resolve, timer } of this.controls.values()) { clearTimeout(timer); resolve(false); }
    this.controls.clear();
  }

  /**
   * Its model (and effort, where that is on) from the next turn on, in this same process: `set_model`
   * (null: claude's default), `apply_flag_settings` `{effortLevel}`. False: not applied (refused, failed, no
   * answer in time, or the change is one it does not take in place); the bot restarts it instead.
   */
  async applySettings(target: HotSettings, timeoutMs = 5_000): Promise<boolean> {
    if (!this.canApplySettings(target)) return false;
    const change = settingsChange(target, this.config);
    if ("model" in change) {
      if (!await this.control(change.model ? { subtype: "set_model", model: change.model } : { subtype: "set_model" }, "set-model", timeoutMs)) return false;
      this.config.model = change.model;
    }
    if ("effort" in change) {
      if (!await this.control({ subtype: "apply_flag_settings", settings: { effortLevel: change.effort } }, "set-effort", timeoutMs)) return false;
      this.config.effort = change.effort;
    }
    return !this.closed;
  }

  /** Whether `applySettings` would try `target` (its model always; its effort only where that is on). */
  canApplySettings(target: HotSettings): boolean {
    return !this.closed && !!this.process && !this.monitorPolicyFailed && !("effort" in settingsChange(target, this.config) && !claudeHotEffortEnabled());
  }

  /** Stops the turn under way; claude ends it with an error result and the session goes on. */
  interrupt(): string {
    this.queuedMessages = [];
    const requestId = `interrupt-${randomUUID()}`;
    this.write({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
    return requestId;
  }

  /** Closes stdin: claude finishes what it is doing, then exits (going to sleep). */
  finish() {
    if (this.monitorInitTimer) clearTimeout(this.monitorInitTimer);
    this.queuedMessages = [];
    this.expected = true;
    if (this.closed || !this.process) return;
    this.closed = true;
    this.process.child.stdin.end();
  }

  /** Ends the process and its whole tree now. */
  async terminate(graceMs = 1_500): Promise<TerminateResult> {
    if (this.monitorInitTimer) clearTimeout(this.monitorInitTimer);
    this.queuedMessages = [];
    this.expected = true;
    this.closed = true;
    if (!this.process) return { killed: [], forced: false };
    return this.process.terminate({ graceMs });
  }
}
