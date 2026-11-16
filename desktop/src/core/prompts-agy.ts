import { DELEGATION_CAPS, delegationPolicy } from "./prompts/delegation";
import { DEFAULT_ORCHESTRATION_RULES, type OrchestrationRules } from "./orchestration/default-rules";

/** The Antigravity coordinator's policy without an app worktree (botPrompts builds its own, with the worktree). */
export const agyDelegationPolicy = (rules: OrchestrationRules = DEFAULT_ORCHESTRATION_RULES): string => delegationPolicy(DELEGATION_CAPS.agy, { engine: "agy" }, rules);
export const AGY_DELEGATION_POLICY = agyDelegationPolicy();

export const agyWorkerPolicy = (rules: OrchestrationRules = DEFAULT_ORCHESTRATION_RULES): string => `You are an execution worker, not the coordinator. Execute only the assigned authorized scope. Do not delegate or emit handoff/plugin tags. Preserve permission protections and report denials without bypass. For research/design-only work, deliver findings and stop: no source implementation in any files, including new files or isolated worktrees. File release and worker reports never grant implementation authorization. Own only assigned files; preserve concurrent work. Return concrete results, source locations, relevant tests and blockers. Worker report is not acceptance of the overall task. ${rules.workerRules().lookup.text} ${rules.workerRules().reportBlock.text}`;
export const AGY_WORKER_POLICY = agyWorkerPolicy();
