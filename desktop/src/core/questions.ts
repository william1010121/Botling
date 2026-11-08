// Several questions in one reply, answered together (2.x). A bot writes one <choices> block per question,
// each with its question (`<choices question="Which database?">`), and `multiple="true"` lets the user tick
// several. A reply whose blocks carry neither attribute keeps the 1.x rule: the last block is the question.
// The group is one decision: one card, one Submit, one answer message, one decision id.

/** One option of a question (the same shape `<choices>` always had). */
export interface QuestionOption { label: string; detail?: string; recommended: boolean }

/** One question of a group. `question` may be "" (a block with only `multiple`). */
export interface Question { question: string; multiple: boolean; options: QuestionOption[] }

/** What the user gave one question: the options ticked (indices, ascending), typed "Other" words, or a skip. */
export interface QuestionPick { options: number[]; other?: string; skipped?: boolean }

export const MAX_QUESTIONS = 5;
export const MAX_QUESTION_OPTIONS = 6;
export const MIN_QUESTION_OPTIONS = 2;
export const SKIPPED = "(Skipped)";

/** A block's attributes as written: a group block names its question or says multiple. */
export function isGroupBlock(attributes: Record<string, string>, raw: string): boolean {
  return attributes.question !== undefined || attributes.multiple !== undefined || /(^|\s)multiple(\s|$)/i.test(raw);
}

/** `multiple="true"` (or a bare `multiple`); "false"/"no"/"0" keep it single-choice. */
export function isMultiple(attributes: Record<string, string>, raw: string): boolean {
  const value = attributes.multiple;
  if (value !== undefined) return !/^(false|no|0|single)$/i.test(value.trim());
  return /(^|\s)multiple(\s|$)/i.test(raw.replace(/([A-Za-z-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, ""));
}

/**
 * One block as a question, or null when it is malformed (fewer than 2 options). Options past 6 are left out;
 * a single-choice question keeps only its first `*` as recommended, a multi-select keeps every one (optional there).
 */
export function questionFrom(question: string, multiple: boolean, options: QuestionOption[]): Question | null {
  const kept = options.slice(0, MAX_QUESTION_OPTIONS).map((option) => ({ ...option }));
  if (kept.length < MIN_QUESTION_OPTIONS) return null;
  if (!multiple) {
    let seen = false;
    for (const option of kept) {
      if (option.recommended && seen) option.recommended = false;
      else if (option.recommended) seen = true;
    }
  }
  return { question: question.trim().slice(0, 400), multiple, options: kept };
}

/** The group's questions: the good ones in order, at most 5; null when none is good (the reply falls back to 1.x). */
export function questionGroup(blocks: { question: string; multiple: boolean; options: QuestionOption[] }[]): Question[] | null {
  const questions = blocks.map((block) => questionFrom(block.question, block.multiple, block.options))
    .filter((question): question is Question => !!question).slice(0, MAX_QUESTIONS);
  return questions.length ? questions : null;
}

/** The user's picks checked against the questions, cleaned (sorted, unique, trimmed); null when they do not fit. */
export function validPicks(questions: readonly Question[], picks: readonly QuestionPick[]): QuestionPick[] | null {
  if (!Array.isArray(picks) || picks.length !== questions.length) return null;
  const clean: QuestionPick[] = [];
  for (const [index, question] of questions.entries()) {
    const pick = picks[index];
    if (!pick || typeof pick !== "object") return null;
    if (pick.skipped === true) { clean.push({ options: [], skipped: true }); continue; }
    const given: unknown[] = Array.isArray(pick.options) ? pick.options : [];
    if (given.some((option) => typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= question.options.length)) return null;
    const options = [...new Set(given as number[])].sort((a, b) => a - b);
    const other = typeof pick.other === "string" ? pick.other.trim().slice(0, 1_000) : "";
    if (!options.length && !other) return null;
    // A single-choice question takes one option or its own words, never both.
    if (!question.multiple && (options.length > 1 || (options.length && other))) return null;
    clean.push({ options, ...(other ? { other } : {}) });
  }
  return clean;
}

/** What one question's answer says: the ticked labels, then "Other: …", or "(Skipped)". */
export function pickLabel(question: Question, pick: QuestionPick): string {
  if (pick.skipped) return SKIPPED;
  const parts = pick.options.map((index) => question.options[index]?.label ?? "").filter(Boolean);
  if (pick.other) parts.push(parts.length || question.multiple ? `Other: ${pick.other}` : pick.other);
  return parts.join("; ") || SKIPPED;
}

/**
 * The one message the bot gets for a group: each question and its answer, in order.
 *   1. Which database?
 *   → Postgres
 *   2. Which features? (several allowed)
 *   → Login; Export; Other: SSO
 */
export function answerMessage(questions: readonly Question[], picks: readonly QuestionPick[]): string {
  return questions.map((question, index) => {
    const title = question.question || `Question ${index + 1}`;
    return `${index + 1}. ${title}${question.multiple ? " (several allowed)" : ""}\n→ ${pickLabel(question, picks[index] ?? { options: [], skipped: true })}`;
  }).join("\n");
}

/** A short one-line summary of the answers ("Postgres · Login, Export · Skipped"), for a folded card or a list. */
export function answerSummary(questions: readonly Question[], picks: readonly QuestionPick[]): string {
  return questions.map((question, index) => pickLabel(question, picks[index] ?? { options: [], skipped: true })).join(" · ");
}

/** A record's saved questions read back defensively (from disk, possibly another build). */
export function savedQuestions(value: unknown): Question[] | null {
  if (!Array.isArray(value)) return null;
  const questions = value.slice(0, MAX_QUESTIONS).flatMap((entry): Question[] => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    if (!Array.isArray(raw.options)) return [];
    const options = raw.options.slice(0, MAX_QUESTION_OPTIONS).flatMap((option): QuestionOption[] => {
      const o = option as Record<string, unknown> | null;
      if (!o || typeof o.label !== "string" || !o.label) return [];
      return [{ label: o.label.slice(0, 400), ...(typeof o.detail === "string" && o.detail ? { detail: o.detail.slice(0, 400) } : {}), recommended: o.recommended === true }];
    });
    if (options.length < MIN_QUESTION_OPTIONS) return [];
    return [{ question: typeof raw.question === "string" ? raw.question.slice(0, 400) : "", multiple: raw.multiple === true, options }];
  });
  return questions.length ? questions : null;
}

/** A record's saved picks read back defensively; null unless they fit its questions. */
export function savedPicks(questions: readonly Question[] | null, value: unknown): QuestionPick[] | null {
  if (!questions || !Array.isArray(value)) return null;
  return validPicks(questions, value as QuestionPick[]);
}
