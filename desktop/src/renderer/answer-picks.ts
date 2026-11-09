// A question group's answers as the chat page sent them (an `answer` action's `picks`), checked for `chat.answer`.

/** One question's answer: the options ticked, typed "Other" words, a note per ticked option (keyed by index), a skip. */
export interface ActionPick { options: number[]; other?: string; skipped?: boolean; notes?: Record<string, string> }

/** The picks of an `answer` action, cleaned; null when it has none. */
export function actionPicks(value: unknown): ActionPick[] | null {
  if (!Array.isArray(value)) return null;
  return (value as unknown[]).slice(0, 5).map((entry) => {
    const pick = entry as { options?: unknown; other?: unknown; skipped?: unknown; notes?: unknown };
    const options = Array.isArray(pick?.options) ? pick.options.filter((option): option is number => Number.isInteger(option) && (option as number) >= 0 && (option as number) <= 5).slice(0, 6) : [];
    const notes = pickNotes(pick?.notes, options);
    return {
      options,
      ...(typeof pick?.other === "string" && pick.other.trim() ? { other: pick.other.slice(0, 1_000) } : {}),
      ...(pick?.skipped === true ? { skipped: true } : {}),
      ...(notes ? { notes } : {}),
    };
  });
}

/** The notes written on ticked options, trimmed and capped; undefined when there are none. */
export function pickNotes(value: unknown, options: readonly number[]): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const notes: Record<string, string> = {};
  for (const index of options) {
    const note = (value as Record<string, unknown>)[String(index)];
    if (typeof note === "string" && note.trim()) notes[String(index)] = note.trim().slice(0, 1_000);
  }
  return Object.keys(notes).length ? notes : undefined;
}
