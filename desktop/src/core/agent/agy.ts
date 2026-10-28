// Antigravity's event protocol is NOT Claude's stream-json protocol.
// Contract: https://antigravity.google/docs/cli/headless/ (checked 2026-10-28).
import { randomUUID } from "node:crypto";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { childEnvironment } from "./runner";
import { resolveExecutable } from "../process/executable";
import type { HeadHandlers } from "./head";
import type { StreamItem } from "./stream";

export const AGY_LIMITATIONS = "Antigravity uses its existing CLI permissions. Actions needing approval are refused in headless mode; Botling cannot grant them. Shared-engine chats, managed workers, plugin injection and image input are unavailable.";
export interface AgyConfig {
  command: string;
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
  private tools = new Set<string>();
  private endedTools = new Set<string>();
  private textStep: string | null = null;
  private session = "";
  private toolNames = new Map<string, string>();
  private usageSteps = new Set<string>();
  private usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  parse(line: string): StreamItem[] {
    const event = object(JSON.parse(line));
    if (event.event === "init") {
      this.session = text(event.conversation_id);
      // Never present an always-proceed session as review-protected.
      if (event.init?.permission_mode !== "request-review") throw new Error("Antigravity requires request-review permissions. Botling will not run an always-proceed session.");
      if (!this.session) throw new Error("Antigravity did not provide a conversation ID.");
      return [{ kind: "init", sessionId: this.session }];
    }
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

/** One persistent, serial stream. Cancellation ends the process group; the next head resumes by ID. */
export class AgyHead {
  private process: ManagedProcess | null = null;
  private buffer = "";
  private stderr = "";
  private stream = new AgyStream();
  private closed = false;
  private expected = false;
  private printed = false;
  private active = false;
  private first = true;
  private exitResolve!: () => void;
  readonly exited = new Promise<void>(resolve => { this.exitResolve = resolve; });
  running = false;
  constructor(readonly config: AgyConfig, private handlers: HeadHandlers, private adapter: ProcessTreeAdapter = processTreeAdapter()) {}
  get pid() { return this.process?.pid ?? -1; }
  start() {
    const env = childEnvironment(this.config.env);
    this.process = this.adapter.spawn(resolveExecutable(this.config.command, env), [...(this.config.prefixArgs ?? []), ...agyArguments(this.config)], { cwd: this.config.cwd, env });
    this.running = true;
    const child = this.process.child;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      this.printed = true; this.buffer += chunk;
      if (this.buffer.length > 4_000_000) { this.fail("Antigravity output exceeded the event size limit."); return; }
      let at: number;
      while (!this.closed && (at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
        if (line) this.line(line);
      }
    });
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null, error = "") => {
      if (reported) return; reported = true;
      if (!this.closed && this.buffer.trim()) this.line(this.buffer.trim());
      this.buffer = ""; this.running = false; this.closed = true; this.exitResolve();
      this.handlers.onExit({ code, signal, stderr: `${this.stderr}\n${error}`.trim(), expected: this.expected, silent: !this.printed });
    };
    child.once("error", error => report(null, null, `Cannot start Antigravity (${this.config.command}): ${error.message}`));
    child.once("close", (code, signal) => report(code, signal));
  }
  private line(line: string) {
    try {
      for (const item of this.stream.parse(line)) {
        if (item.kind === "result") this.active = false;
        this.handlers.onItem(item);
      }
    } catch (error) { this.fail(`Antigravity protocol error: ${(error as Error).message}`); }
  }
  private fail(error: string) {
    this.stderr = error; this.closed = true;
    if (this.active) { this.active = false; this.handlers.onItem({ kind: "result", ok: false, text: "", error, subtype: "ERROR" }); }
    void this.process?.terminate({ graceMs: 500 });
  }
  send(prompt: string, _uuid: string, images: string[] = []) {
    if (images.length) throw new Error("Antigravity stream input supports text only. Remove image attachments or choose another engine.");
    if (!this.running || this.closed || !this.process) throw new Error("Antigravity session is closed.");
    if (this.active) throw new Error("Antigravity accepts one turn at a time.");
    this.active = true;
    const content = this.first && this.config.systemPrompt ? `${this.config.systemPrompt}\n\n${AGY_LIMITATIONS}\n\nUser message:\n${prompt}` : prompt;
    this.first = false;
    this.process.child.stdin.write(JSON.stringify({ event: "user", message: { content } }) + "\n");
  }
  answer(_id: string, _allow: boolean, _input: Record<string, unknown>, _message?: string) {
    throw new Error("Antigravity headless mode cannot receive approval responses; no permission was granted.");
  }
  allow(_rules: string[]) { throw new Error("Antigravity permission rules cannot be changed from Botling."); }
  interrupt(): string { const id = randomUUID(); void this.terminate(); return id; }
  finish() { this.expected = true; this.process?.child.stdin.end(); }
  async terminate(graceMs = 1500): Promise<TerminateResult> {
    this.expected = true; this.closed = true;
    return this.process?.terminate({ graceMs }) ?? { killed: [], forced: false };
  }
}
