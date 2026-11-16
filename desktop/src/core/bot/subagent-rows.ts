// BotSubagentRows (M7-S46): subagent rows, open questions, result/file lists, queued notes, and debounced subagent persistence.
import { resultLinks, type ResultView, type SubagentRowView } from "../../contract";
import type { Bot } from "../bot";
import { linkedFiles, type LinkedFile } from "../storage";
import { isOpenQuestion, type ChatRecord } from "../store/records";
import type { BotStore } from "../store/bot-store";
import type { SubagentBook, SubagentRecord } from "../subagents";
import type { BotContext } from "./context";
import type { BotOptions } from "./types";

export class BotSubagentRows {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: shared context (`ctx`) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get subagents(): SubagentBook { return this.ctx.subagents; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private log(line: string) { this.ctx.log(line); }

  // ---- Bridge: names on `Bot` (`host`) ----
  private get records(): ChatRecord[] { return this.host.records; }
  private get readOnly(): boolean { return this.host.readOnly; }
  private get shuttingDown(): boolean { return this.host.shuttingDown; }

  // ---- Moved from `Bot` ----
  private subagentSaveTimer: NodeJS.Timeout | null = null;
  private subagentsDirty = false;
  private subagentSaveRetryMs = 1_000;
  readonly dirtySubagents = new Set<string>();
  private allSubagentsDirty = false;

  /** Its subagents' rows (and its partner's, with the head that sent each). */
  subagentRows(): SubagentRowView[] {
    const agents = this.options.agents;
    // 1.x shows the owning head's navigation avatar even for a single-head bot. Ones another bot owns now are listed there instead.
    const rows = this.members.flatMap(bot => {
      const out = agents?.movedOut(bot.engine);
      return bot.subagents.rows(bot.engine).filter((row) => !out?.has(row.id)).map((row) => ({ row, bot }));
    });
    const remote = this.options.remoteWorkers?.() ?? null;
    const remoteStatus = (id: string) => { try { return remote?.status?.(id) ?? null; } catch { return null; } };
    const own: SubagentRowView[] = rows.slice(-100).map(({ row, bot }) => {
      const info = agents?.rowInfo?.(bot.engine, row.id);
      const machine = row.head === "claude" ? remoteStatus(row.id) : null;
      return {
        ...row,
        waitingForNetwork: bot.outage?.subagents.includes(row.id) ?? false,
        ...(machine ? { machine: { name: machine.machine.slice(0, 64), connected: machine.conn === "up" } } : {}),
        ...(info?.agentId ? { agentId: info.agentId } : {}),
        ...(info?.movable ? { movable: info.movable } : {}),
      };
    });
    // Agents it owns that run on another bot, then its sub bots (hidden bots of their own under it: rows that open as a chat with an input box).
    return [...own, ...(agents?.movedInRows() ?? []), ...(this.options.subBotRows?.() ?? [])].slice(-100);
  }

  /** The rows changed: the windows hear of it once (`force`: always). */
  rowsChanged(force = false) {
    const primary = this.options.primary ?? this.host;
    const text = JSON.stringify(primary.subagentRowBook.subagentRows());
    if (!force && text === primary.recordsBook.lastRows) return;
    primary.recordsBook.lastRows = text;
    primary.updated();
  }

  /** Its workers' rows may show something new (a remote worker's connection): told only if they changed. */
  workerRowsChanged() { if (!this.options.primary) this.rowsChanged(); }

  /** Every question in its chat still waiting for you. */
  openQuestions(): { id: string; text: string; sourceID?: string }[] {
    // Copies of other bots' questions (<open-question>) are theirs, not this chat's.
    return this.owner.records.filter((candidate) => isOpenQuestion(candidate) && !candidate.permissionTool && !candidate.sourceMessageID)
      .map((record) => ({ id: record.id, text: record.text, ...(typeof record.sourceID === "string" ? { sourceID: record.sourceID } : {}) }));
  }

  /** The links handed over in this chat, newest first (`Bot.results`). */
  results(): ResultView[] {
    return resultLinks(this.records);
  }

  /** The local files its replies handed over, newest first (its Storage lists them; core/storage.ts). */
  linkedFiles(): LinkedFile[] {
    return linkedFiles(this.records);
  }

  /** Told with its next message when it is awake (`Bot.queueNote`; a later note replaces an earlier one). An asleep bot reads it all at its wake. */
  queueNote(note: string) {
    const bot = this.options.primary ?? this.host;
    if (!bot.head?.running) return;
    bot.delivery.queueNote(note);
  }

  /** A subagent's row changed outside `saveSubagents` (a nested Agent result): the next rows push includes it. */
  markDirty(id: string) { this.dirtySubagents.add(id); }

  saveSubagents(progress = false, changed?: SubagentRecord) {
    if (this.readOnly) return;
    this.subagentsDirty = true;
    if (changed) {
      this.dirtySubagents.add(changed.id);
      if (changed.parentID) this.dirtySubagents.add(changed.parentID);
    } else this.allSubagentsDirty = true;
    // Only running text/token/runtime progress may lag disk by 500 ms. Starts, tool events,
    // execution identity, terminal states and explicit user changes are appended before returning.
    if (progress && !this.shuttingDown) this.scheduleSubagentSave(500);
    else this.flushSubagents();
  }

  scheduleSubagentSave(delay: number) {
    if (this.subagentSaveTimer || this.shuttingDown) return;
    this.subagentSaveTimer = setTimeout(() => {
      this.subagentSaveTimer = null;
      try { this.flushSubagents(true); }
      catch (error) { this.log(`subagents save failed; retry pending: ${String(error)}`); }
    }, delay);
    this.subagentSaveTimer.unref?.();
  }

  /** A failed write stays dirty. Critical callers see the error; background retries are bounded. */
  flushSubagents(progress = false) {
    if (this.subagentSaveTimer) { clearTimeout(this.subagentSaveTimer); this.subagentSaveTimer = null; }
    if (this.readOnly || !this.subagentsDirty) return;
    try {
      const changed = this.allSubagentsDirty ? undefined : this.dirtySubagents;
      this.store.commitSubagents(this.subagents.list, changed);
      this.dirtySubagents.clear();
      this.allSubagentsDirty = false;
      this.subagentsDirty = false;
      this.subagentSaveRetryMs = 1_000;
    } catch (error) {
      this.subagentsDirty = true;
      this.scheduleSubagentSave(this.subagentSaveRetryMs);
      this.subagentSaveRetryMs = Math.min(this.subagentSaveRetryMs * 2, 30_000);
      throw error;
    }
  }
}
