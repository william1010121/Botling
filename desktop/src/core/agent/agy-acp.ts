import { agyPromptRequest } from "../token-speed";
import { parseAntigravityUsage, quotaError, quotaUnavailable, registerAntigravityQuotaReader } from "../antigravity-quota";
import type { AntigravityQuotaView } from "../../contract";
import { registerAgyPermissions, updateAgyPermissions, forgetAgyPermissions } from "./agy-permissions";
// ACP is a separate transport. The legacy headless path in agy.ts stays blocked.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import type { AgyConfig } from "./agy";
import type { HeadHandlers } from "./head";
import type { StreamItem } from "./stream";
import { imageMediaType } from "../attachments";
import { agyWorkerRuntimeEnabled } from "./agy-capabilities";
import { createAgyWorkerHead } from "./agy-worker-router";
import { AgyWorkers } from "./agy-workers";
import type { CodexItem } from "./codex";
import { AGY_LOCAL_TOOLS, AgyMcpBridge, verifyAgyFileHelper } from "./agy-mcp";
import { processTreeAdapter, type ManagedProcess, type TerminateResult } from "../process/tree";

export const ACP_VERSION = "1.4.3";
export const ACP_SERVER_SHA = "1251927db3e21f3d693fd042d6890d82f65eb00587e97f1f3d8f0d798e7f0954";
export const ACP_HARNESS_SHA = "9e8fdc6e20a3262ca0a771850ca4a8414ca839a642cc964ec5c547cc2c33c200";
// Explicit inventory prevents new builtins, native delegation and browser agents from appearing.
export const ACP_TOOLS = ["finish"];
type Obj = Record<string, any>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const json = (v: unknown): string => typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
type Pending = { resolve(value: Obj): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Tested independently from process launch: no prompt is sent before the entire handshake. */
export class AgyAcpProtocol {
  private quotaPending?: Promise<AntigravityQuotaView>;
  private quotaCapture?: { text: string; invalid: boolean };
  private releaseQuota?: () => void;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private approvals = new Map<string, { id: string | number; allow: string; deny: string; title: string; input: Obj }>();
  private tools = new Set<string>();
  private completedTools = new Set<string>();
  private bridgeTools = new Set<string>();
  private closed = false;
  private ready = false;
  private busy = false;
  private cancelEpoch = 0;
  private turnCancelled = false;
  private turnFailure: "permission_denied" | "cancelled" | "tool_failed" | undefined;
  private confirmed = false;
  private submitting = false;
  private readonly mode: "default" | "yolo";
  get initialized() { return this.ready; }
  // Tool errors affect the result, not authorization to inspect or recover in this turn.
  get fullPermissionActive() { return this.mode === "yolo" && this.confirmed && this.ready && this.submitting && !this.closed && !this.turnCancelled && (!this.turnFailure || this.turnFailure === "tool_failed") && this.approvals.size === 0; }
  private text = "";
  private sessionId = "";
  private initialization: Promise<void> | null = null;
  constructor(private config: AgyConfig, private write: (message: Obj) => void, private emit: (item: StreamItem) => void, private fatal: (error: Error) => void, private transport: { localToolEvents?: boolean; mcpServers?: Promise<Obj[]>; onAllow?: (title: string, args: Obj) => void; onPolicy?: (state: "negotiating" | "ready" | "active" | "stopped" | "error", message: string) => void; revoke?: () => void } = {}) { this.mode = config.bypassPermissions === true ? "yolo" : "default"; }
  private call(method: string, params: Obj, timeout = 30_000): Promise<Obj> {
    if (this.closed) return Promise.reject(new Error("ACP connection closed."));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  start(): Promise<void> {
    return this.initialization ??= this.initialize().catch(error => { this.fail(error); throw error; });
  }
  private async initialize() {
    const init = await this.call("initialize", { protocolVersion: 1, clientInfo: { name: "Botling", version: "2" }, clientCapabilities: {} }, 60_000);
    if (init.protocolVersion !== 1 || init.agentInfo?.name !== "antigravity-acp" || init.agentInfo?.version !== ACP_VERSION) throw new Error("Unverified ACP server version; no task submitted.");
    if (this.config.resume && init.agentCapabilities?.loadSession !== true) throw new Error("ACP cannot restore this conversation.");
    const params: Obj = { cwd: this.config.cwd, mcpServers: await (this.transport.mcpServers ?? Promise.resolve([])), _meta: { antigravity: { enabledTools: ACP_TOOLS } } };
    if (this.config.systemPrompt) params._meta.antigravity.systemPrompt = { append: this.config.systemPrompt };
    if (this.config.resume) params.sessionId = this.config.sessionId;
    const session = await this.call(this.config.resume ? "session/load" : "session/new", params, 60_000);
    this.sessionId = this.config.resume ? this.config.sessionId : str(session.sessionId);
    if (!this.sessionId || (session.sessionId && session.sessionId !== this.sessionId)) throw new Error("ACP returned an invalid conversation identity.");
    await this.verifyMode();
    if (this.config.model) {
      const options = session.models?.availableModels;
      if (!Array.isArray(options) || !options.some((o: Obj) => o.modelId === this.config.model)) throw new Error(`ACP model unavailable: ${this.config.model}. Choose a model advertised by this account.`);
      await this.call("session/set_model", { sessionId: this.sessionId, modelId: this.config.model });
    }
    if (this.config.effort) {
      if (!["low", "medium", "high"].includes(this.config.effort)) throw new Error("ACP supports low, medium or high reasoning effort.");
      const result = await this.call("session/set_config_option", { sessionId: this.sessionId, configId: "thinking_level", value: this.config.effort });
      if (!result.configOptions?.some((o: Obj) => o.id === "thinking_level" && o.currentValue === this.config.effort)) throw new Error("ACP did not confirm reasoning effort.");
    }
    await this.verifyMode();
    if (this.closed) throw new Error("ACP cancelled during startup.");
    this.ready = true;
    if (this.config.acpHome && !this.config.worker) this.releaseQuota = registerAntigravityQuotaReader(dirname(dirname(this.config.acpHome)), () => this.readQuota());
    this.emit({ kind: "init", sessionId: this.sessionId });
  }
  private async verifyMode() {
    this.confirmed = false;
    this.transport.revoke?.();
    this.transport.onPolicy?.("negotiating", `Confirming ${this.mode === "yolo" ? "Full permission" : "approval"} mode with Antigravity.`);
    try {
      const result = await this.call("session/set_config_option", { sessionId: this.sessionId, configId: "mode", value: this.mode });
      const modes = result.configOptions?.filter((o: Obj) => o.id === "mode");
      if (this.closed || modes?.length !== 1 || modes[0].currentValue !== this.mode) throw new Error("Mode not confirmed");
      this.confirmed = true;
      this.transport.onPolicy?.("ready", `${this.mode === "yolo" ? "Full permission" : "Approval mode"} confirmed. Tools are available only during this session's active turn.`);
    } catch {
      throw new Error(`Antigravity did not confirm ${this.mode === "yolo" ? "Full permission (yolo)" : "default approval mode"}. No task submitted; runtime or administrator policy may refuse this mode.`);
    }
  }
  /** Official pinned server intercepts /usage before model execution. Read only
   * from an initialized idle session: no login, mode changes or chat events. */
  readQuota(): Promise<AntigravityQuotaView> {
    if (this.quotaPending) return this.quotaPending;
    if (!this.ready || this.closed) return Promise.resolve(quotaUnavailable());
    if (this.busy) return Promise.resolve(quotaUnavailable("busy"));
    const capture = this.quotaCapture = { text: "", invalid: false };
    this.quotaPending = this.call("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: "/usage" }] }, 15_000)
      .then(result => result.stopReason === "end_turn" && !capture.invalid ? parseAntigravityUsage(capture.text) : quotaError())
      .catch(error => {
        // ACP chunks have no turn ID. Close the idle connection after timeout
        // rather than letting late quota output enter the next user's turn.
        if (error instanceof Error && error.message.includes("timed out")) this.fail(new Error("Antigravity quota request timed out; connection closed to isolate late responses."));
        return quotaError();
      }).finally(() => { this.quotaCapture = undefined; this.quotaPending = undefined; });
    return this.quotaPending;
  }
  async send(text: string, uuid: string, images: string[] = []) {
    if (this.quotaPending) {
      const queuedEpoch = this.cancelEpoch;
      await this.quotaPending;
      if (this.closed || queuedEpoch !== this.cancelEpoch) return false;
    }
    if (this.busy) throw new Error("ACP does not support in-turn steering; wait for this turn to finish.");
    if (/^\s*\/(logout|usage)\b/i.test(text)) throw new Error("ACP account slash commands are not available through Botling.");
    this.busy = true;
    this.turnFailure = undefined;
    this.turnCancelled = false;
    const epoch = this.cancelEpoch;
    try {
      await this.start();
      await this.verifyMode();
      if (!this.ready || this.closed || epoch !== this.cancelEpoch) throw new Error("ACP cancelled before task submission.");
      this.text = ""; this.tools.clear(); this.completedTools.clear(); this.bridgeTools.clear();
      const prompt: Obj[] = [{ type: "text", text }];
      for (const path of images) {
        const mimeType = imageMediaType(path);
        if (!mimeType) throw new Error("Unsupported ACP image type.");
        const data = readFileSync(path);
        if (data.length > 4_500_000) throw new Error("ACP image exceeds 4.5 MB.");
        prompt.push({ type: "image", mimeType, data: data.toString("base64") });
      }
      this.emit({ kind: "command", id: uuid, state: "started" });
      this.submitting = true;
      this.transport.onPolicy?.("active", `${this.mode === "yolo" ? "Full permission" : "Approval mode"} active for this turn.`);
      const promptStart = Date.now();
      const result = await this.call("session/prompt", { sessionId: this.sessionId, prompt }, 30 * 60_000);
      const promptEnd = Date.now();
      this.cancelApprovals();
      const usage = obj(result.usage);
      const count = (key: string) => Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] as number : 0;
      if (result.usage) this.emit({kind:"usage",totalCost:0,tokens:{input:Math.max(0,count("inputTokens")-count("cachedReadTokens")),output:count("outputTokens")+count("thoughtTokens"),cacheRead:count("cachedReadTokens"),cacheWrite:count("cachedWriteTokens")}});
      const reason = this.turnFailure ?? (epoch !== this.cancelEpoch ? "cancelled" : str(result.stopReason));
      // ACP gives one usage block per prompt and no per-request timing: the whole prompt turn, an estimate.
      const request = agyPromptRequest(uuid, result.usage, promptStart, promptEnd, reason === "end_turn");
      if (request) this.emit({ kind: "request", request });
      this.emit({ kind: "result", ok: reason === "end_turn", text: this.text, error: reason === "end_turn" ? "" : `Antigravity stopped: ${reason || "unknown reason"}`, subtype: reason });
      return reason === "end_turn";
    } catch (error) {
      this.fail(error as Error);
    } finally { this.submitting = false; this.transport.revoke?.(); this.busy = false; if (!this.closed) this.transport.onPolicy?.("ready", this.confirmed ? `${this.mode === "yolo" ? "Full permission" : "Approval mode"} confirmed; no active turn.` : "Tools revoked. The next turn must confirm its permission mode again."); }
  }
  receive(value: unknown) {
    if (this.closed) return;
    try {
      const message = obj(value);
      if (message.jsonrpc !== "2.0") throw new Error("Invalid ACP frame.");
      if (!message.method && message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) throw new Error("Unexpected ACP response.");
        this.pending.delete(message.id); clearTimeout(pending.timer);
        // Avoid relaying authentication URLs/codes or secrets in server error details.
        if (message.error) pending.reject(new Error(`ACP request failed (${Number(message.error.code) || "protocol error"}). Conversation retained; check ACP authentication and availability.`));
        else pending.resolve(obj(message.result));
        return;
      }
      if (message.method === "session/request_permission") { this.permission(message); return; }
      if (message.id !== undefined) { this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client capability unavailable." } }); return; }
      if (message.method !== "session/update") return;
      const p = obj(message.params), u = obj(p.update);
      // load replays old text before returning; do not render it as this turn's output.
      if (!this.ready) return;
      if (p.sessionId !== this.sessionId) throw new Error("ACP update for another session.");
      if (u.sessionUpdate === "current_mode_update" && u.currentModeId !== this.mode) throw new Error("ACP changed approval mode unexpectedly.");
      if (u.sessionUpdate === "config_option_update" && u.configOptions?.some((o: Obj) => o.id === "mode" && o.currentValue !== this.mode)) throw new Error("ACP changed approval policy unexpectedly.");
      if (this.quotaCapture) {
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          this.quotaCapture.text += str(u.content.text);
          if (this.quotaCapture.text.length > 256_000) throw new Error("ACP quota response exceeds limit.");
        } else if (["tool_call", "tool_call_update", "agent_thought_chunk"].includes(u.sessionUpdate)) this.quotaCapture.invalid = true;
        return;
      }
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const text = str(u.content.text); this.text += text; this.emit({ kind: "delta", text });
      }
      if (["tool_call", "tool_call_update"].includes(u.sessionUpdate)) {
        const id = str(u.toolCallId); if (!id) throw new Error("ACP tool has no identity.");
        if (this.transport.localToolEvents && AGY_LOCAL_TOOLS.some(tool => u.title === `botling_${tool.name}`)) this.bridgeTools.add(id);
        if (this.bridgeTools.has(id)) {
          // Keep ACP's conservative turn/permission failure semantics, but never
          // overwrite bridge-owned execution cards with its mirrored results.
          if (u.status === "failed" && this.busy) this.turnFailure ??= "tool_failed";
          return;
        }
        if (!this.tools.has(id)) {
          this.tools.add(id); this.emit({ kind: "textBlock" });
          this.emit({ kind: "toolUse", id, tool: str(u.kind) || "ACP tool", title: str(u.title) || "Antigravity tool", detail: json(u.rawInput), input: obj(u.rawInput), parent: null });
        }
        if (["completed", "failed"].includes(u.status) && !this.completedTools.has(id)) {
          if (u.status === "failed" && this.busy) this.turnFailure ??= "tool_failed";
          this.completedTools.add(id);
          this.emit({ kind: "toolResult", id, output: json(u.rawOutput ?? u.content), failed: u.status === "failed", parent: null, launch: null });
        }
      }
    } catch (error) { this.fail(error as Error); }
  }
  private permission(message: Obj) {
    if (this.quotaCapture) {
      this.quotaCapture.invalid = true;
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const p = obj(message.params), options = Array.isArray(p.options) ? p.options : [];
    const allow = options.find((o: Obj) => o.kind === "allow_once" && o.optionId === "allow");
    const deny = options.find((o: Obj) => o.kind === "reject_once" && o.optionId === "deny");
    // Workspace-trust and ask_question are not tool approvals. Never convert their choices to allow.
    if (!this.ready || !this.busy || this.turnCancelled || p.sessionId !== this.sessionId || !allow || !deny) {
      if (this.busy && p.sessionId === this.sessionId && (!this.turnFailure || this.turnFailure === "tool_failed")) this.turnFailure = "permission_denied";
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }); return;
    }
    const requestId = `acp:${String(message.id)}`;
    if (this.approvals.has(requestId)) throw new Error("Duplicate ACP approval.");
    const tool = obj(p.toolCall);
    this.approvals.set(requestId, { id: message.id, allow: allow.optionId, deny: deny.optionId, title: str(tool.title), input: obj(tool.rawInput) });
    this.emit({ kind: "permission", requestId, tool: str(tool.kind) || "Antigravity tool", summary: str(tool.title) + "\n" + json(tool.rawInput), input: obj(tool.rawInput) });
  }
  answer(requestId: string, allow: boolean) {
    const pending = this.approvals.get(requestId); if (!pending || this.closed) return;
    this.approvals.delete(requestId);
    if (!allow) { this.turnFailure = "permission_denied"; this.transport.revoke?.(); }
    if (allow) this.transport.onAllow?.(pending.title, pending.input);
    this.write({ jsonrpc: "2.0", id: pending.id, result: { outcome: { outcome: "selected", optionId: allow ? pending.allow : pending.deny } } });
  }
  private cancelApprovals() {
    if (this.approvals.size && this.busy) this.turnFailure ??= "cancelled";
    for (const [requestId, pending] of this.approvals) {
      this.write({ jsonrpc: "2.0", id: pending.id, result: { outcome: { outcome: "cancelled" } } });
      this.emit({ kind: "permissionCancelled", requestId });
    }
    this.approvals.clear();
  }
  interrupt() {
    if (this.quotaCapture) this.quotaCapture.invalid = true;
    this.submitting = false; this.confirmed = false; this.transport.revoke?.();
    this.cancelEpoch++;
    if (this.busy) { this.turnCancelled = true; this.turnFailure ??= "cancelled"; }
    if (this.sessionId && !this.closed) this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.cancelApprovals();
  }
  close() {
    if (this.closed) return;
    this.interrupt(); this.closed = true; this.ready = false;
    this.releaseQuota?.(); this.releaseQuota = undefined;
    this.transport.onPolicy?.("stopped", "Session process stopped; no active tool permission.");
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("ACP connection closed.")); }
    this.pending.clear();
  }
  private fail(error: Error) { if (this.closed) return; this.close(); this.transport.onPolicy?.("error", error.message); this.fatal(error); }
}

