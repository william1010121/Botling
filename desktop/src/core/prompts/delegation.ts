// The app-owned delegation policy every coordinator is told, composed from sections by what its engine can do.
// Engines differ only by their DelegationCaps; no section branches on the engine.
//
// The Codex text is the Swift app's `codexDelegationPolicy`, character for character (test/unit/prompts.test.ts),
// and every engine's output is frozen byte for byte (test/unit/delegation-prompt-snapshot.test.ts): one changed
// character gives every bot a new session, so change the wording only on purpose.

// Type-only: heads.ts reaches prompts.ts (through briefing.ts), which builds its constants from this module.
import type { Engine } from "../heads";
import { DEFAULT_ORCHESTRATION_RULES, renderFragments, type OrchestrationRules, type SectionId } from "../orchestration/default-rules";
// The rule texts live in orchestration/default-rules.ts (M7-O02), behind `OrchestrationRules`; re-exported for their old importers.
export { FILES_TOUCHED_HANDOFF_RULE, VERBATIM_HANDOFF_RULE, WORKER_LOOKUP_RULE, WORKER_REPORT_BLOCK_RULE } from "../orchestration/default-rules";

/** What a coordinator's engine can do, as far as the delegation policy cares (provider-layer plan §4.3). */
export interface DelegationCaps {
  /** The engine's name as the policy gives it. */
  name: string;
  /** The app tools the coordinator itself is given. */
  appTools: ReadonlySet<string>;
  /** app_send_message joins a busy worker's running turn (true), or a busy worker rejects it and follow-ups name the run (false). */
  steerWorkerRun: boolean;
  /** How a worker's report reaches the coordinator: an app message, a background turn's tool output, or a queued report prompt. */
  reportVia: "message" | "toolOutput" | "prompt";
}

export const DELEGATION_CAPS: Record<Engine, DelegationCaps> = {
  claude: { name: "Claude", appTools: new Set(["app_handoff", "app_send_message", "app_cancel_task", "app_routines"]), steerWorkerRun: true, reportVia: "message" },
  codex: {
    name: "Codex",
    appTools: new Set(["app_routines", "app_monitor_start", "app_monitor_status", "app_monitor_cancel", "app_handoff", "app_send_message", "app_task_checkpoint"]),
    steerWorkerRun: true, reportVia: "toolOutput",
  },
  agy: { name: "Antigravity", appTools: new Set(["app_task_checkpoint", "app_reconcile_report", "app_handoff", "app_send_message", "app_cancel_task", "app_routines"]), steerWorkerRun: false, reportVia: "prompt" },
};

export interface PromptContext {
  engine: Engine;
  /** The git worktree the app attached to this chat; every worker already works in it. */
  worktree?: string | null;
  /** "full": the policy as its own block (Codex, Antigravity); "line": one line of the style list (Claude). */
  form?: "full" | "line";
}

interface PolicySection {
  id: SectionId;
  when?(caps: DelegationCaps): boolean;
}

/**
 * What an app-managed worker is told about app_notify_owner (every engine's worker prompt): when a note to its owner
 * is worth sending. Interim only; the final message stays the report.
 */
export const WORKER_NOTIFY_RULE = "While you work, the app_notify_owner tool sends a short note to the bot that started you, and only to it: kind \"report\" when you reach a milestone others can act on or a plan or progress file is ready (give its full paths in files), kind \"question\" when an answer would change your work (the answer joins this run as a message; carry on meanwhile with what does not depend on it). Not for chatter or routine progress; your final message is still your report.";

/** What a coordinator does with a worker's note (<app_worker_note>): interim news to act on, never the final report. */
export const workerNoteRule = (caps: Pick<DelegationCaps, "steerWorkerRun">, rules: OrchestrationRules = DEFAULT_ORCHESTRATION_RULES): string => renderFragments(rules.workerNote(caps));

/** In order. Where a worker cannot be steered, ownership is stated after the follow-up rule, with the run contract it depends on. Their text is `OrchestrationRules.section`. */
const SECTIONS: PolicySection[] = [
  { id: "header" },
  { id: "monitors", when: (caps) => caps.appTools.has("app_monitor_start") },
  { id: "coordinator" },
  { id: "authorization" },
  { id: "scope" },
  { id: "dispatch" },
  { id: "worktree" },
  { id: "validation" },
  { id: "ownership", when: (caps) => caps.steerWorkerRun },
  { id: "followUp" },
  { id: "ownership", when: (caps) => !caps.steerWorkerRun },
  { id: "runDispatch", when: (caps) => !caps.steerWorkerRun },
  // Before the reports: the agy report text ends with a newline that its prompt hash has always kept.
  { id: "notes" },
  { id: "reports" },
];

/**
 * The delegation policy for a coordinator with these capabilities: its sections joined by blank lines, or the one-line form.
 * `rules` is the one place the text comes from (core's defaults unless the caller gives a set).
 */
export function delegationPolicy(caps: DelegationCaps, ctx: PromptContext, rules: OrchestrationRules = DEFAULT_ORCHESTRATION_RULES): string {
  if (ctx.form === "line") return renderFragments(rules.claudeLine(caps));
  return policySectionIds(caps).map(id => renderFragments(rules.section(id, caps, ctx))).join("\n\n");
}

/** The sections of the sectioned policy these capabilities get, in output order (joined by blank lines). */
export const policySectionIds = (caps: DelegationCaps): SectionId[] => SECTIONS.filter(section => section.when?.(caps) ?? true).map(section => section.id);

/** The one line a plugin-started worker with Bash gets when the app has a shot command (claude-workers.ts): where to get screenshots, so it builds no renderer of its own. */
export const shotWorkerRule = (command: string): string =>
  `Screenshots: use ${command} <component folder> --out <dir> [--theme light] [--sizes 1x1,2x1,2x2,4x2] (--help lists the rest); never \`find /\`, never hunt for or launch your own Chrome.`;
