// Blank bubbles: one rule for every head turn, whatever started it (shared-core spec 2.7). A finished turn with
// nothing to show is not stored, drawn or sent as a bubble; `turn.finished` still goes out (text ""). Reactions and
// whiteboards of a reply that says nothing else still apply; they just get no bubble.

export interface TurnContent {
  status: "done" | "failed" | "stopped";
  /** The reply's body with the app's tags and <no-reply/> taken out. */
  body: string;
  /** The reply only reacts (or sets the whiteboard). */
  reactionsOnly: boolean;
  cards: number; choices: number; displays: number; steps: number; backgroundTasks: number;
  decisionReference: boolean;
  /** The reply hands work to the app (a partner hand-off). */
  handoff: boolean;
  error: string | null;
}

/** Whether a finished turn has anything to show. No visible content → no bubble, whatever started the turn. */
export function hasVisibleContent(t: TurnContent): boolean {
  if (t.status !== "done" || t.handoff) return true;
  if (t.body.trim()) return true;
  return t.cards > 0 || t.choices > 0 || t.displays > 0 || t.steps > 0 || t.backgroundTasks > 0 || t.decisionReference;
}
