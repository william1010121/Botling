// Implements spec/driver/restart-driver.ts against the real code: Core.prepareRestart, cancelRestart and
// shutdown (on a core with stand-in bots, as test/unit/restart-shutdown-checkpoint.test.ts makes one) and
// RestartJournal.recover. Translation only. A crash is emulated, not decided here: the dead process's
// journal writes are not made, its later effects do not count and it writes no more trace lines.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../src/core/server";
import { RESTART_FILE, RESTART_MAX_AGE_MS, RestartJournal, type RestartEntry } from "../src/core/restart-continuation";
import type {
  RestartBlocked, RestartBootPlan, RestartDriver, RestartDriverOptions, RestartEntryState, RestartObservation,
  RestartReason, RestartRecoveryEvent, RestartTraceStep,
} from "../../spec/driver/restart-driver";

const OWN_BLOCKER = "A permission decision was pending. Review the original request before continuing.";
const DELIVERY_FAILURE = "Original bot unavailable.";

/** entry.blocked, by cause. */
export function blockedKind(blocked: string | null | undefined): RestartBlocked {
  if (!blocked) return "none";
  if (blocked.startsWith("This bot's shutdown did not finish")) return "shutdown";
  if (/^\w*Error\b/.test(blocked)) return "deliver";
  return "own";
}

/** A reason recover() gave notice() for, by cause. */
export function reasonKind(reason: string): RestartReason {
  if (reason.includes("too old to resume")) return "stale";
  if (reason.includes("did not confirm the restart checkpoint")) return "unconfirmed";
  if (reason.includes("delivery is uncertain after a crash")) return "uncertain";
  return blockedKind(reason) as RestartReason;
}

type Journal = { phase: "preparing" | "ready"; entries: RestartEntry[] };
const states = (journal: Journal | null) => new Map((journal?.entries ?? []).map((e) => [e.botId, e.state] as const));

export function restartDriver(options: RestartDriverOptions): RestartDriver {
  const { bots, plugins, dataDir } = options;
  const file = join(dataDir, RESTART_FILE);
  const work = new Map<string, { own: boolean }>();
  const sent = new Map(bots.map((b) => [b, 0]));
  const told = new Map<string, RestartReason | "none">(bots.map((b) => [b, "none"]));
  const settled = new Map<string, boolean>();
  let stops = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let core: any = null;
  let shutdown: Promise<void> | null = null;
  let clock = 0;

  const journal = (): Journal | null => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  const stopping = (part: string) => () => new Promise<void>((resolve, reject) => { stops.set(part, { resolve, reject }); });
  const oldApp = () => {
    if (core) return core;
    core = Object.create(Core.prototype);
    core.options = { dataDir };
    core.bots = new Map(bots.map((botId) => [botId, {
      restartEntries: (): RestartEntry[] => {
        const w = work.get(botId);
        return w ? [{ botId, engine: "claude", sessionId: `${botId}-session`, continue: true, queued: [], blocked: w.own ? OWN_BLOCKER : undefined }] : [];
      },
      holdForSwap: () => {},
      shutdown: stopping(botId),
    }]));
    core.plugins = { shutdown: stopping(plugins) };
    return core;
  };

  return {
    start: (bot, own) => { work.set(bot, { own }); },
    finish: (bot) => { work.delete(bot); },
    prepare: () => oldApp().prepareRestart(),
    cancel: () => oldApp().cancelRestart(),
    beginShutdown: () => {
      stops = new Map();
      settled.clear();
      shutdown = oldApp().shutdown();
    },
    settle: (part, ok) => { settled.set(part, ok); },
    ready: async () => {
      // Core.shutdown waits for all participants together, so their order is not observable: settle them now.
      await Promise.resolve();
      for (const [part, stop] of stops) settled.get(part) ? stop.resolve() : stop.reject(Error("spec: shutdown failed"));
      await shutdown!.catch(() => {});
      core = null; shutdown = null;
    },
    crash: () => { core = null; shutdown = null; },
    expire: () => { clock = RESTART_MAX_AGE_MS + 60_000; },
    boot: (plan: RestartBootPlan) => {
      const events: RestartRecoveryEvent[] = [];
      const traceDir = process.env.BOTLING_SPEC_TRACE;
      let dead = false;
      // The process dies at the first event boundary after `crashAfter` events.
      const alive = () => {
        if (!dead && plan.crashAfter !== undefined && events.length >= plan.crashAfter) {
          dead = true;
          delete process.env.BOTLING_SPEC_TRACE;
        }
        return !dead;
      };
      let last = states(journal());
      class Recovering extends (RestartJournal as unknown as new (dir: string) => { recover: RestartJournal["recover"] }) {
        save(value: Journal) {
          if (!alive()) return;
          (RestartJournal.prototype as unknown as { save(v: Journal): void }).save.call(this, value);
          const now = states(value);
          for (const [bot, state] of now) {
            if (last.get(bot) === state) continue;
            const action = ({ claimed: "Claim", dispatched: "Dispatch", blocked: "Block" } as const)[state as "claimed" | "dispatched" | "blocked"];
            if (action) events.push({ action, bot });
          }
          last = now;
        }
      }
      try {
        new Recovering(dataDir).recover((entry) => {
          if (!alive()) return;
          const ok = !plan.fail.includes(entry.botId);
          events.push({ action: "Deliver", bot: entry.botId, ok });
          if (!ok) throw Error(DELIVERY_FAILURE);
          sent.set(entry.botId, sent.get(entry.botId)! + 1);
        }, (entry, why) => {
          if (!alive()) return;
          const reason = reasonKind(why);
          told.set(entry.botId, reason);
          events.push({ action: "Notice", bot: entry.botId, reason });
        }, Date.now() + clock);
      } finally {
        if (traceDir !== undefined) process.env.BOTLING_SPEC_TRACE = traceDir;
      }
      alive();
      return { events, crashed: dead };
    },
    observe: (): RestartObservation => {
      const value = journal();
      const entries = new Map((value?.entries ?? []).map((e) => [e.botId, e] as const));
      return {
        phase: value?.phase ?? "none",
        entry: Object.fromEntries(bots.map((b) => [b, (entries.get(b)?.state ?? "absent") as RestartEntryState])),
        blk: Object.fromEntries(bots.map((b) => [b, blockedKind(entries.get(b)?.blocked)])),
        sent: Object.fromEntries(sent),
        told: Object.fromEntries(told),
      };
    },
  };
}

/** One line the app wrote with specTrace("restart", …), in the driver's words. */
export function restartTraceStep(line: { action: string; state: Record<string, any> }): RestartTraceStep {
  const { bot, part, ok, reason, phase, entries } = line.state;
  const step: RestartTraceStep = { action: line.action, bot, part, ok, reason: reason === undefined ? undefined : reasonKind(reason) };
  if (["Prepare", "Cancel", "BeginShutdown", "Ready", "Claim", "Dispatch", "Block"].includes(line.action)) {
    const list = entries as { bot: string; state: RestartEntryState; blocked: string | null }[];
    step.journal = {
      phase,
      entry: Object.fromEntries(list.map((e) => [e.bot, e.state])),
      blk: Object.fromEntries(list.map((e) => [e.bot, blockedKind(e.blocked)])),
    };
  }
  return step;
}
