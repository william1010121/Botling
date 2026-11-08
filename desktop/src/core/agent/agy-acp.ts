import { AgyTurnClock, agyPromptRequest } from "../token-speed";
import { registerAntigravityQuotaReader } from "../antigravity-quota";
import { agySignInEnv, readAgyQuota } from "../agy-quota-api";
import { AgyTurnUsage, callTokens } from "../agy-usage-db";
import { recordAgyWindow } from "../agy-window";
import { registerAgyPermissions, updateAgyPermissions, forgetAgyPermissions } from "./agy-permissions";
// ACP is a separate transport. The legacy headless path in agy.ts stays blocked.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import type { AgyConfig } from "./agy";
import type { HeadHandlers } from "./head";
import type { StreamItem } from "./stream";
import { classifyRun, type RunEnd, type WorkerCoreFactory } from "../worker-core";
import { imageMediaType } from "../attachments";
import { agyWorkerRuntimeEnabled } from "./agy-capabilities";
import { agyHotSettingsEnabled, settingsChange, type HotSettings } from "./hot-settings";
import { createAgyWorkerHead } from "./agy-worker-router";
import { AgyWorkers, agyWorkerHost } from "./agy-workers";
import type { WorkerInfo, WorkerOwner, WorkerOwnerResult, WorkerSendResult } from "./workers";
import type { CodexItem } from "./codex";
import { AGY_LOCAL_TOOLS, AgyMcpBridge, verifyAgyFileHelper } from "./agy-mcp";
import { DEFAULT_SPEC_WRITERS, maySpecWrite } from "../spec-guard";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";

/**
 * The plugins' skills for an app-owned profile (engine-skills.ts): `<home>/config/skills.json`, the global customization
 * root's skills config (GEMINI_HOME is `home`), with one entry per skill folder, each scanned one level deep. No folders:
 * the file is removed, so a plugin turned off leaves nothing behind. Only this file: the user's own ~/.gemini is never read.
 */
