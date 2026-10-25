// "Not right" on a reply (1.x's Workspace+Developer.swift `reportFeedback`, Models.swift `FeedbackNote`):
// in developer mode the report goes to the project that is Botling's own source; every report is also kept
// in <data>/feedback.md.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the report says when the user wrote nothing (`FeedbackNote.noWords`). */
export const FEEDBACK_NO_WORDS = "(they did not say)";

/** A feedback relay read back from its text, for relays saved before the note was kept (`FeedbackNote.parse`). */
export function parseFeedback(text: string): { about: string; words: string } | null {
  const head = "Feedback: the user flagged a reply of ";
  const middle = " as not right.\nWhat is wrong, in their words: ";
  const tail = "\n\nThe chat up to that reply, oldest first:";
  if (!text.startsWith(head)) return null;
  const said = text.indexOf(middle);
  if (said < 0) return null;
  const chat = text.indexOf(tail, said + middle.length);
  if (chat < 0) return null;
  const about = text.slice(head.length, said);
  const words = text.slice(said + middle.length, chat);
  return { about, words: words === FEEDBACK_NO_WORDS ? "" : words };
}

/** "2026-10-24 18:54", in the user's time zone (the feedback file's stamp). */
export function feedbackStamp(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Every feedback report, kept in `<root>/feedback.md` (`appendFeedback`). */
export function appendFeedback(report: string, root: string, date = new Date()) {
  const file = join(root, "feedback.md");
  const entry = `## ${feedbackStamp(date)}\n\n${report}\n\n`;
  if (existsSync(file)) appendFileSync(file, entry);
  else writeFileSync(file, entry);
}
