// Several questions a bot asked in one reply (`<choices question="…">` blocks), drawn as one card group
// with one Submit. Each question keeps "Other" and "Skip"; a multi-select one uses checkboxes. The answers
// go back as one `answer` action with `picks` (one per question, in order); the app writes the bot's message.
// Answered: read only, each pick marked (the chat folds it to one line first, messages.ts).
import { t } from "./i18n";
import { isSendEnter } from "./ime";
import type { QuestionPickView, QuestionView } from "./types";

/** One question's answer as sent: options ticked, their own words, a note per ticked option, or a skip. */
export interface GroupPick { options: number[]; other?: string; skipped?: boolean; notes?: Record<string, string> }

/** What one answer says ("Postgres", "Login; Export; Other: SSO", "Skipped"). */
export function pickText(question: QuestionView, pick: QuestionPickView | GroupPick | undefined): string {
  if (!pick || pick.skipped) return t("questions.skipped");
  const parts = pick.options.flatMap((index) => {
    const label = question.options[index]?.label;
    if (!label) return [];
    const note = pick.notes?.[String(index)];
    return [note ? `${label} (${t("questions.note")}: ${note})` : label];
  });
  if (pick.other) parts.push(parts.length || question.multiple ? `${t("questions.otherLabel")}: ${pick.other}` : pick.other);
  return parts.join("; ") || t("questions.skipped");
}

/** The answers in one line, for the folded card: "Postgres · Login; Export · Skipped". */
export function groupSummary(questions: QuestionView[], picks: QuestionPickView[]): string {
  return questions.map((question, index) => pickText(question, picks[index])).join(" · ");
}

interface Draft { options: Set<number>; other: string; skipped: boolean }

const answered = (draft: Draft) => draft.skipped || draft.options.size > 0 || draft.other.trim() !== "";

/**
 * The group's card. `onSubmit` null: read only (answered, or not this user's to answer); `picks` mark what was given.
 */
export function questionGroupElement(questions: QuestionView[], picks: QuestionPickView[] | null, onSubmit: ((picks: GroupPick[]) => void) | null): HTMLElement {
  const root = document.createElement("div");
  root.className = "choices question-group";
  const readOnly = !onSubmit;
  const drafts: Draft[] = questions.map((_, index) => {
    const pick = picks?.[index];
    return { options: new Set(pick?.options ?? []), other: pick?.other ?? "", skipped: !!pick?.skipped };
  });
  const redraws: (() => void)[] = [];
  let submit: HTMLButtonElement | null = null;
  let progress: HTMLElement | null = null;
  let sent = false;

  const refresh = () => {
    redraws.forEach((redraw) => redraw());
    if (!submit || !progress) return;
    const done = drafts.filter(answered).length;
    progress.textContent = t("questions.progress", { done: String(done), total: String(questions.length) });
    submit.disabled = sent || done < questions.length;
  };

  questions.forEach((question, at) => {
    const draft = drafts[at]!;
    const section = document.createElement("fieldset");
    section.className = "question" + (question.multiple ? " multiple" : "");
    const legend = document.createElement("legend");
    legend.className = "question-title";
    const number = document.createElement("span");
    number.className = "question-number";
    number.textContent = questions.length > 1 ? `${at + 1}/${questions.length}` : "";
    const words = document.createElement("span");
    words.className = "question-words";
    words.textContent = question.question;
    const kind = document.createElement("span");
    kind.className = "question-kind";
    kind.textContent = question.multiple ? t("questions.pickAny") : t("questions.pickOne");
    legend.append(...(number.textContent ? [number] : []), words, kind);
    section.append(legend);

    const buttons = question.options.map((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice question-option" + (option.recommended && !readOnly ? " recommended" : "");
      button.setAttribute("role", question.multiple ? "checkbox" : "radio");
      const mark = document.createElement("span");
      mark.className = "question-mark";
      mark.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "question-label";
      label.textContent = option.label;
      const side = document.createElement("span");
      side.className = "detail";
      side.textContent = option.recommended && !readOnly ? (option.detail ? `${t("choices.recommended")} · ${option.detail}` : t("choices.recommended")) : (option.detail ?? "");
      button.append(mark, label, side);
      if (readOnly) button.disabled = true;
      else button.addEventListener("click", () => {
        if (sent) return;
        draft.skipped = false;
        if (question.multiple) {
          if (draft.options.has(index)) draft.options.delete(index); else draft.options.add(index);
        } else {
          draft.options = new Set([index]);
          draft.other = "";
          input.value = "";
        }
        refresh();
      });
      return button;
    });
    section.append(...buttons);

    const other = document.createElement("div");
    other.className = "question-other";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("questions.other");
    input.setAttribute("aria-label", t("questions.other"));
    input.value = draft.other;
    input.maxLength = 1_000;
    input.disabled = readOnly;
    input.addEventListener("input", () => {
      draft.other = input.value;
      if (input.value.trim()) {
        draft.skipped = false;
        if (!question.multiple) draft.options.clear();
      }
      refresh();
    });
    // Enter never sends a half-answered group; it sends when everything is answered (not while composing with an IME).
    input.addEventListener("keydown", (event) => {
      if (!isSendEnter(event)) return;
      event.preventDefault();
      if (submit && !submit.disabled) submit.click();
    });
    other.append(input);
    let skip: HTMLButtonElement | null = null;
    if (!readOnly) {
      skip = document.createElement("button");
      skip.type = "button";
      skip.className = "question-skip";
      skip.addEventListener("click", () => {
        if (sent) return;
        draft.skipped = !draft.skipped;
        if (draft.skipped) { draft.options.clear(); draft.other = ""; input.value = ""; }
        refresh();
      });
      other.append(skip);
    }
    section.append(other);
    const status = document.createElement("div");
    status.className = "question-skipped";
    status.textContent = t("questions.skipped");
    section.append(status);

    redraws.push(() => {
      buttons.forEach((button, index) => {
        const on = draft.options.has(index);
        button.setAttribute("aria-checked", String(on));
        button.classList.toggle("picked", on);
        button.classList.toggle("faded", (readOnly || draft.skipped) && !on);
      });
      other.classList.toggle("picked", draft.other.trim() !== "");
      other.classList.toggle("faded", readOnly && !draft.other.trim());
      section.classList.toggle("skipped", draft.skipped);
      status.hidden = !draft.skipped;
      if (skip) {
        skip.textContent = draft.skipped ? t("questions.unskip") : t("questions.skip");
        skip.setAttribute("aria-pressed", String(draft.skipped));
      }
      // A finished answer, read only: an "Other" left empty says nothing.
      other.hidden = readOnly && !draft.other.trim();
    });
    root.append(section);
  });

  if (onSubmit) {
    const footer = document.createElement("div");
    footer.className = "question-footer";
    progress = document.createElement("span");
    progress.className = "question-progress";
    progress.setAttribute("aria-live", "polite");
    submit = document.createElement("button");
    submit.type = "button";
    submit.className = "question-submit";
    submit.textContent = t("questions.submit");
    submit.addEventListener("click", () => {
      if (sent || drafts.some((draft) => !answered(draft))) return;
      sent = true;
      root.classList.add("sending");
      refresh();
      onSubmit(drafts.map((draft): GroupPick => draft.skipped
        ? { options: [], skipped: true }
        : { options: [...draft.options].sort((a, b) => a - b), ...(draft.other.trim() ? { other: draft.other.trim() } : {}) }));
    });
    footer.append(progress, submit);
    root.append(footer);
  }
  refresh();
  return root;
}