export function writeAgySkills(home: string, roots: readonly string[]) {
  const file = join(home, "config/skills.json");
  if (!roots.length) { rmSync(file, { force: true }); return; }
  writeFileSync(file, `${JSON.stringify({ entries: roots.map((path) => ({ path })) }, null, 2)}\n`, { mode: 0o600 });
}
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
  private releaseQuota?: () => void;
  /** What agy's conversation file says each turn used (its calls, retries and models), when there is one. */
  private dbUsage?: AgyTurnUsage;
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
  /** This turn's tools that failed (ACP's own and the bridge's mirrored ones), for classifyRun. */
  private failedTools = new Set<string>();
  /** This turn's model time: the turn minus the time a tool (with its approval) was open. */
  private turnClock?: AgyTurnClock;
  private confirmed = false;
  private submitting = false;
  private readonly mode: "default" | "yolo";
  get initialized() { return this.ready; }
  /** An approval card of this turn is open (its tool call is still at work). */
  get approving() { return this.approvals.size > 0; }
  // Tool errors affect the result, not authorization to inspect or recover in this turn.
  get fullPermissionActive() { return this.mode === "yolo" && this.confirmed && this.ready && this.submitting && !this.closed && !this.turnCancelled && (!this.turnFailure || this.turnFailure === "tool_failed") && this.approvals.size === 0; }
  private text = "";
  private sessionId = "";
  /** The models the conversation advertised when it started (`session.models.availableModels`). */
  private models: string[] = [];
  /** A model/effort change being applied between turns: a prompt waits for it. */
  private settingsPending?: Promise<boolean>;
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
    const advertised = session.models?.availableModels;
    this.models = Array.isArray(advertised) ? advertised.map((o: Obj) => str(o?.modelId)).filter(Boolean) : [];
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
    const home = this.config.acpHome;
    if (home) this.dbUsage = new AgyTurnUsage(home, () => this.sessionId);
    if (home && !this.config.worker) this.releaseQuota = registerAntigravityQuotaReader(dirname(dirname(home)), () => readAgyQuota(home));
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
  /**
   * Its model and effort from its next turn on, in this same conversation (`session/set_model`, the
   * `thinking_level` option, as at startup). Only between turns of an initialized conversation; false (and
   * the bot restarts it instead): busy, a value it cannot set (an unadvertised model, going back to the
   * default), a refused request, or an effort it did not confirm.
   */
  canApplySettings(target: HotSettings): boolean {
    const change = settingsChange(target, this.config);
    if (!this.ready || this.closed || this.busy || this.settingsPending) return false;
    return !("model" in change && (!change.model || !this.models.includes(change.model))) && !("effort" in change && (!change.effort || !["low", "medium", "high"].includes(change.effort)));
  }
  applySettings(target: HotSettings): Promise<boolean> {
    if (!this.canApplySettings(target)) return Promise.resolve(false);
    const change = settingsChange(target, this.config);
    const apply = async () => {
      if (change.model) {
        await this.call("session/set_model", { sessionId: this.sessionId, modelId: change.model });
        this.config.model = change.model;
      }
      if (change.effort) {
        const result = await this.call("session/set_config_option", { sessionId: this.sessionId, configId: "thinking_level", value: change.effort });
        if (!result.configOptions?.some((o: Obj) => o.id === "thinking_level" && o.currentValue === change.effort)) return false;
        this.config.effort = change.effort;
      }
      return !this.closed;
    };
    const pending = this.settingsPending = apply().catch(() => false).finally(() => { if (this.settingsPending === pending) this.settingsPending = undefined; });
    return pending;
  }
  async send(text: string, uuid: string, images: string[] = []) {
    if (this.settingsPending) await this.settingsPending;
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
      this.text = ""; this.tools.clear(); this.completedTools.clear(); this.bridgeTools.clear(); this.failedTools.clear();
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
      this.dbUsage?.mark();
      const promptStart = Date.now();
      const clock = this.turnClock = new AgyTurnClock(promptStart);
      const result = await this.call("session/prompt", { sessionId: this.sessionId, prompt }, 30 * 60_000);
      const promptEnd = Date.now();
      this.turnClock = undefined;
      this.cancelApprovals();
      const usage = obj(result.usage);
      const count = (key: string) => Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] as number : 0;
      // agy's own record of the turn's calls (retries included) when it has one; else the prompt's one usage block.
      const recorded = callTokens(this.dbUsage?.take() ?? []);
      if (recorded) this.emit({ kind: "usage", totalCost: 0, tokens: recorded });
      else if (result.usage) this.emit({kind:"usage",totalCost:0,tokens:{input:Math.max(0,count("inputTokens")-count("cachedReadTokens")),output:count("outputTokens")+count("thoughtTokens"),cacheRead:count("cachedReadTokens"),cacheWrite:count("cachedWriteTokens")}});
      const stop = epoch !== this.cancelEpoch ? "cancelled" : str(result.stopReason);
      // tool_failed means "ended its turn normally after a failed tool"; it never hides another stop.
      const reason = this.turnFailure && (this.turnFailure !== "tool_failed" || stop === "end_turn") ? this.turnFailure : stop;
      const how = this.ended(stop), error = `Antigravity stopped: ${reason || "unknown reason"}`, failedTools = this.failedTools.size;
      // The one rule for every engine (classifyRun): a turn that ended normally with a reply succeeds, whatever failed on the way.
      const ok = classifyRun({ end: { how, finalText: null, error, detail: reason }, reply: this.text, stoppedByApp: false, interruptedBy: null, requireReply: false, failedTools, engine: "agy" }).status === "done";
      // ACP gives one usage block per prompt and no per-request timing: the turn's tokens over its model time (tool runs
      // and approval waits taken out), an estimate. A turn that ended with its usage is timed whatever its verdict, as a
      // Claude or Codex request is; only a cancelled one is not.
      const request = agyPromptRequest(uuid, recorded ? { outputTokens: recorded.output } : result.usage, promptStart, promptEnd, how !== "cancelled", clock.finish(promptEnd));
      if (request) this.emit({ kind: "request", request });
      this.emit({ kind: "result", ok, how, failedTools, text: this.text, error: ok ? "" : error, subtype: reason });
      return ok;
    } catch (error) {
      this.fail(error as Error);
    } finally { this.turnClock = undefined; this.submitting = false; this.transport.revoke?.(); this.busy = false; if (!this.closed) this.transport.onPolicy?.("ready", this.confirmed ? `${this.mode === "yolo" ? "Full permission" : "Approval mode"} confirmed; no active turn.` : "Tools revoked. The next turn must confirm its permission mode again."); }
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
      // The model's full window (`size`), kept for workspace.agyUsage; not `used`. Wanted at any time, also between turns.
      if (u.sessionUpdate === "usage_update") { if (this.sessionId && p.sessionId === this.sessionId) recordAgyWindow(this.sessionId, u.size); return; }
      // load replays old text before returning; do not render it as this turn's output.
      if (!this.ready) return;
      if (p.sessionId !== this.sessionId) throw new Error("ACP update for another session.");
      if (u.sessionUpdate === "current_mode_update" && u.currentModeId !== this.mode) throw new Error("ACP changed approval mode unexpectedly.");
      if (u.sessionUpdate === "config_option_update" && u.configOptions?.some((o: Obj) => o.id === "mode" && o.currentValue !== this.mode)) throw new Error("ACP changed approval policy unexpectedly.");
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        const text = str(u.content.text); this.text += text; this.emit({ kind: "delta", text });
      }
      if (["tool_call", "tool_call_update"].includes(u.sessionUpdate)) {
        const id = str(u.toolCallId); if (!id) throw new Error("ACP tool has no identity.");
        if (this.turnClock) {
          const at = Date.now();
          this.turnClock.toolOpened(id, at);
          if (["completed", "failed"].includes(u.status)) this.turnClock.toolClosed(id, at);
        }
        if (this.transport.localToolEvents && AGY_LOCAL_TOOLS.some(tool => u.title === `botling_${tool.name}`)) this.bridgeTools.add(id);
        if (this.bridgeTools.has(id)) {
          // Keep ACP's conservative turn/permission failure semantics, but never
          // overwrite bridge-owned execution cards with its mirrored results.
          if (u.status === "failed" && this.busy) { this.turnFailure ??= "tool_failed"; this.failedTools.add(id); }
          return;
        }
        if (!this.tools.has(id)) {
          this.tools.add(id); this.emit({ kind: "textBlock" });
          this.emit({ kind: "toolUse", id, tool: str(u.kind) || "ACP tool", title: str(u.title) || "Antigravity tool", detail: json(u.rawInput), input: obj(u.rawInput), parent: null });
        }
        if (["completed", "failed"].includes(u.status) && !this.completedTools.has(id)) {
          if (u.status === "failed" && this.busy) { this.turnFailure ??= "tool_failed"; this.failedTools.add(id); }
          this.completedTools.add(id);
          this.emit({ kind: "toolResult", id, output: json(u.rawOutput ?? u.content), failed: u.status === "failed", parent: null, launch: null });
        }
      }
    } catch (error) { this.fail(error as Error); }
  }
  /**
   * How the engine ended this turn (worker-core RunEnd): its stop reason, whatever tool failed on the way. An approval
   * still open at the end makes it a cancelled turn. A denied approval ends the main chat's turn as an error; a
   * worker's denial is only a note in its report (shared-core decision D2), so its turn ended normally.
   */
  private ended(stop: string): RunEnd["how"] {
    if (stop === "cancelled" || this.turnFailure === "cancelled") return "cancelled";
    if (stop !== "end_turn") return "error";
    return this.turnFailure === "permission_denied" && !this.config.worker ? "error" : "normal";
  }
  private permission(message: Obj) {
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
    // The approval waits inside its tool's span; a tool announced only by its approval opens here.
    if (str(tool.toolCallId)) this.turnClock?.toolOpened(str(tool.toolCallId), Date.now());
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
    if (this.approvals.size && this.busy && (!this.turnFailure || this.turnFailure === "tool_failed")) this.turnFailure = "cancelled";
    for (const [requestId, pending] of this.approvals) {
      this.write({ jsonrpc: "2.0", id: pending.id, result: { outcome: { outcome: "cancelled" } } });
      this.emit({ kind: "permissionCancelled", requestId });
    }
    this.approvals.clear();
  }
  interrupt() {
    this.submitting = false; this.confirmed = false; this.transport.revoke?.();
    this.cancelEpoch++;
    if (this.busy) { this.turnCancelled = true; if (!this.turnFailure || this.turnFailure === "tool_failed") this.turnFailure = "cancelled"; }
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
/**
 * What heads the words that ride on a tool result of the turn under way (`AgyAcpHead.offerInsert`): ACP has no way to put
 * words into a running prompt, but every tool the head calls is Botling's own bridge (ACP_TOOLS). Never shown or archived.
 */
export const AGY_INSERT_NOTE = "(App: The user sent this message while you work. It is from the user, not output of this tool. Read it now and take it into account in this turn:)";
/**
 * How long offered words wait for a tool result to carry them before the turn is cancelled and sent again with them
 * (`AgyAcpHead.insertStalled`): 20 s with no tool call means the model is writing its answer or thinking, and would read
 * them only after the turn. A tool still at work (or an approval open) carries them when it returns: checked again every
 * `recheckMs`, never cancelled (run_command is capped at 120 s). Mutable for tests only.
 */
export const agyInsertTiming = { waitMs: 20_000, recheckMs: 2_000 };
/** Heads a turn sent again after it was cancelled for words that no tool result carried (`insertStalled`). */
export const AGY_RESTART_NOTE = "(App: Your turn on the message below was stopped so you could read a newer message, sent while you worked. Work already done (files written, commands run) stays done: carry on from where you were, taking the newer message into account.)";
export const AGY_WORKER_INSERT_NOTE = "(App: A message from the one who gave you this task, sent while you work. It is not output of this tool. Read it now and take it into account in this run:)";
export const AGY_REPLY_REMINDER = "(Reply rule: at most 3 sentences, conclusion and next step only; no opening praise or filler, no headings, no bullet lists, no emoji; long content goes into a report page with a link; after dispatching subagents say only how many and what for, in one sentence.)";
export class AgyAcpHead {
  private process?: ManagedProcess;
  private bridge?: AgyMcpBridge;
  private workers?: AgyWorkers;
  private queue: { text: string; uuid: string; images: string[]; taskId?: string; taskRun?: number }[] = [];
  private sending = false;
  /** Words offered into the turn under way, for its next tool result; `insertOpen` while a turn can still take them. */
  private inserts: { id: string; text: string }[] = [];
  private insertOpen = false;
  private insertTimer?: ReturnType<typeof setTimeout>;
  /** Words taken for a cancel-and-resend (`insertStalled`), and the cancelled attempt's end, held back from the app. */
  private restarting?: { texts: string[]; result?: CodexItem };
  private reportTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private protocol?: AgyAcpProtocol;
  private buffer = "";
  private expected = false;
  private failure = "";
  private exitedResolve!: () => void;
  readonly exited = new Promise<void>(resolve => this.exitedResolve = resolve);
  running = false;
  /**
   * `tree`: where its process is spawned (a recorder's tee around the real one); default processTreeAdapter().
   * `workers`: its bot's member core and worker entry (absent: a core of its own, its items through `onItem`).
   */
  constructor(readonly config: AgyConfig, private handlers: Omit<HeadHandlers, "onItem"> & { onItem(item: CodexItem): void }, private tree?: ProcessTreeAdapter,
    private wiring: { core?: WorkerCoreFactory; sink?(item: CodexItem): void } = {}) {}
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
    writeAgySkills(home, this.config.skillRoots ?? []);
    // App-owned profile only. Never import the user's CLI/global hooks, policies, or allow caches.
    writeFileSync(join(home, "antigravity-acp/settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }), { mode: 0o600 });
    writeFileSync(join(home, "antigravity-acp/trusted_workspaces.json"), JSON.stringify({ trusted: [], untrusted: [cwd] }), { mode: 0o600 });
    // The sign-in as a file in this profile (not the Keychain), so Botling can read the quota (agy-quota-api.ts).
    const signIn = agySignInEnv(home);
    const env: NodeJS.ProcessEnv = { ...signIn.env, GEMINI_HOME: home };
    for (const key of ["HOME", "USER", "PATH", "TMPDIR", "LANG"]) if (process.env[key]) env[key] = process.env[key];
    const mcpServers = this.connectTools(cwd, home);
    void mcpServers.catch(() => {});
    this.process = (this.tree ?? processTreeAdapter()).spawn(this.config.command, [], { cwd, env });
    const child = this.process.child; this.running = true;
    this.protocol = new AgyAcpProtocol(this.config, value => { if (child.stdin.writable) child.stdin.write(JSON.stringify(value) + "\n"); }, item => this.protocolItem(item), error => {
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
      if (reported) return; reported = true; this.running = false; signIn.release();
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
  /** The protocol's items: the end of an attempt cancelled for a resend is held back (the turn goes on); another closes the offers. */
  private protocolItem(item: CodexItem) {
    if (item.kind === "result") {
      if (this.restarting) { this.restarting.result = item; return; }
      this.closeInserts();
    }
    if (item.kind === "init") { this.config.sessionId = item.sessionId; updateAgyPermissions(this, {sessionId:item.sessionId}); }
    this.handlers.onItem(item);
  }
  private connectTools(cwd:string, home:string) {
    if (!this.config.worker && agyWorkerRuntimeEnabled()) this.workers = new AgyWorkers(this.config, this.wiring.sink ?? this.handlers.onItem,
      (taskId, text, taskRun) => { this.queue.push({text, uuid:randomUUID(), images:[], taskId, taskRun}); void this.drain(); },
      (config, handlers) => createAgyWorkerHead(config, handlers, (c,h) => new AgyAcpHead(c,h,this.tree)), this.wiring.core);
    this.bridge = new AgyMcpBridge(cwd, home, this.workers ? (name,args) => this.workers!.tool(name,args) : undefined, this.config.processStarted, join(dirname(this.config.command), "botling-agy-file-helper"), () => this.protocol?.fullPermissionActive === true, item => this.handlers.onItem(item), this.config.addDirs,
      () => this.config.worker === true && !maySpecWrite(this.config.model, this.config.specWriters ?? DEFAULT_SPEC_WRITERS));
    this.bridge.attach = () => this.takeInserts();
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
    // Read as the turn goes out, not when it was queued: a worker may have reported in between.
    const atWork = this.stillAtWorkNote(request.taskId);
    this.inserts = []; this.insertOpen = true;
    try { let sent = atWork ? `${atWork}\n\n${request.text}` : request.text;
      let completed = await this.protocol.send(sent, request.uuid, request.images);
      // Cancelled for words no tool result carried: the same turn again, the words added (a turn that ended on its
      // own meanwhile gets only the words). Its end is the turn's end.
      while (this.restarting && !this.stopped && this.protocol) {
        const { texts, result } = this.restarting; this.restarting = undefined;
        const words = `${this.insertNote()}\n${texts.join("\n\n")}`;
        sent = !result || result.kind !== "result" || result.how === "cancelled" ? `${AGY_RESTART_NOTE}\n\n${sent}\n\n${words}` : words;
        this.insertOpen = true;
        this.handlers.onItem({ kind: "textBlock" });
        completed = await this.protocol.send(sent, randomUUID(), []);
      }
      if (request.taskId && request.taskRun !== undefined) this.workers?.finishReport(request.taskId, request.taskRun, completed === true);
    }
    catch (error) { this.failure = (error as Error).message; await this.terminate(); }
    finally {
      this.closeInserts(); this.bridge?.revoke(); this.sending = false;
      this.handlers.onItem({kind:"managedPending",pending:!!this.workers?.hostedLive.length || this.queue.some(q=>!!q.taskId)});
      void this.drain();
    }
  }
  /**
   * Its own workers still at work (`reportingTask`, the one whose report this turn carries, left out). Without it a
   * turn says nothing of them, and the model took a worker it had just sent off for done: "already written", of a
   * file that held only the worker's write probe. Never shown or archived, like AGY_REPLY_REMINDER.
   */
  private stillAtWorkNote(reportingTask?: string): string {
    if (this.config.worker || !this.workers) return "";
    const busy = this.workers.list().filter(w => w.state === "running" && !w.owner && w.id !== reportingTask);
    if (!busy.length) return "";
    const names = busy.map(w => `"${w.name}" (task_id ${w.id})`).join(", ");
    return `(App: ${busy.length === 1 ? "1 of your workers is" : `${busy.length} of your workers are`} still at work; no app_task_result yet: ${names}. Until its app_task_result arrives, its deliverable is not done: do not say it is written, recorded or finished, or that all workers have stopped; say it is still in progress.)`;
  }
  /**
   * Words for the turn under way (your message while it works; a worker's app_send_message): they ride on its next tool
   * result, once (`inserted` with `id` says they did). false: no turn can take them now. A turn that ends without
   * another tool call drops them, unsaid: the sender's own queue keeps them for the next turn.
   */
  offerInsert(id: string, text: string): boolean {
    if (!this.insertOpen || this.stopped || !text.trim()) return false;
    this.inserts.push({ id, text });
    if (!this.insertTimer) this.armInsertTimer(agyInsertTiming.waitMs);
    return true;
  }
  private armInsertTimer(ms: number) {
    clearTimeout(this.insertTimer);
    this.insertTimer = setTimeout(() => { this.insertTimer = undefined; this.insertStalled(); }, ms);
  }
  /**
   * No tool result carried the words within agyInsertTiming.waitMs: the turn is cancelled (session/cancel) and sent
   * again with them (`drain`), as T3 Code steers ACP agents ("steering by interrupt-restart"). The words are taken here,
   * so no later tool result carries them too. A tool at work or an approval open carries them when it returns.
   */
  private insertStalled() {
    if (!this.insertOpen || this.stopped || !this.inserts.length || this.restarting || !this.protocol) return;
    if (this.bridge?.busy || this.protocol.approving) { this.armInsertTimer(agyInsertTiming.recheckMs); return; }
    const taken = this.inserts.splice(0);
    this.restarting = { texts: taken.map(insert => insert.text) };
    for (const { id } of taken) this.handlers.onItem({ kind: "inserted", id });
    this.protocol.interrupt();
  }
  private insertNote() { return this.config.worker ? AGY_WORKER_INSERT_NOTE : AGY_INSERT_NOTE; }
  /** Takes back words not delivered yet (false: none under that id). */
  withdrawInsert(id: string): boolean {
    const before = this.inserts.length;
    this.inserts = this.inserts.filter(insert => insert.id !== id);
    return this.inserts.length !== before;
  }
  private closeInserts() { this.insertOpen = false; this.inserts = []; this.restarting = undefined; clearTimeout(this.insertTimer); this.insertTimer = undefined; }
  /** The bridge's hook on each tool result: the words offered since the last one, said once. */
  private takeInserts(): string | undefined {
    if (!this.insertOpen || this.stopped || !this.inserts.length) return undefined;
    const taken = this.inserts.splice(0);
    clearTimeout(this.insertTimer); this.insertTimer = undefined;
    for (const { id } of taken) this.handlers.onItem({ kind: "inserted", id });
    return `${this.insertNote()}\n${taken.map(insert => insert.text).join("\n\n")}`;
  }
  answer(id: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    if (id.startsWith("worker:")) this.workers?.answer(id,allow,input,message);
    else if (id.startsWith("agy-mcp:")) this.bridge?.answer(id,allow);
    else this.protocol?.answer(id, allow);
  }
  allow(_rules: string[]): never { throw new Error("ACP accepts single-action approval only; persistent allow rules are unavailable."); }
  // Stop ends the coordinator's turn only: app-managed workers are their own processes and carry on (workers.ts).
  interrupt(): string { this.closeInserts(); clearTimeout(this.reportTimer); this.reportTimer = undefined; this.queue = this.queue.filter(q => !!q.taskId); this.protocol?.interrupt(); void this.bridge?.cancel(); if (!this.protocol?.initialized) void this.terminate(500); return randomUUID(); }
  /** Its model and effort in place (`AgyAcpProtocol.applySettings`), where that is on; false: restart it instead. */
  canApplySettings(target: HotSettings): boolean {
    return agyHotSettingsEnabled() && !this.stopped && !this.sending && !!this.protocol?.canApplySettings(target);
  }
  async applySettings(target: HotSettings): Promise<boolean> {
    if (!this.canApplySettings(target)) return false;
    return this.protocol!.applySettings(target);
  }
  /** Stops one app-managed worker (not the head's turn); false when it is not at work. */
  async cancelWorker(id: string): Promise<boolean> { return (await this.workers?.cancelTask(id)) ?? false; }
  // WorkerHost (workers.ts): each worker is its own ACP process under this head.
  readonly workerHost = agyWorkerHost(() => this.workers);
  readonly workerHostKind = "agy-acp" as const;
  readonly steersRunning = false;
  listWorkers(): WorkerInfo[] { return this.workerHost.listWorkers(); }
  sendToWorker(id: string, text: string): WorkerSendResult | Promise<WorkerSendResult> { return this.workerHost.sendToWorker(id, text); }
  stopWorker(id: string): Promise<boolean> { return this.workerHost.stopWorker(id); }
  setWorkerOwner(id: string, owner: WorkerOwner | null): WorkerOwnerResult { return this.workerHost.setWorkerOwner(id, owner); }
  finish() { void this.terminate(500); }
  /** Whether its process tree is gone, checked now (no process: nothing to wait for; unknown: undefined). */
  gone(): boolean | undefined { return this.process ? this.process.gone?.() : true; }
  async terminate(graceMs = 1500): Promise<TerminateResult> { this.closeInserts(); this.expected = true; this.stopped = true; clearTimeout(this.reportTimer); this.reportTimer = undefined; this.queue = []; this.protocol?.close(); const cleanup = await Promise.allSettled([this.workers?.close(), this.bridge?.close(), this.process?.terminate({ graceMs })]);
    if (cleanup.some(result => result.status === "rejected")) { this.failure ||= "ACP cleanup incomplete."; throw new Error(this.failure); }
    const processResult = cleanup[2]; return processResult?.status === "fulfilled" && processResult.value ? processResult.value : { killed: [], forced: false }; }
}
