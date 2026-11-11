// A Claude worker's process on another machine, as the Claude worker adapter sees it (ClaudeWorkerHead): its items,
// its exit, its app tools, the same as a local ClaudeHead's. Underneath, a RemoteSession keeps the connection: a lost
// one is hidden here (the run waits, then goes on with --resume), tool request cards always come to the user, and when
// a turn ends the worker's branch is pulled back before the result reaches the adapter.
import type { TerminateResult } from "../core/process/tree";
import type { HeadConfig, HeadHandlers } from "../core/agent/head";
import type { StreamItem } from "../core/agent/stream";
import type { ClaudeWorkerHead } from "../core/agent/claude-workers";
import type { RemoteExit } from "./protocol";
import type { RemoteSession, SessionLink } from "./session";
import type { RemoteGit } from "./git-sync";

export interface RemoteHeadOptions {
  config: HeadConfig;
  handlers: HeadHandlers;
  /** Makes the session for this head (its events come back here). */
  session(events: RemoteHeadEvents): RemoteSession;
  git?: RemoteGit;
  log?(line: string): void;
}
export interface RemoteHeadEvents {
  item(item: StreamItem): void;
  exit(exit: RemoteExit): void;
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export class RemoteClaudeHead implements ClaudeWorkerHead {
  readonly pid = -1;
  running = false;
  private session: RemoteSession;
  private begun = false;
  private ended = false;
  private exitWaiters: (() => void)[] = [];
  /** Items wait their turn (a result waits for the branch to come back; what follows waits for it). */
  private queue: Promise<void> = Promise.resolve();

  constructor(private options: RemoteHeadOptions) {
    this.session = options.session({
      item: (item) => this.enqueue(() => this.item(item)),
      exit: (exit) => this.enqueue(() => this.exit(exit)),
      tool: (name, args) => this.options.handlers.onAppTool ? this.options.handlers.onAppTool(name, args) : Promise.reject(new Error(`Unknown app tool ${name}.`)),
    });
  }

  private enqueue(step: () => void | Promise<void>) {
    this.queue = this.queue.then(step).catch((error) => this.options.log?.(`remote head: ${(error as Error).message}`));
  }

  start() { this.running = true; }

  send(text: string, uuid: string) {
    if (!this.running) return;
    if (!this.begun) {
      this.begun = true;
      this.session.begin({ config: this.options.config, words: text, uuid });
      return;
    }
    this.session.send(text, uuid);
  }

  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    this.session.answer(requestId, allow, input, message);
  }

  finish() { this.session.finish(); }

  async terminate(graceMs = 1_500): Promise<TerminateResult> {
    if (!this.ended) {
      this.session.cancel();
      // Away from the machine the cancel is taken at once; connected, the agent stops claude and says so.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(graceMs, 10_000));
        timer.unref?.();
        this.exitWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return { killed: [], forced: false, alive: false };
  }

  /** Nothing of it runs on this machine. */
  gone() { return true; }

  private async item(item: StreamItem) {
    if (this.ended) return;
    if (item.kind === "result" && this.options.git && this.session.link) {
      const note = await this.pull(this.session.link, item.ok ? "Worker's uncommitted changes" : "Worker's uncommitted changes (run ended with an error)");
      if (note) item = { ...item, text: item.text ? `${item.text}\n\n(App: ${note})` : `(App: ${note})` };
    }
    this.options.handlers.onItem(item);
  }

  private async pull(link: SessionLink, message: string): Promise<string> {
    try { return (await this.options.git!.pull(link, message)).note; } catch (error) {
      const text = `Could not bring the worker's branch back from the machine: ${(error as Error).message}. Its work stays on the machine; it is tried again when its next run ends.`;
      this.options.log?.(text);
      return text;
    }
  }

  private exit(exit: RemoteExit) {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    for (const w of this.exitWaiters.splice(0)) w();
    this.options.handlers.onExit({ code: exit.code, signal: exit.signal as NodeJS.Signals | null, stderr: exit.stderr, expected: exit.expected, silent: exit.silent } as Parameters<HeadHandlers["onExit"]>[0]);
    // A cancel taken while away still has to be swept up on the machine: the session goes on until it has.
    this.session.retire();
  }
}
