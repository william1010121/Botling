// What the Routines panel says about a routine. The words themselves (cadence, next run, standing, last result) are shared with the
// sub bot menu and the background-work row (Web/src/routine-words.ts); what is here is the panel's own: its groups, its kind labels
// and its buttons.
import { groupOf, type Group, type RoutineLike } from "../../../../Web/src/routine-words";

export * from "../../../../Web/src/routine-words";

export type Operation = "pause" | "resume" | "cancel";

export const GROUPS: readonly Group[] = ["attention", "active", "paused", "done"];
export const GROUP_LABEL: Record<Group, string> = { attention: "Needs a look", active: "Running", paused: "Paused", done: "Finished" };
export const KIND_LABEL = { once: "Once", repeat: "Repeats", watch: "Watch" } as const;

/** The buttons a routine in this state has. */
export function operationsFor(status: string): Operation[] {
  const out: Operation[] = [];
  if (status === "pending" || status === "enabled" || status === "due") out.push("pause");
  if (status === "paused") out.push("resume");
  if (status !== "fired" && status !== "cancelled" && status !== "delivery_uncertain") out.push("cancel");
  return out;
}
export const LABEL: Record<Operation, string> = { pause: "Pause", resume: "Resume", cancel: "Cancel" };

/** The one-line summary above the list ("5 running · 1 paused · 1 needs a look"). */
export function summary(routines: readonly RoutineLike[]): string {
  const count: Record<Group, number> = { attention: 0, active: 0, paused: 0, done: 0 };
  for (const routine of routines) count[groupOf(routine)] += 1;
  return [
    count.active && `${count.active} running`,
    count.paused && `${count.paused} paused`,
    count.attention && `${count.attention} need${count.attention === 1 ? "s" : ""} a look`,
    count.done && `${count.done} finished`,
  ].filter(Boolean).join(" · ");
}
