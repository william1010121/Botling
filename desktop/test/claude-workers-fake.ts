// A fake ClaudeHead for Claude's app-managed workers (claude-workers.ts): records what each worker process was started
// with and sent, and lets a test say its stream items, results and exits.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkers, type ClaudeWorkerHead } from "../src/core/agent/claude-workers";
import type { HeadConfig, HeadHandlers } from "../src/core/agent/head";

export interface FakeHead extends ClaudeWorkerHead { config: HeadConfig; handlers: HeadHandlers; sent: { text: string; uuid: string }[]; answers: unknown[]; finished: boolean; terminated: boolean; running: boolean; exit(code?: number | null, expected?: boolean): void }

export function claudeHarness(dir = mkdtempSync(join(tmpdir(), "botling-claude-workers-")), options: { settleMs?: number; keepAliveMs?: number; base?: HeadConfig | null; maxRunning?: number } = {}) {
  const items: any[] = [], reports: { id: string; text: string; run: number }[] = [], heads: FakeHead[] = [];
  let accept = true;
  const cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  const base: HeadConfig = { command: "claude", cwd: "/elsewhere", sessionId: "coordinator", resume: true, allowedTools: ["Read", "Bash"], disallowedTools: ["WebSearch"], model: "opus", effort: "high", autoMode: true };
  const workers = new ClaudeWorkers({
    file: join(dir, "claude-workers.json"), ownerSessionId: () => "coordinator", base: () => options.base === undefined ? base : options.base, cwd: () => cwd,
    subagentModel: () => "sonnet", settleMs: options.settleMs ?? 5, ...(options.maxRunning ? { maxRunning: () => options.maxRunning! } : {}), keepAliveMs: options.keepAliveMs ?? 60_000, home: join(dir, "home"),
  }, (item) => items.push(item), (id, text, run) => { if (!accept) return false; reports.push({ id, text, run }); return true; }, (config, handlers) => {
    const head: FakeHead = {
      config, handlers, sent: [], answers: [], finished: false, terminated: false, running: false, pid: -1,
      start() { this.running = true; },
      send(text, uuid) { this.sent.push({ text, uuid }); },
      answer(...args) { this.answers.push(args); },
      finish() { this.finished = true; this.exit(0, true); },
      async terminate() { this.terminated = true; this.exit(null, true); return { killed: [], forced: false }; },
      exit(code = 1, expected = false) { if (!this.running) return; this.running = false; handlers.onExit({ code, signal: null, stderr: expected ? "" : "boom", expected, silent: false }); },
    };
    heads.push(head);
    return head;
  });
  const say = (head: FakeHead, item: any) => head.handlers.onItem(item);
  const result = (head: FakeHead, text: string, ok = true) => say(head, { kind: "result", ok, text, error: ok ? "" : text, subtype: ok ? "success" : "error" });
  return { dir, cwd, workers, items, reports, heads, say, result, refuseReports: () => { accept = false; }, acceptReports: () => { accept = true; } };
}

