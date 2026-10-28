// Antigravity's event protocol is NOT Claude's stream-json protocol.
// Contract: https://antigravity.google/docs/cli/headless/ (checked 2026-10-28).
import { randomUUID } from "node:crypto";
import { type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import type { HeadHandlers } from "./head";
import type { StreamItem } from "./stream";

export const AGY_EXECUTION_BLOCKED = "Antigravity execution is blocked: the CLI has no verified pre-task policy barrier. No process or task was started. Choose another engine until a safe transport is available.";
export const AGY_LIMITATIONS = AGY_EXECUTION_BLOCKED;
export interface AgyConfig {
  command: string;
  /** App-owned ACP profile; never the global CLI configuration. */
  acpHome?: string;
  transport?: "acp";
  worker?: boolean;
  processStarted?: (pid: number) => void;
  canStartReport?: () => boolean;
  prefixArgs?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  sessionId: string;
  resume: boolean;
  model?: string | null;
  effort?: string | null;
  systemPrompt?: string;
}
export function agyArguments(config: AgyConfig): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"];
  if (config.resume) args.push("--conversation", config.sessionId);
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", config.effort);
  // Never import Claude's allow rules, bypass settings, plugins or permission flags.
  return args;
}
const object = (v: any): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const text = (v: any): string => typeof v === "string" ? v : "";
const display = (v: any): string => typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);

export class AgyStream {
  private state: "awaiting-init" | "ready" | "failed" = "awaiting-init";
  private tools = new Set<string>();
  private endedTools = new Set<string>();
  private textStep: string | null = null;
  private session = "";
  private toolNames = new Map<string, string>();
  private usageSteps = new Set<string>();
  private usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  parse(line: string): StreamItem[] {
    if (this.state === "failed") throw new Error("Antigravity protocol is failed.");
    let event: Record<string, any>;
    try { event = object(JSON.parse(line)); }
    catch (error) { this.state = "failed"; throw error; }
    if (event.event === "init") {
      const previous = this.state;
      this.state = "failed";
      if (previous !== "awaiting-init") throw new Error("Duplicate Antigravity init.");
      if (!["strict", "request-review"].includes(event.init?.permission_mode)) throw new Error("Antigravity requires strict or request-review permissions.");
      this.session = text(event.conversation_id);
      if (!this.session) throw new Error("Antigravity did not provide a conversation ID.");
      // Observing init is NOT authorization to submit a task; runtime remains blocked.
      this.state = "ready";
      return [{ kind: "init", sessionId: this.session }];
    }
    if (this.state !== "ready") { this.state = "failed"; throw new Error("Antigravity event received before validated init."); }
    const conversation = event.conversation_id ?? event.step_update?.conversation_id ?? event.result?.conversation_id;
    if (conversation && conversation !== this.session) { this.state = "failed"; throw new Error("Antigravity conversation changed unexpectedly."); }
    if (event.event === "result") {
      const r = object(event.result);
      this.textStep = null;
      this.tools.clear(); this.endedTools.clear(); this.usageSteps.clear();
      const usage: StreamItem = { kind: "usage", totalCost: 0, tokens: this.usage };
      this.usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
      if (denied.length) {
        const names = denied.map((item: any) => text(item.display_name) || text(item.action) || "tool").join(", ");
        const refused = new Set(denied.map((item: any) => text(item.display_name).replace(/_/g, "").toLowerCase()));
        const tools: StreamItem[] = [...this.toolNames].filter(([, name]) => refused.has(name.replace(/_/g, "").toLowerCase())).map(([id]) => ({kind: "toolResult", id, output: "Refused by Antigravity permissions; headless mode cannot receive approval.", failed: true, parent: null, launch: null}));
        this.toolNames.clear();
        return [usage, ...tools, { kind: "result", ok: false, text: text(r.response), error: `Antigravity refused ${names}: this action requires approval that headless mode cannot receive. No permission was granted by Botling.`, subtype: "PERMISSION_DENIED" }];
      }
      this.toolNames.clear();
      return [usage, { kind: "result", ok: r.status === "SUCCESS", text: text(r.response), error: text(r.error) || (r.status === "SUCCESS" ? "" : `Antigravity ended with ${text(r.status) || "unknown status"}.`), subtype: text(r.status) }];
    }
    if (event.event !== "step_update") return [];
    const s = object(event.step_update);
    const id = `agy:${text(s.conversation_id) || this.session}:${s.step_index}`;
    const items: StreamItem[] = [];
    if (s.state === "DONE" && s.usage && !this.usageSteps.has(id)) {
      this.usageSteps.add(id);
      const count = (key: string) => typeof s.usage[key] === "number" && Number.isFinite(s.usage[key]) ? Math.max(0, s.usage[key]) : 0;
      this.usage.input += count("input_tokens"); this.usage.output += count("output_tokens"); this.usage.cacheRead += count("cache_read_tokens");
    }
    if (s.step_type === "agent_response" && typeof s.text_delta === "string") {
      if (this.textStep !== id) { items.push({ kind: "textBlock" }); this.textStep = id; }
      items.push({ kind: "delta", text: s.text_delta });
    }
    if (s.step_type === "tool") {
      const info = object(s.tool_info);
      const name = text(info.name) || text(s.tool_name) || "Antigravity tool";
      const input = object(info.parameters);
      if (!this.tools.has(id)) {
        this.tools.add(id); this.toolNames.set(id, name);
        items.push({ kind: "toolUse", id, tool: name, title: name, detail: display(input).slice(0, 4000), input, parent: null });
      }
      if (s.state === "DONE" && !this.endedTools.has(id)) {
        this.endedTools.add(id);
        const error = object(info.error);
        items.push({ kind: "toolResult", id, output: text(error.message) || display(info.output), failed: !!info.error, parent: null, launch: null });
      }
    }
    return items;
  }
}

/** Deliberately non-executable until a supported, verified policy boundary exists.
 * No environment flag, fake executable or init event can bypass this boundary.
 */
export class AgyHead {
  readonly exited = Promise.resolve();
  readonly running = false;
  constructor(readonly config: AgyConfig, _handlers: HeadHandlers, _adapter?: ProcessTreeAdapter) {}
  get pid() { return -1; }
  start(): never { throw new Error(AGY_EXECUTION_BLOCKED); }
  send(_prompt: string, _uuid: string, images: string[] = []): never {
    if (images.length) throw new Error("Antigravity stream input supports text only. Remove image attachments or choose another engine.");
    throw new Error(AGY_EXECUTION_BLOCKED);
  }
  answer(_id: string, _allow: boolean, _input: Record<string, unknown>, _message?: string): never {
    throw new Error("Antigravity headless mode cannot receive approval responses; no permission was granted.");
  }
  allow(_rules: string[]): never { throw new Error("Antigravity permission rules cannot be changed from Botling."); }
  interrupt(): string { return randomUUID(); }
  finish() {}
  async terminate(_graceMs = 1500): Promise<TerminateResult> { return { killed: [], forced: false }; }
}
