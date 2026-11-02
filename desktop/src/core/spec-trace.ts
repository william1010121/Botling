// Spec traces: with BOTLING_SPEC_TRACE set to a folder, each modelled state change is appended as one
// JSON line to <folder>/<model>.jsonl, so spec/tests can replay it through spec/reference and check it.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Records one transition of a modelled protocol (`model` names spec/models/<model>): no-op unless traced. */
export function specTrace(model: string, action: string, state: Record<string, unknown>): void {
  const dir = process.env.BOTLING_SPEC_TRACE;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${model}.jsonl`), JSON.stringify({ at: Date.now(), action, state }) + "\n");
  } catch {
    // A trace that cannot be written must never break the app.
  }
}
