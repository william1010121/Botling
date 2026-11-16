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
// M7-O04 (F6, G1, G2): a plugin that is not shipped cannot get a worker by having a bot start it either (`bots.send`, `bots.wake`): a worker
// the bot starts in a turn that began with such a plugin's message goes through the same checks (`admitHeard`; the core remembers
// that message in `Plugins.origins` until the user writes to the bot). A bot-written plugin also gets a card for every `workers.send`
// (a new instruction is a new worker's worth of trust), may only work on bots it made itself, and has one card open at a time.
// No plugin gets Maintainer (the plugin library) as a target: the world refuses it (`workers`).
// The owner of every worker is the bot it runs for; this book only remembers which plugin started it (quota, who may
// send or cancel it, who hears its report). A cancel or a send for a worker the plugin did not start gets the same
// answer as for one that does not exist.
// M7-O03b: every worker and every message a plugin sends carries the plugin's name and hash (`StartedBy`: the ledger's
// `startedBy`, the name the user sees, a line before each message). When the plugin goes (disabled, removed, held back,
// or replaced by code with another hash), `reconcile` hands each of its workers back to core: the bot is, and always was,
// the owner, so the worker runs on and its report reaches the bot exactly as before; only the plugin's own copy of the
// report and its right to send or cancel end. It is synchronous, so it runs before the new plugin's host starts. A
// report the plugin is owed is kept until the host says it listens (`tell` answers false until then) and is told again
// after a restart; `pickUp` asks the core where each worker stands, so a run that ended while nobody was told is told
// once and a place is not held for a worker that is gone.
import type { StartedBy } from "../worker-core/started-by";
import { maySpecWrite, DEFAULT_SPEC_WRITERS } from "../spec-guard";
import type { AppAnswer, AppQuestion } from "../plugins/types";

/** What a plugin must declare in package.json for `workers.start` (the user's grant is asked on top of these). */
export const ORCHESTRATE_NEEDS = ["orchestrate", "exec", "files", "bots"] as const;
export const DEFAULT_QUOTA = { atOnce: 4, perDay: 40 } as const;
export const QUOTA_MAX = { atOnce: 16, perDay: 200 } as const;
/** The handoff argument that makes a worker one a plugin started: fewer rights than a worker the bot started itself (ClaudeWorkers.prepare). */
export const PLUGIN_STARTED = "pluginStarted";
/** Set (a symbol, so no JSON from a model can carry it) on a handoff this book already checked; `admitHeard` lets it through. */
export const ADMITTED = Symbol("plugin-workers admitted");
/** What a worker the bot starts for a plugin's message may be given (the same few things `workers.start` takes). */
const HEARD_KEYS: ReadonlySet<string> = new Set(["instructions", "prompt", "task", "name", "description", "group", "model", "effort", "engine"]);
const DAY = 86_400_000, KEEP = 7 * DAY, MAX_ENTRIES = 1_000, CARD_WAIT_MS = 600_000;

/** One bot's Claude-process worker host, as the world lends it (null/string from `workers`: why there is none). */
export interface WorkerPort {
  /** The bot's id as plugins name it. */
  id: string;
  start(args: Record<string, unknown>, startedBy?: StartedBy): Promise<{ task_id: string; run: number }>;
  send(taskId: string, text: string, startedBy?: StartedBy): Promise<{ ok: true; how: string; run: number } | { ok: false; reason: string }>;
  stop(taskId: string): Promise<boolean>;
  /** Where a worker stands now, from the core's ledger (null: no such worker). Absent: nothing can be picked up. */
  look?(taskId: string): { run: number; running: boolean; status: string; report: string } | null;
}

export interface OrchestrationWorld {
  /** Whether the user granted this plugin `orchestrate` (its own sheet, like a tier raise); absent in the world: nobody. */
  granted(plugin: string): boolean;
  workers(bot: string): WorkerPort | string;
  /** Whether the bot is one this plugin made (`profile.plugin`): a plugin the bot wrote works only on those. Absent: none is. */
  made?(plugin: string, bot: string): boolean;
  /** Settings: workers at once and workers a day (clamped to QUOTA_MAX). */
  quota?(): { atOnce?: number; perDay?: number };
  /** settings.json `specWriters`. */
  specWriters?(): readonly string[];
}

