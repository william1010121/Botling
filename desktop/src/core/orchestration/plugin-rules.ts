// M7-O04: the orchestration rules a plugin gives, and core's own rules when it cannot. Plan: .bot/artifacts/v3-orch/M7-O01-plan.md
// (e) G1-G4 and §4.7. A plugin's answer is data: `rules.json` of its folder, `{ format: 1, slots: { <policy fragment id>: <text> } }`.
// Only a fragment core marked "P" (policy) takes a slot's text; a "C" (contract) fragment is never looked up, so no answer can touch it.
// The answer is read OFF the path that starts a turn: `current()` is synchronous and gives the last good set (or core's own); a turn
// never waits for a plugin. `refresh()` asks (limit RULES_TIME_LIMIT_MS) and swaps the set when it has an answer; a failure, a
// throw or a late answer puts core's own rules back at once and says so once.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ORCHESTRATION_RULES, type Fragment, type OrchestrationRules } from "./default-rules";
import { BUILTIN_RULES_SHA256 } from "./pinned-hash";

export const BUILTIN_RULES_PLUGIN = "botling.orchestration";
export const RULES_TIME_LIMIT_MS = 3_000;
/** A limit timer that fires more than this after its due time was stuck behind core's own synchronous work; it is armed again at most this many times. */
const STALL_SLACK_MS = 250, STALL_EXTENSIONS = 2;
export const RULES_NOTICE = "The orchestration rules plugin did not answer in time or failed; Botling is using its own rules.";
const FILE_MAX = 64 * 1024, SLOT_MAX = 2_000, SLOTS_MAX = 12_000;
/** Said twice, once to the coordinator and once to its workers: an answer gives both or neither (plan §4.6), so the two sides cannot disagree. */
const PAIR = ["followUp.5", "worker.reportBlock"] as const;
const FORBIDDEN_SLOTS: ReadonlySet<string> = new Set(["workerModel", "workerEffort", "workerEngine", "model", "effort", "engine"]);

export type Slots = ReadonlyMap<string, string>;
/** Asks one plugin for its slots; rejects when it cannot answer. `null`: there is no rules plugin to ask (the app runs without a plugin system), so core's own rules are the rules, not a fallback, and nothing is said. */
export type RulesSource = () => Promise<Slots | null>;

/** rules.json's bytes: a regular file (never a link) of at most FILE_MAX bytes. */
async function readRules(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > FILE_MAX) throw new Error("rules.json is not a small regular file.");
    const bytes = await handle.readFile();
    if (bytes.length > FILE_MAX) throw new Error("rules.json is too big.");
    return bytes;
  } finally { await handle.close(); }
}

