// How a developer build (`<install-build>`) is installed, shared by main (main/hot-install.ts decides and
// applies) and the core (core/self-update.ts shows the card and reports). docs/core-hot-swap.md, "Installing a build".
//
// "hot": the kernel (main process, preloads, Electron, the app's other files) is the same as the running
// one; only these parts changed and are applied in place, in this order. "restart": as before, the app
// quits and the install script opens the new build.

/** The parts that can change without an app restart, in the order they are applied. */
export const HOT_PARTS = ["core", "chat", "shell"] as const;
export type HotPart = typeof HOT_PARTS[number];
export const PART_NAMES: Record<HotPart, string> = { core: "core", chat: "chat page", shell: "shell" };

export type InstallPlan = { mode: "hot"; parts: HotPart[] } | { mode: "restart"; reasons: string[] };

/** "hot-apply: core, chat page" / "restart (kernel changed: main process, Electron)". */
export function planText(plan: InstallPlan): string {
  if (plan.mode === "hot") return plan.parts.length ? `hot-apply: ${plan.parts.map((part) => PART_NAMES[part]).join(", ")}` : "hot-apply: nothing besides the version differs";
  return plan.reasons.length ? `restart (${plan.reasons.join("; ")})` : "restart";
}

/** What main says when a hot install is over (to whichever core runs then). */
export interface HotReport {
  ok: boolean;
  /** Parts now running from the new build. */
  applied: HotPart[];
  /** Why it failed (ok: false). */
  error?: string;
  /** The app on disk: the new build ("installed"), the previous one again ("restored"), or the new one although the running build is the old one ("stuck"). */
  disk: "installed" | "restored" | "untouched" | "stuck";
  /** Echoed from the request: who asked, their note, and both builds' labels. */
  requester: string;
  note: string;
  from: string;
  to: string;
}

const PART_SET = new Set<string>(HOT_PARTS);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/** A plan from the other process (null: not one). */
export function parsePlan(raw: unknown): InstallPlan | null {
  const value = raw as { mode?: unknown; parts?: unknown; reasons?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  if (value.mode === "hot" && Array.isArray(value.parts) && value.parts.every((part) => PART_SET.has(part as string))) {
    return { mode: "hot", parts: HOT_PARTS.filter((part) => (value.parts as string[]).includes(part)) };
  }
  if (value.mode === "restart" && Array.isArray(value.reasons)) return { mode: "restart", reasons: value.reasons.slice(0, 20).map((reason) => text(reason, 300)).filter(Boolean) };
  return null;
}

export function parseReport(raw: unknown): HotReport | null {
  const value = raw as Partial<Record<keyof HotReport, unknown>> | null;
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean" || !Array.isArray(value.applied)) return null;
  if (!["installed", "restored", "untouched", "stuck"].includes(value.disk as string) || typeof value.requester !== "string") return null;
  return {
    ok: value.ok, applied: HOT_PARTS.filter((part) => (value.applied as unknown[]).includes(part)),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 1_000) } : {}),
    disk: value.disk as HotReport["disk"], requester: value.requester.slice(0, 200), note: text(value.note, 2_000), from: text(value.from, 200), to: text(value.to, 200),
  };
}
