// What the Routines panel says about a routine (as the app's own panel did before it became this plugin).
import type { RoutineRow } from "../../../../Web/host/src/api";

export type Operation = "pause" | "resume" | "cancel";

/** "Weekdays 09:00 · Asia/Taipei · pending · next 11/3/2026, 9:00:00 AM": when it runs, in which zone, where it stands. */
export function whenLine(routine: RoutineRow): string {
  return `${routine.kind === "once" ? new Date(routine.schedule).toLocaleString() : routine.schedule}`
    + `${routine.timezone !== "system_local" ? ` · ${routine.timezone}` : ""} · ${routine.status.replace("_", " ")}`
    + `${routine.next ? ` · next ${new Date(routine.next).toLocaleString()}` : ""}`;
}

/** A watch's line: its command and how its last run went ("Watch: ./check.sh · failing (exit 3) · last run 11/11/2026, 10:20:00 AM"); null for a prompt routine. */
export function watchLine(routine: RoutineRow): string | null {
  const watch = routine.watch;
  if (!watch) return null;
  const how = watch.state === "never" ? "not run yet" : watch.state === "ok" ? "ok" : `failing (${watch.timedOut ? "timed out" : watch.exit === null ? "did not finish" : watch.exit === 0 ? "ALERT" : `exit ${watch.exit}`})`;
  return `Watch: ${watch.command} · ${how}${watch.lastRun ? ` · last run ${new Date(watch.lastRun).toLocaleString()}` : ""}`;
}

/** The buttons a routine in this state has. */
export function operationsFor(status: string): Operation[] {
  const out: Operation[] = [];
  if (status === "pending" || status === "enabled" || status === "due") out.push("pause");
  if (status === "paused") out.push("resume");
  if (status !== "fired" && status !== "cancelled" && status !== "delivery_uncertain") out.push("cancel");
  return out;
}
export const LABEL: Record<Operation, string> = { pause: "Pause", resume: "Resume", cancel: "Cancel" };