/** Pin both executable artifacts, not a mutable settings assertion or a CLI flag. */
export function verifyAcpRuntime(command: string) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !isAbsolute(command)) throw new Error("Verified ACP 1.4.3 runtime required (macOS arm64). Legacy agy CLI remains disabled.");
  for (const [path, digest] of [[command, ACP_SERVER_SHA], [join(dirname(command), "localharness_external"), ACP_HARNESS_SHA]]) {
    if (createHash("sha256").update(readFileSync(path!)).digest("hex") !== digest) throw new Error("ACP runtime hash mismatch; no process started.");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", path!], { stdio: "ignore", timeout: 10_000 });
  }
}

/** Prepended to every turn the main chat head sends to Antigravity, whose built-in persona ignores the system rule. Never shown or archived: it is added inside the head, after the app has stored the turn. */
export const AGY_REPLY_REMINDER = "(Reply rule: at most 3 sentences, conclusion and next step only; no opening praise or filler, no headings, no bullet lists, no emoji; long content goes into a report page with a link; after dispatching subagents say only how many and what for, in one sentence.)";
export class AgyAcpHead {
  private process?: ManagedProcess;
  private bridge?: AgyMcpBridge;
  private workers?: AgyWorkers;
  private queue: { text: string; uuid: string; images: string[]; taskId?: string; taskRun?: number }[] = [];
  private sending = false;
  private reportTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private protocol?: AgyAcpProtocol;
  private buffer = "";
  private expected = false;
  private failure = "";
  private exitedResolve!: () => void;
  readonly exited = new Promise<void>(resolve => this.exitedResolve = resolve);
  running = false;
  constructor(readonly config: AgyConfig, private handlers: Omit<HeadHandlers, "onItem"> & { onItem(item: CodexItem): void }) {}
  get completionDependencies() { return this.workers?.completionDependencies ?? []; }
  get pid() { return this.process?.pid ?? -1; }
  start() {
    try { this.startRuntime(); }
    catch(error) { updateAgyPermissions(this,{state:"error",message:(error as Error).message}); throw error; }
  }
  private startRuntime() {
    if (this.config.worker && !agyWorkerRuntimeEnabled()) throw new Error("Antigravity app workers are disabled pending live lifecycle validation.");
    registerAgyPermissions(this, {sessionId:this.config.sessionId, mode:this.config.bypassPermissions === true ? "yolo" : "default", state:"negotiating", message:"Starting Antigravity; mode is not active yet."}, () => {
      this.protocol?.close(); this.bridge?.revoke(); this.stopped = true;
      void this.terminate(500).catch(() => updateAgyPermissions(this,{state:"error",message:"Permission revoked, but process cleanup failed. Stop the remaining process before continuing."}));
    });
    try { verifyAcpRuntime(this.config.command); } catch (error) { updateAgyPermissions(this, {state:"error",message:(error as Error).message}); throw error; }
    verifyAgyFileHelper(join(dirname(this.config.command), "botling-agy-file-helper"), this.config.cwd);
    if (!this.config.acpHome || !isAbsolute(this.config.acpHome)) throw new Error("ACP requires a private Botling profile.");
    const home = this.config.acpHome;
    mkdirSync(join(home, "antigravity-acp"), { recursive: true, mode: 0o700 });
    const cwd = realpathSync(this.config.cwd);
    mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config/hooks.json"), "{}", { mode: 0o600 });
    writeFileSync(join(home, "config/mcp_config.json"), "{}", { mode: 0o600 });
    // App-owned profile only. Never import the user's CLI/global hooks, policies, or allow caches.
    writeFileSync(join(home, "antigravity-acp/settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }), { mode: 0o600 });
    writeFileSync(join(home, "antigravity-acp/trusted_workspaces.json"), JSON.stringify({ trusted: [], untrusted: [cwd] }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { GEMINI_HOME: home };
    for (const key of ["HOME", "USER", "PATH", "TMPDIR", "LANG"]) if (process.env[key]) env[key] = process.env[key];
    const mcpServers = this.connectTools(cwd, home);
    void mcpServers.catch(() => {});
    this.process = processTreeAdapter().spawn(this.config.command, [], { cwd, env });
    const child = this.process.child; this.running = true;
    this.protocol = new AgyAcpProtocol(this.config, value => { if (child.stdin.writable) child.stdin.write(JSON.stringify(value) + "\n"); }, item => { if (item.kind === "init") { this.config.sessionId = item.sessionId; updateAgyPermissions(this, {sessionId:item.sessionId}); } this.handlers.onItem(item); }, error => {
      this.failure = error.message; this.stopped = true; void this.workers?.close(); void this.bridge?.close(); void this.process?.terminate({ graceMs: 500 });
    }, { localToolEvents: true, mcpServers, onAllow: (title, args) => this.bridge?.grant(title, args), revoke: () => this.bridge?.revoke(), onPolicy: (state,message) => { if (state === "active") this.bridge?.beginTurn(); updateAgyPermissions(this,{state,message}); } });
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    // Official ACP stderr can contain OAuth entry URLs; never expose it in chat/logs.
    child.stderr.resume();
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { this.failure = "ACP frame exceeds limit."; this.protocol?.close(); void this.process?.terminate(); return; }
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        try { this.protocol?.receive(JSON.parse(line)); }
        catch { this.failure = "Invalid ACP JSON."; this.protocol?.close(); void this.process?.terminate(); }
      }
    });
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null) => {
      if (reported) return; reported = true; this.running = false;
      this.protocol?.close(); this.stopped = true; clearTimeout(this.reportTimer); this.reportTimer = undefined;
      void Promise.allSettled([this.workers?.close(), this.bridge?.close(), this.process?.terminate({ graceMs: 500 })]).then(results => {
        if (results.some(result => result.status === "rejected")) this.failure ||= "ACP cleanup incomplete.";
        if (this.failure) updateAgyPermissions(this,{state:"error",message:this.failure});
        else forgetAgyPermissions(this);
        this.exitedResolve();
        this.handlers.onExit({ code, signal, stderr: this.failure, expected: this.expected, silent: true });
      });
    };
    child.once("error", () => { this.failure = "Unable to start verified ACP runtime."; report(null, null); });
    child.once("close", report);
    try { if (this.pid > 0) this.config.processStarted?.(this.pid); }
    catch (error) { this.failure = "Cannot register ACP process for cleanup."; void this.terminate(500); throw error; }
    void this.protocol.start().then(() => this.drain()).catch(() => {});
  }
  private connectTools(cwd:string, home:string) {
    if (!this.config.worker && agyWorkerRuntimeEnabled()) this.workers = new AgyWorkers(this.config, this.handlers.onItem,
      (taskId, text, taskRun) => { this.queue.push({text, uuid:randomUUID(), images:[], taskId, taskRun}); void this.drain(); },
      (config, handlers) => createAgyWorkerHead(config, handlers, (c,h) => new AgyAcpHead(c,h)));
    this.bridge = new AgyMcpBridge(cwd, home, this.workers ? (name,args) => this.workers!.tool(name,args) : undefined, this.config.processStarted, join(dirname(this.config.command), "botling-agy-file-helper"), () => this.protocol?.fullPermissionActive === true, item => this.handlers.onItem(item), this.config.addDirs);
    return this.bridge.start().then(server => [server]);
  }
  send(text: string, uuid: string, images: string[] = []) {
    if (!this.protocol || this.stopped) throw new Error("ACP not running.");
    const sent = this.config.worker ? text : `${AGY_REPLY_REMINDER}\n\n${text}`;
    this.queue.unshift({text: sent, uuid, images}); void this.drain();
  }
  private async drain() {
    if (this.sending || this.stopped || !this.protocol) return;
    const request = this.queue[0]; if (!request) return;
    if (request.taskId && this.config.canStartReport && !this.config.canStartReport()) {
      clearTimeout(this.reportTimer);
      this.reportTimer = setTimeout(() => { this.reportTimer = undefined; void this.drain(); }, 100);
      return;
    }
    clearTimeout(this.reportTimer); this.reportTimer = undefined;
    this.queue.shift();
    if (request.taskId && (request.taskRun === undefined || !this.workers?.beginReport(request.taskId, request.taskRun))) {
      void this.drain(); return; // stale, duplicate or uncertain report; never submit a model task.
    }
    this.sending = true;
    if (request.taskId) this.handlers.onItem({kind:"backgroundTurn", taskId:request.taskId});
    try { const completed = await this.protocol.send(request.text, request.uuid, request.images);
      if (request.taskId && request.taskRun !== undefined) this.workers?.finishReport(request.taskId, request.taskRun, completed === true);
    }
    catch (error) { this.failure = (error as Error).message; await this.terminate(); }
    finally {
      this.bridge?.revoke(); this.sending = false;
      this.handlers.onItem({kind:"managedPending",pending:!!this.workers?.completionDependencies.length || this.queue.some(q=>!!q.taskId)});
      void this.drain();
    }
  }
  answer(id: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    if (id.startsWith("worker:")) this.workers?.answer(id,allow,input,message);
    else if (id.startsWith("agy-mcp:")) this.bridge?.answer(id,allow);
    else this.protocol?.answer(id, allow);
  }
  allow(_rules: string[]): never { throw new Error("ACP accepts single-action approval only; persistent allow rules are unavailable."); }
  interrupt(): string { clearTimeout(this.reportTimer); this.reportTimer = undefined; this.queue = []; this.protocol?.interrupt(); void this.bridge?.cancel(); void this.workers?.cancel(); if (!this.protocol?.initialized) void this.terminate(500); return randomUUID(); }
  finish() { void this.terminate(500); }
  async terminate(graceMs = 1500): Promise<TerminateResult> { this.expected = true; this.stopped = true; clearTimeout(this.reportTimer); this.reportTimer = undefined; this.queue = []; this.protocol?.close(); const cleanup = await Promise.allSettled([this.workers?.close(), this.bridge?.close(), this.process?.terminate({ graceMs })]);
    if (cleanup.some(result => result.status === "rejected")) { this.failure ||= "ACP cleanup incomplete."; throw new Error(this.failure); }
    const processResult = cleanup[2]; return processResult?.status === "fulfilled" && processResult.value ? processResult.value : { killed: [], forced: false }; }
}
