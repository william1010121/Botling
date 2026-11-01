// A head turn's end and whether it shows, through the shared worker core (shared-core spec 2.7, 2.8). The head
// shares two things with the workers and nothing else: classifyRun (requireReply false: silence is allowed) and the
// rule that a finished turn with nothing visible gets no bubble, whatever started it.
import type { StreamItem } from "./agent/stream";
import type { Engine } from "./heads";
import { saysNoReply, type Parsed } from "./reply";
import { classifyRun, type RunEnd, type TurnContent } from "./worker-core";

type ResultItem = Extract<StreamItem, { kind: "result" }>;

/** The engine's end of a head turn. Engines that do not say `how` yet (Codex, Antigravity until S2/S3) say it with `ok`. */
export function headRunEnd(item: ResultItem): RunEnd {
  return { how: item.how ?? (item.ok ? "normal" : "error"), finalText: item.text || null, error: item.error || null, detail: item.subtype };
}

/**
 * How a head turn ended. `reply`: the turn's reply, the result's words in it. A head turn is done or failed, so a stop
 * the engine reports is failed. Only engines that count failed tools themselves (`failedTools`, Antigravity) fail a
 * silent turn for one: Claude's and Codex's turns that end normally stay done, as before.
 */
export function headTurnEnd(item: ResultItem, reply: string, engine: Engine): { status: "done" | "failed"; error?: string } {
  const verdict = classifyRun({ end: headRunEnd(item), reply, stoppedByApp: false, interruptedBy: null, requireReply: false, failedTools: item.failedTools ?? 0, engine });
  if (verdict.status === "done") return { status: "done" };
  // The engine's own words when it failed the turn itself; classifyRun's when it called it ok.
  return { status: "failed", error: item.ok ? verdict.report : item.error };
}

export interface HeadTurnFacts {
  status: TurnContent["status"];
  origin: "user" | "app" | "background";
  /** Two heads share the chat. */
  sharesChat: boolean;
  /** The reply as the head wrote it. */
  raw: string;
  parsed: Parsed;
  /** The reply's body without the hand-off tag (parseHeadTags). */
  body: string;
  handoff: boolean;
  steps: number;
  error: string | null;
}

/** What a finished head turn has to show, for hasVisibleContent. */
export function headTurnContent(f: HeadTurnFacts): TurnContent {
  const { parsed } = f;
  const nothing = !parsed.body && !parsed.choices?.length && !parsed.displays.length && !parsed.requests.length;
  const reacts = parsed.reactions.length > 0 || !!parsed.whiteboard;
  // What the head keeps out of the chat, its steps too: a reply that only reacts; a turn claude started itself that
  // says <no-reply/> or nothing; <no-reply/> to the app's note or, with two heads, to your message.
  const keptOut = f.status === "done" && !f.handoff && (
    (nothing && reacts)
    || (f.origin === "background" && (saysNoReply(f.raw) || nothing))
    || ((f.origin === "app" || f.sharesChat) && nothing && saysNoReply(f.raw)));
  return {
    status: f.status, handoff: f.handoff, error: f.error, reactionsOnly: nothing && reacts,
    body: keptOut ? "" : f.body,
    cards: 0, // drawn from the body
    choices: keptOut ? 0 : parsed.choices?.length ?? 0,
    displays: keptOut ? 0 : parsed.displays.length,
    requests: keptOut ? 0 : parsed.requests.length,
    steps: keptOut ? 0 : f.steps,
    // Background work alone makes no bubble: a turn with nothing else to show leaves it in the head's latest reply.
    backgroundTasks: 0,
    decisionReference: !keptOut && !!parsed.decisionReference,
  };
}
