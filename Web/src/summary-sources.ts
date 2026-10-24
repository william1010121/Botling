import type { CatchUpView, MessageView } from "./types";
export interface SourceReference { messageID: string; quote?: string; part?: "answer"; }
/** `tasks`: the ids of the task cards it is about ([[task:ID]]), when it names any. */
export interface CitedBullet { text: string; sources: SourceReference[]; tasks?: string[]; }

/** A quote cannot splice two options or the prompt and the answer. */
export function sourceTexts(message: MessageView): string[] {
  const texts = [message.text, message.answer ?? ""];
  for (const choice of message.choices ?? []) texts.push(choice.label, choice.detail ?? "");
  for (const display of message.displays ?? (message.display ? [message.display] : [])) {
    // Persisted data only. Never create a component or run its command/template.
    try {
      const collect = (value: unknown): void => {
        if (typeof value === "string") texts.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(JSON.parse(display.data));
    } catch { texts.push(display.data); }
  }
  return texts.filter(Boolean);
}

/** Actual IDs in this exact range, in transcript chronology. */
export function summaryMessages(view: CatchUpView, messages: MessageView[]): MessageView[] {
  const allowed = new Set(view.ids.map(id => id.toLowerCase())), seen = new Set<string>();
  return messages.filter(message => {
    const id = message.id.toLowerCase();
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
}

/** Model output supplies references, never authors, times or unverified quotation text. */
export function citedBullet(bullet: string, source: MessageView[]): CitedBullet {
  const byID = new Map(source.map(message => [message.id.toLowerCase(), message]));
  const sources: SourceReference[] = [], seen = new Set<string>();
  const text = bullet.replace(/\[\[source:([^\]|]+)(?:\|((?:(?!\]\])[\s\S])*))?\]\]/gi, (_marker, id: string, quote?: string) => {
    const answer = id.toLowerCase().endsWith("/answer");
    const message = byID.get((answer ? id.slice(0, -7) : id).toLowerCase());
    if (!message) return "";
    const selected = message.chosen != null ? message.choices?.[message.chosen] : undefined;
    const answerTexts = [message.answer ?? "", selected?.label ?? "", selected?.detail ?? ""].filter(Boolean);
    if (answer && !answerTexts.length) return "";
    const exact = quote && (answer ? answerTexts : sourceTexts(message)).some(text => text.includes(quote)) ? quote : undefined;
    const key = JSON.stringify([message.id, answer, exact]);
    if (!seen.has(key)) { sources.push({ messageID: message.id, ...(exact ? { quote: exact } : {}), ...(answer ? {part: "answer" as const} : {}) }); seen.add(key); }
    return "";
  });
  // Task markers name a card of the range; the page draws its chip, never the id.
  const tasks: string[] = [];
  const unmarked = text.replace(/\[\[task:([0-9A-Fa-f-]{36})\]\]/g, (_marker, id: string) => {
    if (!tasks.includes(id.toUpperCase())) tasks.push(id.toUpperCase());
    return "";
  });
  const bare = (tasks.length ? unmarked.replace(/[ \t]{2,}/g, " ") : unmarked).trim();
  return { text: bare, sources, ...(tasks.length ? { tasks } : {}) };
}

export function summaryReferences(view: CatchUpView, messages: MessageView[]): CitedBullet[] {
  const source = summaryMessages(view, messages);
  return view.bullets.map(bullet => citedBullet(bullet, source));
}
