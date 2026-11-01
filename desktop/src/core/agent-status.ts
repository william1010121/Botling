// The status snapshot of an agent owned by a bot that does not host it (A1.4): <owner folder>/.bot/agents/<agentId>/status.md,
// the new owner's "progress file". Written by the app only while owner ≠ host: at once on a state change, otherwise at
// most once every 10 s.
import { join } from "node:path";
import { writeFileAtomic } from "./durable/atomic";
import type { StepRecord } from "./store/records";
import type { AgentRecord } from "./agent-registry";
import { engineName } from "./sub-bots";

export const STATUS_THROTTLE_MS = 10_000;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export function agentStatusFile(ownerFolder: string, agentId: string): string {
  return join(ownerFolder, ".bot", "agents", agentId, "status.md");
}

/** The snapshot's text: title, engine, host, state, the last 20 steps (as `fallbackHandoff` lists them) and the last report. */
export function agentStatusText(rec: AgentRecord, steps: readonly StepRecord[], hostName: string, at = Date.now()): string {
  const shown = steps.filter((step) => step.kind === "tool" || step.kind === "text" || step.kind === "subagent").slice(-20).map((step) => {
    const line = step.kind === "text" ? `said: ${clip((step.detail ?? step.title).replace(/\s+/g, " "), 200)}` : `${step.tool ?? step.kind}: ${clip((step.title || step.detail || "").replace(/\s+/g, " "), 160)}${step.failed ? " (failed)" : ""}`;
    return `- ${line}`;
  });
  return [
    `# ${rec.summary.description || "Agent"}`,
    "",
    `Status: ${rec.state}`,
    `Engine: ${engineName(rec.engine)}`,
    `Runs on: ${hostName} (${rec.host.folder})`,
    `Agent: ${rec.id} (native id ${rec.nativeId})`,
    `Written by the app: ${new Date(at).toISOString()}`,
    "",
    "## What it was asked",
    rec.summary.prompt || "(unknown)",
    "",
    "## Its latest steps",
    shown.length ? shown.join("\n") : "(No steps were recorded.)",
    rec.summary.lastReport ? `\n## Its last report\n${clip(rec.summary.lastReport, 4_000)}` : "",
    "",
  ].join("\n");
}

/** Throttled writer: one per agent, keyed by agent id. */
export class AgentStatusWriter {
  private last = new Map<string, { at: number; state: string }>();
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, { file: string; rec: AgentRecord; steps: () => readonly StepRecord[]; hostName: string }>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Writes now when the state changed (or `force`), else at most once every 10 s (a later call in the window is written at its end). Returns the path. */
  write(ownerFolder: string, rec: AgentRecord, steps: () => readonly StepRecord[], hostName: string, force = false): string {
    const file = agentStatusFile(ownerFolder, rec.id);
    const now = this.clock();
    const last = this.last.get(rec.id);
    const due = force || !last || last.state !== rec.state || now - last.at >= STATUS_THROTTLE_MS;
    if (due) {
      const timer = this.timers.get(rec.id);
      if (timer) { clearTimeout(timer); this.timers.delete(rec.id); }
      this.pending.delete(rec.id);
      writeAgentStatus(file, rec, steps(), hostName, now);
      this.last.set(rec.id, { at: now, state: rec.state });
    } else {
      // The latest call in the window is what gets written at its end.
      this.pending.set(rec.id, { file, rec: structuredClone(rec), steps, hostName });
      if (!this.timers.has(rec.id)) {
        const timer = setTimeout(() => {
          this.timers.delete(rec.id);
          const latest = this.pending.get(rec.id);
          this.pending.delete(rec.id);
          if (!latest) return;
          try { writeAgentStatus(latest.file, latest.rec, latest.steps(), latest.hostName, this.clock()); this.last.set(rec.id, { at: this.clock(), state: latest.rec.state }); } catch { /* the next change writes it */ }
        }, STATUS_THROTTLE_MS - (now - last!.at));
        timer.unref?.();
        this.timers.set(rec.id, timer);
      }
    }
    return file;
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}

export function writeAgentStatus(file: string, rec: AgentRecord, steps: readonly StepRecord[], hostName: string, at = Date.now()): void {
  writeFileAtomic(file, agentStatusText(rec, steps, hostName, at));
}
