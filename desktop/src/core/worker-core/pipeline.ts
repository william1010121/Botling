// One run of one worker, digested once (shared-core spec 2.6): text blocks become steps, tool calls get the
// worker-scoped ids, usage/speed/measurements go through RunAccounting, and the events the core keeps state for
// (session, process, approvals, the end) are handed to it. The bot's items are the shared vocabulary of workers.ts.
import type { CodexItem } from "../agent/codex";
import type { Engine } from "../heads";
import { RunAccounting } from "./accounting";
import type { RunFacts } from "./classify";
import type { RunEnd, WorkerEvent } from "./events";
import { TextBlocks } from "./text";

/** The events the pipeline hands to the core instead of turning them into items. */
export type ControlEvent = Extract<WorkerEvent, { type: "session" | "process" | "permission" | "permissionCancelled" }>;

export interface PipelineIds {
  workerId: string;
  run: number;
  /** Its segment of the run (a run resumed after a restart: 1, 2, …). */
  segment?: number;
  engine: Engine;
  conversationId(): string | null;
  /** The coordinator's thread, for measurements that name none. */
  parentThreadId(): string | null;
}

export interface PipelineHooks {
  /** session / process / permission / permissionCancelled: the core's (ledger, approvals table). */
  control(event: ControlEvent): void;
  /** The engine's end arrived (once); the text is flushed already. */
  ended(end: RunEnd): void;
}

export class RunPipeline {
  private text = new TextBlocks();
  private accounting: RunAccounting;
  private ending: RunEnd | null = null;
  private failed = 0;

  constructor(private ids: PipelineIds, private out: (item: CodexItem) => void, private hooks: PipelineHooks = { control: () => undefined, ended: () => undefined }) {
    this.accounting = new RunAccounting(ids);
  }

  /** The worker-scoped id of one of its tool calls. */
  private scoped(id: string) { return `${this.ids.workerId}:${this.ids.run}:${id}`; }

  private blocks(event: WorkerEvent) {
    for (const block of this.text.add(event)) this.out({ kind: "subagentText", parent: this.ids.workerId, text: block.text });
  }

  /** Feeds one adapter event. Nothing after the run's `end` is taken. */
  feed(event: WorkerEvent): void {
    if (this.ending) return;
    switch (event.type) {
      case "textDelta": case "textWhole": case "textBreak":
        this.blocks(event);
        return;
      case "toolUse":
        this.blocks(event);
        this.out({ kind: "toolUse", id: this.scoped(event.id), tool: event.tool, title: event.title, detail: event.detail, parent: this.ids.workerId, input: event.input });
        return;
      case "toolResult":
        this.blocks(event);
        if (event.failed) this.failed += 1;
        this.out({ kind: "toolResult", id: this.scoped(event.id), output: event.output, failed: event.failed, parent: this.ids.workerId, launch: null });
        return;
      case "usage": for (const item of this.accounting.usage(event)) this.out(item); return;
      case "request": this.out(this.accounting.request(event)); return;
      case "measurement": this.out(this.accounting.measurement(event)); return;
      case "permissionDenied":
        this.out({ kind: "permissionDenied", toolUseId: this.scoped(event.toolUseId), tool: event.tool, reason: event.reason, confirmed: event.confirmed });
        return;
      case "connectionLost": this.out({ kind: "connectionLost", parent: this.ids.workerId }); return;
      case "rateLimits": this.out({ kind: "rateLimits", engine: event.engine, limits: event.limits }); return;
      case "session": case "process": case "permission": case "permissionCancelled":
        this.hooks.control(event);
        return;
      case "end":
        this.blocks(event);
        this.ending = event.end;
        this.hooks.ended(event.end);
        return;
    }
  }

  /** Closes the open text block without an end (the run was stopped or interrupted). */
  flush(): void {
    for (const block of this.text.flush()) this.out({ kind: "subagentText", parent: this.ids.workerId, text: block.text });
  }

  /** The facts so far, for classifyRun (stop / quit read these too). */
  facts(extra: Pick<RunFacts, "stoppedByApp" | "interruptedBy" | "requireReply">): RunFacts {
    const final = this.ending?.finalText;
    return { ...extra, end: this.ending, reply: final && final.trim() ? final : this.text.last, failedTools: this.failed, engine: this.ids.engine };
  }

  get ended(): boolean { return this.ending !== null; }
  get outputTokens(): number { return this.accounting.outputTokens; }
}