/** What the core knows of a plugin now (null: not loaded or off). `identity` changes when its manifest does. */
export interface PluginFacts { name: string; identity: string; permissions: readonly string[]; botWritten: boolean }

export interface StartParams { bot: string; instructions: string; name?: string; group?: string; engine?: "claude"; model?: string; effort?: string }

/** A run's report the plugin has not been told yet (cut: the bot has the whole report; this is the plugin's copy). */
interface Owed { run: number; status: string; report: string }
interface Entry {
  plugin: string; bot: string; task: string | null; at: number; open: boolean; reported: number; stopped: boolean;
  /** The plugin's hash when it started this worker (absent: a book older than this). */
  hash?: string;
  /** Handed back to core: no longer this plugin's to send to, cancel or hear from; it still counts at work until it ends. */
  handed?: true;
  owed?: Owed[];
}
const OWED_KEEP = 3, OWED_TEXT = 8_000;

export interface PluginWorkersDeps {
  world: OrchestrationWorld;
  facts(plugin: string): PluginFacts | null;
  ask(question: AppQuestion): Promise<AppAnswer | null>;
  /** `workerReport` to the plugin that started the worker (only to it). `false`: its host did not take it now (it stays owed). */
  tell(plugin: string, event: "workerReport", data: Record<string, unknown>): unknown;
  log?(line: string): void;
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
          // A reservation that never got its task id was cut off by the last stop: it counts for the day, not as at work.
          const owed = Array.isArray(row.owed) ? (row.owed as Record<string, unknown>[]).filter((o) => Number.isSafeInteger(o.run) && typeof o.status === "string" && typeof o.report === "string").map((o) => ({ run: o.run as number, status: o.status as string, report: o.report as string })).slice(-OWED_KEEP) : [];
          this.entries.push({
            plugin: row.plugin, bot: row.bot, task: row.task, at: row.at, open: row.open === true && row.task !== null, reported: typeof row.reported === "number" ? row.reported : 0, stopped: row.stopped === true,
            ...(typeof row.hash === "string" ? { hash: row.hash } : {}), ...(row.handed === true ? { handed: true as const } : {}), ...(owed.length ? { owed } : {}),
          });
        }
      }
    } catch { this.unreadable = true; }
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  private save() {
    const now = this.now();
    this.entries = this.entries.filter((entry) => entry.open || entry.at > now - KEEP);
    // Over the most: the oldest rows that nothing counts any more go (closed, older than a day, nothing owed). A row at work,
    // one from the last day (the quota counts it) or one with a report owed is never the one forgotten.
    let excess = this.entries.length - MAX_ENTRIES;
    if (excess > 0) {
      this.entries = this.entries.filter((entry) => {
        if (excess <= 0 || entry.open || entry.at > now - DAY || entry.owed?.length) return true;
        excess -= 1;
        return false;
      });
    }
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

  /** One card at a time per plugin (G2): a plugin that asks again while one waits is refused, so cards cannot pile up. */
  private readonly cards = new Set<string>();

  private async card(facts: PluginFacts, botId: string, params: StartParams, sending = false): Promise<boolean> {
    if (this.cards.has(facts.name)) throw new Error("This plugin already has a worker waiting for your answer. Nothing was started.");
    const text = `The plugin "${oneLine(facts.name, 100)}" (${facts.identity.slice(0, 12)}, written by a bot) wants to ${sending ? "give a worker new instructions" : "start a worker"} for ${JSON.stringify(oneLine(botId, 100))}: ${JSON.stringify(oneLine(params.name ?? "", 100))}.\nIt would read and write files and run programs in that bot's folder.\nInstructions: ${JSON.stringify(oneLine(params.instructions, 400))}${params.model ? `\nModel: ${JSON.stringify(oneLine(params.model, 60))}` : ""}`;
    let timer: NodeJS.Timeout | undefined;
    this.cards.add(facts.name);
    try {
      const answer = await Promise.race([
        this.deps.ask({ text, choices: [{ label: "Allow once" }, { label: "Refuse" }], typed: false }).catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.deps.cardWaitMs ?? CARD_WAIT_MS); }),
      ]);
      return !!answer && "index" in answer && answer.index === 0;
    } finally { clearTimeout(timer); this.cards.delete(facts.name); }
  }

  /** G1: a plugin the bot wrote works on the bots it made, not on the user's own. */
  private mayWorkOn(facts: PluginFacts, botId: string) {
    if (facts.botWritten && !this.deps.world.made?.(facts.name, botId)) throw new Error("A plugin a bot wrote may only start workers on bots it made itself. Nothing was started.");
  }

  /** The checks before a worker's room is taken: the record is readable, the plugin is allowed, the model is not one that may change spec/, there is room. */
  private gate(plugin: string, model?: string): PluginFacts {
    if (this.unreadable) throw new Error("The record of the workers plugins started could not be read, so none is started. Nothing was started.");
    const facts = this.allowed(plugin);
    if (model && maySpecWrite(model, this.deps.world.specWriters?.() ?? DEFAULT_SPEC_WRITERS)) {
      throw new Error("A plugin's worker may not use a model that may change spec/. Choose another model, or none. Nothing was started.");
    }
    // A place held for a worker that has ended (or is gone) without this book hearing of it is free before the room is counted.
    this.pickUp();
    const refused = this.full(plugin);
    if (refused) throw new Error(refused);
    return facts;
  }

  /** The card (for a plugin a bot wrote), the room taken, then `go`; the room is given back if `go` fails. Shared by `start` and `admitHeard`. */
  private async launched(facts: PluginFacts, botId: string, params: StartParams, go: (startedBy: StartedBy) => Promise<{ task_id: string; run: number }>): Promise<{ taskId: string; run: number }> {
    if (facts.botWritten) {
      if (!(await this.card(facts, botId, params))) throw new Error("You did not allow this worker. Nothing was started.");
      // Authority at use: what the card showed is still true, and the room is still there.
      this.allowed(facts.name, facts.identity);
      const nowFull = this.full(facts.name);
      if (nowFull) throw new Error(nowFull);
    }
    const entry: Entry = { plugin: facts.name, bot: botId, task: null, at: this.now(), open: true, reported: 0, stopped: false, hash: facts.identity };
    this.entries.push(entry);
    const forget = () => { this.entries = this.entries.filter((candidate) => candidate !== entry); this.persist(); };
    // The reservation is written before the worker starts: a write that fails starts nothing (fail closed).
    try { this.save(); } catch (error) { this.entries = this.entries.filter((candidate) => candidate !== entry); throw error; }
    let started: { task_id: string; run: number };
    try {
      started = await go({ plugin: facts.name, hash: facts.identity });
    } catch (error) {
      forget();
      throw error;
    }
    // The worker runs now. A write that fails here does not undo it: it stays counted and the plugin's, and the next write keeps it.
    entry.task = started.task_id;
    this.persist();
    return { taskId: started.task_id, run: started.run };
  }

  /** `workers.start`: every check, then the worker. Returns the task id and run. */
  async start(plugin: string, params: StartParams): Promise<{ taskId: string; run: number }> {
    const facts = this.gate(plugin, params.model);
    const port = this.deps.world.workers(params.bot);
    if (typeof port === "string") throw new Error(port);
    this.mayWorkOn(facts, port.id);
    const args: Record<string, unknown> = { instructions: params.instructions, name: oneLine(params.name ?? "", 200) || undefined, ...(params.group ? { group: oneLine(params.group, 80) } : {}), ...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}) };
    return this.launched(facts, port.id, params, (by) => port.start(args, by));
  }

  /**
   * F6: a worker the bot's own model starts (`app_handoff`) in a turn that began with `plugin`'s message goes through the checks of
   * `workers.start`, whatever the message said, and starts as one a plugin started (fewer rights). `run` is the handoff itself.
   * A handoff this book made (`ADMITTED`) is not checked twice.
   */
  async admitHeard<T extends { task_id: string; run: number }>(plugin: string, botId: string, kind: string, args: Record<string, unknown>, run: (startedBy?: StartedBy) => Promise<T>): Promise<T> {
    if ((args as Record<symbol, unknown>)[ADMITTED] === true) return run();
    if (kind !== "claude-process") throw new Error("This turn began with a plugin's message, and a plugin's worker must be a Claude-process worker. Nothing was started.");
    const stray = Object.keys(args).find((key) => !HEARD_KEYS.has(key));
    if (stray || (args.engine !== undefined && args.engine !== "claude")) throw new Error(`This turn began with a plugin's message: a worker started now takes only instructions, name, group, model and effort ("${stray ?? "engine"}" is not accepted). Nothing was started.`);
    const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
    const params: StartParams = { bot: botId, instructions: text("instructions") ?? text("prompt") ?? text("task") ?? "", name: text("name") ?? text("description"), group: text("group"), model: text("model"), effort: text("effort") };
    const facts = this.gate(plugin, params.model);
    const port = this.deps.world.workers(botId);
    if (typeof port === "string") throw new Error(port);
    this.mayWorkOn(facts, port.id);
    args[PLUGIN_STARTED] = true;
    let started: T | undefined;
    await this.launched(facts, port.id, params, async (by) => (started = await run(by)));
    return started!;
  }

  /**
   * F6: `routines.add` of a plugin that is not shipped. A routine runs later as the bot's own prompt, and what it starts has no card and
   * no quota, so such a plugin needs what `workers.start` needs (declared and granted), and one a bot wrote may not add one at all.
   */
  mayAddRoutine(plugin: string): void {
    if (this.allowed(plugin).botWritten) throw new Error("A routine can start workers by itself, with no card to ask you first: a plugin a bot wrote may not add one.");
  }

  /**
   * The worker this plugin (this very version of it) started and still owns the right to, or the one answer for "not
   * yours" and "not there" (nothing says which): a worker handed back, or started by another hash, is not its.
   */
  private mine(plugin: string, taskId: string): Entry {
    const entry = this.entries.find((candidate) => candidate.plugin === plugin && candidate.task === taskId && !candidate.handed);
    if (!entry || entry.hash === undefined || entry.hash !== this.deps.facts(plugin)?.identity) throw new Error("No such worker.");
    return entry;
  }

  async send(plugin: string, taskId: string, message: string): Promise<{ run: number; how: string }> {
    const entry = this.mine(plugin, taskId);
    const facts = this.allowed(plugin);
    const port = this.deps.world.workers(entry.bot);
    if (typeof port === "string") throw new Error(port);
    // G1: a new instruction is asked about again for a plugin a bot wrote (and only on a bot it made), as a new worker is.
    if (facts.botWritten) {
      this.mayWorkOn(facts, port.id);
      if (!(await this.card(facts, port.id, { bot: port.id, instructions: message }, true))) throw new Error("You did not allow this message to the worker. Nothing was sent.");
      this.allowed(plugin, facts.identity);
    }
    // A run into a worker that is idle takes a place again: the same limit as a new one (not the daily count).
    const wasOpen = entry.open;
    if (!wasOpen) {
      const { atOnce } = this.quota();
      if (this.entries.filter((candidate) => candidate.plugin === plugin && candidate.open).length >= atOnce) throw new Error(`This plugin already has ${atOnce} workers at work (the most at once).`);
      entry.open = true;
      entry.stopped = false;
    }
    const sent = await port.send(taskId, message, { plugin: facts.name, hash: facts.identity }).catch((error: Error) => ({ ok: false as const, reason: error.message }));
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
    // Marked before the stop is awaited: the run's end that comes while the stop is under way is the cancel's, not a report.
    const was = entry.stopped;
    entry.stopped = true;
    let stopped = false;
    try { stopped = await port.stop(taskId); } catch (error) { entry.stopped = was; throw error; }
    if (stopped) {
      // Once: a second cancel finds it closed and gives nothing back twice.
      entry.open = false;
      this.persist();
    } else {
      // Not at work any more (it ended on its own first): that end is a report like any other, from the core's ledger.
      entry.stopped = was;
      this.pickUp();
    }
    return { stopped };
  }

  /** A worker's run ended (the core's own event): its plugin hears it, at most once per run, and its place is free. */
  ended(taskId: string, run: number, status: string, report: string) {
    const entry = this.entries.find((candidate) => candidate.task === taskId);
    if (!entry || entry.stopped) return;
    if (entry.handed) {
      // Handed back: the bot has the report; the plugin is not told, and the place it held is free.
      if (entry.open && run >= entry.reported) { entry.open = false; this.persist(); }
      return;
    }
    if (entry.reported >= run) return;
    this.owe(entry, run, status, report);
  }

  /** A run to tell its plugin: the cursor and the copy are written first, then it is told, then it is no longer owed. */
  private owe(entry: Entry, run: number, status: string, report: string) {
    entry.reported = run;
    entry.open = false;
    entry.owed = [...(entry.owed ?? []), { run, status, report: report.slice(0, OWED_TEXT) }].slice(-OWED_KEEP);
    try { this.save(); } catch { return; }
    this.flush(entry);
  }

  /** Tells what the plugin is owed, oldest first, until its host does not take one; then the book says what is left. */
  private flush(entry: Entry) {
    const owed = entry.owed;
    if (!owed?.length || entry.handed || !this.mayHear(entry)) return;
    let told = 0;
    for (const item of owed) {
      let taken = false;
      try { taken = this.deps.tell(entry.plugin, "workerReport", { botId: entry.bot, taskId: entry.task, run: item.run, status: item.status, report: item.report, startedBy: entry.plugin }) !== false; } catch { taken = false; }
      if (!taken) break;
      told += 1;
    }
    if (!told) return;
    entry.owed = owed.slice(told);
    if (!entry.owed.length) delete entry.owed;
    this.persist();
  }

  /**
   * Authority at use (each tell, also after a restart): the plugin is still the version that started the worker and
   * still has its grant. Not now: the copy stays owed (a hand-back drops it; a grant given back tells it).
   */
  private mayHear(entry: Entry): boolean {
    try { return entry.hash !== undefined && this.deps.facts(entry.plugin)?.identity === entry.hash && this.granted(entry.plugin); } catch { return false; }
  }

  private persist() {
    try { this.save(); } catch (error) { this.deps.log?.(`plugin workers: the book was not saved: ${(error as Error).message}`); }
  }

  /** What is owed to plugins is told again (their host came up and listens now). */
  redeliver() {
    for (const entry of this.entries) this.flush(entry);
  }

  /**
   * The unload hook (the plugin was disabled, removed, held back, is another version now, or lost its `orchestrate` grant): each of its workers goes
   * back to core. Synchronous, so the caller can run it before the new version's host starts.
   */
  reconcile() {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.handed) continue;
      const facts = this.deps.facts(entry.plugin);
      if (facts && entry.hash === facts.identity && this.granted(entry.plugin)) continue;
      entry.handed = true;
      delete entry.owed;
      changed = true;
    }
    if (changed) this.persist();
  }

  /** A bot was removed: each entry on it is closed (the place is free, nothing is owed, the plugin can no longer send to it or cancel it). */
  botGone(bots: readonly string[]) {
    let changed = false;
    for (const entry of this.entries) {
      if (!bots.includes(entry.bot) || (entry.handed && !entry.open)) continue;
      entry.handed = true;
      entry.open = false;
      delete entry.owed;
      changed = true;
    }
    if (changed) this.persist();
  }

  private granted(plugin: string): boolean {
    try { return this.deps.world.granted(plugin) === true; } catch { return false; }
  }

  /**
   * After a restart (or when a host comes up): asks the core where each worker still counted at work stands. One that
   * ended while nobody was told is told once; one that is gone frees its place; one still running stays. Synchronous:
   * nothing else runs between a look and what it changes, so an end the core reports meanwhile cannot be told twice.
   */
  pickUp() {
    if (this.unreadable) return;
    for (const entry of [...this.entries]) {
      if (!entry.open || entry.task === null || entry.stopped) continue;
      let seen: ReturnType<NonNullable<WorkerPort["look"]>>;
      try {
        const port = this.deps.world.workers(entry.bot);
        if (typeof port === "string" || !port.look) continue;
        seen = port.look(entry.task);
      } catch { continue; }
      if (seen === null) { entry.open = false; this.persist(); continue; }
      if (seen.running) continue;
      if (entry.handed || seen.run <= entry.reported) { entry.open = false; this.persist(); } else this.owe(entry, seen.run, seen.status, seen.report);
    }
    this.redeliver();
  }
}