/** The slots of rules.json; all or nothing: one bad value, one too long text or too much text refuses the whole answer. */
export function parseSlots(bytes: Buffer): Slots {
  const value = JSON.parse(bytes.toString("utf8")) as { format?: unknown; slots?: unknown } | null;
  const raw = value?.slots;
  if (value?.format !== 1 || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("rules.json is not format 1.");
  // F3: a plugin gives sentences, never a worker's model, effort or engine: no other key is accepted, at the top or as a slot.
  const stray = Object.keys(value).find((key) => key !== "format" && key !== "slots") ?? Object.keys(raw).find((id) => FORBIDDEN_SLOTS.has(id));
  if (stray) throw new Error(`rules.json: "${stray}" is not accepted (a plugin cannot choose a worker's model, effort or engine).`);
  if (PAIR.some((id) => Object.hasOwn(raw, id)) && !PAIR.every((id) => Object.hasOwn(raw, id))) throw new Error(`rules.json: "${PAIR.join("\" and \"")}" are given together or not at all.`);
  let total = 0;
  const slots = new Map<string, string>();
  for (const [id, text] of Object.entries(raw)) {
    if (typeof text !== "string" || text.length > SLOT_MAX) throw new Error(`rules.json: the text of "${id}" is not a string of at most ${SLOT_MAX} characters.`);
    total += Buffer.byteLength(JSON.stringify(text));
    slots.set(id, text);
  }
  if (total > SLOTS_MAX) throw new Error(`rules.json: all texts together are over ${SLOTS_MAX} bytes.`);
  return slots;
}

/**
 * The plugin shipped with the app, read from the app's own folder only: the library, the Plugins page's on/off and any project are
 * never asked, so none of them can replace or switch it off. Unless the bytes are the pinned ones it is refused.
 */
export const builtinSource = (builtIns: string | null): RulesSource => async () => {
  if (!builtIns) throw new Error("This build has no built-in plugins.");
  const bytes = await readRules(join(builtIns, BUILTIN_RULES_PLUGIN, "rules.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== BUILTIN_RULES_SHA256) throw new Error("The built-in rules.json is not the one that shipped.");
  return parseSlots(bytes);
};

/**
 * A plugin the user chose by name in settings.json (`orchestrationPlugin`), only while it is on, and only the rules.json whose sha256 the
 * user wrote next to it (`orchestrationPluginSha256`): a bot that edits the chosen plugin's file afterwards gets core's rules, not its text.
 */
export const chosenSource = (plugin: { folder: string; enabled: boolean } | undefined, sha256: string | null): RulesSource => async () => {
  if (!plugin?.enabled) throw new Error("The chosen orchestration plugin is not installed or is off.");
  const bytes = await readRules(join(plugin.folder, "rules.json"));
  if (!sha256 || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("The chosen plugin's rules.json is not the one named in settings.json (orchestrationPluginSha256).");
  return parseSlots(bytes);
};

/** `base` with each policy fragment that has a slot given that text. A contract fragment is never looked up. */
export function withSlots(base: OrchestrationRules, slots: Slots): OrchestrationRules {
  const apply = (fragment: Fragment): Fragment => {
    const text = fragment.kind === "P" ? slots.get(fragment.id) : undefined;
    return text === undefined ? fragment : { ...fragment, text };
  };
  const all = (fragments: readonly Fragment[]) => fragments.map(apply);
  return {
    section: (id, caps, ctx) => all(base.section(id, caps, ctx)),
    claudeLine: (caps) => all(base.claudeLine(caps)),
    claudeMainLine: () => all(base.claudeMainLine()),
    onRequestLine: (caps) => all(base.onRequestLine(caps)),
    workerNote: (caps) => all(base.workerNote(caps)),
    workerRules: () => { const rules = base.workerRules(); return { lookup: apply(rules.lookup), reportBlock: apply(rules.reportBlock) }; },
    // Not yet connected to the engine choice (worker-core `prepared.engine ?? adapter.engine`): until it is, only the coordinator's own engine is accepted, and nothing but it (never a model or effort, F3).
    workerDefaults: (coordinator) => ({ workerEngine: coordinator }),
  };
}

export class OrchestrationRulesBook {
  private rules: OrchestrationRules = DEFAULT_ORCHESTRATION_RULES;
  private flight: Promise<void> | null = null;
  private told = false;
  private say?: (text: string) => void;

  /** `source` is called on each refresh (so a changed setting is read again); `limitMs` is the time a plugin has to answer. */
  constructor(private readonly source: RulesSource, private readonly limitMs = RULES_TIME_LIMIT_MS) {}

  /** The set every prompt is built from. Synchronous: nothing here waits for a plugin. */
  current(): OrchestrationRules { return this.rules; }

  /**
   * Asks the plugin (at most one ask at a time) and swaps the set. Never rejects and never throws. `say` (the latest one given while
   * the ask is under way) is told once per failure period, until the next answer; a failure with no `say` waits for the next refresh that has one.
   */
  refresh(say?: (text: string) => void): Promise<void> {
    if (say) this.say = say;
    return this.flight ??= this.ask().finally(() => { this.flight = null; this.say = undefined; });
  }

  private async ask(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => {
        let extensions = 0;
        const arm = () => {
          const due = Date.now() + this.limitMs;
          timer = setTimeout(() => {
            // A timer that fires long after it was due was held back by core's own synchronous work (a stuck event loop), not by the
            // plugin: its answer could not be read meanwhile (switching a bot to Antigravity checks a 405 MB runtime in the same tick). The
            // plugin gets its time again from now, at most STALL_EXTENSIONS times; one that really does not answer still ends in the notice.
            if (Date.now() - due > STALL_SLACK_MS && extensions < STALL_EXTENSIONS) { extensions += 1; arm(); } else reject(new Error("No answer in time."));
          }, this.limitMs);
          timer.unref?.();
        };
        arm();
      });
      const slots = await Promise.race([this.source(), late]);
      this.rules = slots ? withSlots(DEFAULT_ORCHESTRATION_RULES, slots) : DEFAULT_ORCHESTRATION_RULES;
      this.told = false;
    } catch {
      this.rules = DEFAULT_ORCHESTRATION_RULES;
      if (!this.told && this.say) { this.told = true; this.say(RULES_NOTICE); }
    } finally { clearTimeout(timer); }
  }
}
