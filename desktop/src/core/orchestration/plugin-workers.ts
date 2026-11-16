// M7-O03a: the worker primitives a plugin may use (`workers.start`, `workers.send`, `workers.cancel`, the event
// `workerReport`), behind the named permission `orchestrate` and a quota. One class holds every check, so that each
// one runs before a worker is started (the plan of M7-O01, (c) and (d), with its review's F3 and F4):
//   1. the plugin declares `orchestrate`, `exec`, `files` and `bots` in package.json AND the user granted it
//      (`OrchestrationWorld.granted`; nobody has it unless the world says so: fail closed);
//   2. the quota (workers at once, workers in the last 24 hours) has room, and the room is taken (a reservation,
//      synchronously) before the first await, so N+5 requests at once start exactly N;
//   3. a plugin the bot wrote (not shipped, not installed from the catalog; unknown counts as written) gets an approval
//      card for every worker; its answer is checked again once it comes (the plugin may have changed, the grant gone);
//   4. the worker has no more rights than the plugin: no `machine`, `role`, `isolated_git`, `subagent_type` (the params
//      are strict), a model that would open spec/ is refused, and the worker itself starts without spec/ and without the
//      bot's skip-the-cards modes (ClaudeWorkers.startFor).
// The owner of every worker is the bot it runs for; this book only remembers which plugin started it (quota, who may
// send or cancel it, who hears its report). A cancel or a send for a worker the plugin did not start gets the same
// answer as for one that does not exist.
import { maySpecWrite, DEFAULT_SPEC_WRITERS } from "../spec-guard";
import type { AppAnswer, AppQuestion } from "../plugins/types";

/** What a plugin must declare in package.json for `workers.start` (the user's grant is asked on top of these). */
export const ORCHESTRATE_NEEDS = ["orchestrate", "exec", "files", "bots"] as const;
export const DEFAULT_QUOTA = { atOnce: 4, perDay: 40 } as const;
export const QUOTA_MAX = { atOnce: 16, perDay: 200 } as const;
const DAY = 86_400_000, KEEP = 7 * DAY, MAX_ENTRIES = 1_000, CARD_WAIT_MS = 600_000;

/** One bot's Claude-process worker host, as the world lends it (null/string from `workers`: why there is none). */
export interface WorkerPort {
  /** The bot's id as plugins name it. */
  id: string;
  start(args: Record<string, unknown>): Promise<{ task_id: string; run: number }>;
  send(taskId: string, text: string): Promise<{ ok: true; how: string; run: number } | { ok: false; reason: string }>;
  stop(taskId: string): Promise<boolean>;
}

export interface OrchestrationWorld {
  /** Whether the user granted this plugin `orchestrate` (its own sheet, like a tier raise); absent in the world: nobody. */
  granted(plugin: string): boolean;
  workers(bot: string): WorkerPort | string;
  /** Settings: workers at once and workers a day (clamped to QUOTA_MAX). */
  quota?(): { atOnce?: number; perDay?: number };
  /** settings.json `specWriters`. */
  specWriters?(): readonly string[];
}

/** What the core knows of a plugin now (null: not loaded or off). `identity` changes when its manifest does. */
export interface PluginFacts { name: string; identity: string; permissions: readonly string[]; botWritten: boolean }

export interface StartParams { bot: string; instructions: string; name?: string; group?: string; engine?: "claude"; model?: string; effort?: string }

interface Entry { plugin: string; bot: string; task: string | null; at: number; open: boolean; reported: number; stopped: boolean }

export interface PluginWorkersDeps {
  world: OrchestrationWorld;
  facts(plugin: string): PluginFacts | null;
  ask(question: AppQuestion): Promise<AppAnswer | null>;
  /** `workerReport` to the plugin that started the worker (only to it). */
  tell(plugin: string, event: "workerReport", data: Record<string, unknown>): void;
  /** The book on disk (absent: kept in memory only). */
  file?: { read(): string | null; write(text: string): void };
  now?(): number;
  cardWaitMs?: number;
}

/** One clean line: control characters and line breaks become spaces, cut to `max`. */
const oneLine = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max);

export class PluginWorkers {
  private entries: Entry[] = [];
  private unreadable = false;

  constructor(private readonly deps: PluginWorkersDeps) {
    let text: string | null = null;
    try { text = deps.file?.read() ?? null; } catch { this.unreadable = true; }
    if (text === null) return;
    try {
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error("not a list");
      for (const row of rows as Record<string, unknown>[]) {
        if (typeof row.plugin === "string" && typeof row.bot === "string" && (typeof row.task === "string" || row.task === null) && typeof row.at === "number") {
          // A reservation that never got its task id: kept as used until it is a day old (more, never less).
          this.entries.push({ plugin: row.plugin, bot: row.bot, task: row.task, at: row.at, open: row.open === true, reported: typeof row.reported === "number" ? row.reported : 0, stopped: row.stopped === true });
        }
      }
    } catch { this.unreadable = true; }
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  private save() {
    const now = this.now();
    this.entries = this.entries.filter((entry) => entry.open || entry.at > now - KEEP).slice(-MAX_ENTRIES);
    this.deps.file?.write(JSON.stringify(this.entries));
  }

  /** The checks every use makes (also again after the card's answer): declared, granted, and still the plugin asked about. */
  private allowed(plugin: string, identity?: string): PluginFacts {
    const facts = this.deps.facts(plugin);
    if (!facts) throw new Error("That plugin is not running.");
    const missing = ORCHESTRATE_NEEDS.filter((need) => !facts.permissions.includes(need));
    if (missing.length) throw new Error(`Starting workers needs the ${ORCHESTRATE_NEEDS.map((need) => `"${need}"`).join(", ")} permissions in package.json (missing: ${missing.join(", ")}).`);
    if (!this.deps.world.granted(plugin)) throw new Error("Starting workers needs your permission: this plugin has not been allowed to orchestrate workers.");
    if (identity !== undefined && facts.identity !== identity) throw new Error("The plugin changed while its worker waited for your answer. Nothing was started.");
    return facts;
  }

  private quota() {
    const given = this.deps.world.quota?.() ?? {};
    const pick = (value: number | undefined, fallback: number, max: number) => (Number.isInteger(value) && value! >= 1 ? Math.min(value!, max) : fallback);
    return { atOnce: pick(given.atOnce, DEFAULT_QUOTA.atOnce, QUOTA_MAX.atOnce), perDay: pick(given.perDay, DEFAULT_QUOTA.perDay, QUOTA_MAX.perDay) };
  }

  /** Why a plugin may not have one more worker now (null: it may). Reservations count as workers at work. */
  private full(plugin: string): string | null {
    const { atOnce, perDay } = this.quota();
    const mine = this.entries.filter((entry) => entry.plugin === plugin);
    if (mine.filter((entry) => entry.open).length >= atOnce) return `This plugin already has ${atOnce} workers at work (the most at once). Nothing was started.`;
    if (mine.filter((entry) => entry.at > this.now() - DAY).length >= perDay) return `This plugin has started ${perDay} workers in the last 24 hours (the most). Nothing was started.`;
    return null;
  }

  private async card(facts: PluginFacts, port: WorkerPort, params: StartParams): Promise<boolean> {
    const text = `The plugin "${oneLine(facts.name, 100)}" (${facts.identity.slice(0, 12)}, written by a bot) wants to start a worker for ${JSON.stringify(oneLine(port.id, 100))}: ${JSON.stringify(oneLine(params.name ?? "", 100))}.\nIt would read and write files and run programs in that bot's folder.\nInstructions: ${JSON.stringify(oneLine(params.instructions, 400))}${params.model ? `\nModel: ${JSON.stringify(oneLine(params.model, 60))}` : ""}`;
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      this.deps.ask({ text, choices: [{ label: "Allow once" }, { label: "Refuse" }], typed: false }).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.deps.cardWaitMs ?? CARD_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    return !!answer && "index" in answer && answer.index === 0;
  }

  /** `workers.start`: every check, then the worker. Returns the task id and run. */
  async start(plugin: string, params: StartParams): Promise<{ taskId: string; run: number }> {
    if (this.unreadable) throw new Error("The record of the workers plugins started could not be read, so none is started. Nothing was started.");
    const facts = this.allowed(plugin);
    if (params.model && maySpecWrite(params.model, this.deps.world.specWriters?.() ?? DEFAULT_SPEC_WRITERS)) {
      throw new Error("A plugin's worker may not use a model that may change spec/. Choose another model, or none. Nothing was started.");
    }
    const refused = this.full(plugin);
    if (refused) throw new Error(refused);
    const port = this.deps.world.workers(params.bot);
    if (typeof port === "string") throw new Error(port);
    if (facts.botWritten) {
      if (!(await this.card(facts, port, params))) throw new Error("You did not allow this worker. Nothing was started.");
      // Authority at use: what the card showed is still true, and the room is still there.
      this.allowed(plugin, facts.identity);
      const nowFull = this.full(plugin);
      if (nowFull) throw new Error(nowFull);
    }
    const entry: Entry = { plugin, bot: port.id, task: null, at: this.now(), open: true, reported: 0, stopped: false };
    this.entries.push(entry);
    try {
      this.save();
      const args: Record<string, unknown> = { instructions: params.instructions, name: oneLine(params.name ?? "", 200) || undefined, ...(params.group ? { group: oneLine(params.group, 80) } : {}), ...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}) };
      const started = await port.start(args);
      entry.task = started.task_id;
      this.save();
      return { taskId: started.task_id, run: started.run };
    } catch (error) {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      try { this.save(); } catch { /* the reservation stays in memory only */ }
      throw error;
    }
  }

  /** The worker this plugin started, or the one answer for "not yours" and "not there" (nothing says which). */
  private mine(plugin: string, taskId: string): Entry {
    const entry = this.entries.find((candidate) => candidate.plugin === plugin && candidate.task === taskId);
    if (!entry) throw new Error("No such worker.");
    return entry;
  }

  async send(plugin: string, taskId: string, message: string): Promise<{ run: number; how: string }> {
    const entry = this.mine(plugin, taskId);
    this.allowed(plugin);
    const port = this.deps.world.workers(entry.bot);
    if (typeof port === "string") throw new Error(port);
    // A run into a worker that is idle takes a place again: the same limit as a new one (not the daily count).
    const wasOpen = entry.open;
    if (!wasOpen) {
      const { atOnce } = this.quota();
      if (this.entries.filter((candidate) => candidate.plugin === plugin && candidate.open).length >= atOnce) throw new Error(`This plugin already has ${atOnce} workers at work (the most at once).`);
      entry.open = true;
      entry.stopped = false;
    }
    const sent = await port.send(taskId, message).catch((error: Error) => ({ ok: false as const, reason: error.message }));
    if (!sent.ok) {
      entry.open = wasOpen;
      throw new Error(sent.reason);
    }
    this.save();
    return { run: sent.run, how: sent.how };
  }

  async cancel(plugin: string, taskId: string): Promise<{ stopped: boolean }> {
    const entry = this.mine(plugin, taskId);
    const port = this.deps.world.workers(entry.bot);
    if (typeof port === "string") throw new Error(port);
    const stopped = await port.stop(taskId);
    // Once: a second cancel finds it closed and gives nothing back twice.
    if (entry.open) { entry.open = false; entry.stopped = true; this.save(); }
    return { stopped };
  }

  /** A worker's run ended (the core's own event): its plugin hears it, at most once per run, and its place is free. */
  ended(taskId: string, run: number, status: string, report: string) {
    const entry = this.entries.find((candidate) => candidate.task === taskId);
    if (!entry || entry.stopped || entry.reported >= run) return;
    entry.reported = run;
    entry.open = false;
    try { this.save(); } catch { return; }
    this.deps.tell(entry.plugin, "workerReport", { botId: entry.bot, taskId, run, status, report, startedBy: entry.plugin });
  }
}
