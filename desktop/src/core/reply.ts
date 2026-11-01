// A bot's reply split into what the chat shows and the tags the app acts on, ported from the
// Swift `ReplyParser` (Sources/ClaudeCodeBotCore/ReplyParser.swift). Same tags, same rules:
// - tags inside code (```fenced``` or `inline`) are examples, not requests;
// - <choices> becomes buttons (the last block wins; every block comes out of the text);
// - <no-reply/> means "nothing for the user" (only a turn claude started itself may go unshown);
// - <task …/> lines update the chat's task cards (tasks.ts);
// - <reaction …/> on a line of its own sets the bot's own reaction;
// - <show> becomes a component display (kept in 1.x's `displays` format; 2.0 does not draw them yet);
// - <whiteboard> (2.0 only) sets the bot's picture on the main bot's whiteboard, drawn nowhere in the chat;
// - the other requests (<component>, <plugin>, <install>, <new-bot>, <new-project>, …) are
//   parsed and taken out of the text, so the chat never shows raw tags; 2.0 acts on none of them yet
//   and says so (bot.ts).
// Offsets are UTF-16, as NSString's and the chat page's.
import { refreshSeconds } from "./components/library";
import { REACTION_PALETTE } from "./briefing";

export type BotRequest =
  | { kind: "component"; name: string; request: string }
  | { kind: "plugin"; request: string }
  | { kind: "folder"; path: string }
  | { kind: "install"; source: string }
  | { kind: "newBot"; name: string; job: string }
  /**
   * A sub bot (`<sub-bot name="…" subagent="agent id"/>`): with `subagent`, a running subagent moved out (`note` is any words
   * inside the tag); without it (`subagent` is ""), a new empty sub bot whose first task is `note`, on `engine` if one was named.
   */
  | { kind: "subBot"; name: string; subagent: string; note: string; engine?: string }
  | { kind: "newProject"; folder: string; task: string }
  | { kind: "installBuild"; path: string; note: string }
  | { kind: "appScreenshot" }
  | { kind: "openQuestion"; from: string }
  | { kind: "giveComponent"; bot: string; name: string }
  | { kind: "takeComponent"; bot: string; name: string }
  | { kind: "suggestComponent"; name: string; draft: string }
  | { kind: "componentDeclined"; id: string; reason: string }
  | { kind: "componentSpec"; id: string; json: string };

export interface Choice { label: string; detail?: string; recommended: boolean }
export interface Display { name: string; data: string; at?: number; command?: string; id?: string; refresh?: number; savedAt?: number; [key: string]: unknown }
export interface ReactionAction { messageId: string; emoji: string; present: boolean }
export type TaskState = "pending" | "running" | "waiting" | "done" | "stopped";
/** How far finished work has got (2.x): built, reviewed, installed, then verified. */
export type TaskStage = "built" | "reviewed" | "installed" | "verified";
export const TASK_STAGES: readonly TaskStage[] = ["built", "reviewed", "installed", "verified"];
/** `TaskTag`: undefined keeps a field, "" clears it. `stage` is 2.x only; an unknown one is left out. */
export interface TaskTag { id?: string; expectedUpdatedAt?: number; name?: string; continues?: string; now?: string; next?: string; blocked?: string; state?: TaskState; stage?: TaskStage | "" }
export interface CompletionSignal { kind: "end" | "block"; evidence: string }

/** The bot's picture on the main bot's whiteboard (`<whiteboard name="x" size="2x1">JSON</whiteboard>`, or `<whiteboard clear/>`). */
export type WhiteboardTag = { clear: true } | { name: string; data: string; command?: string; size: "1x1" | "2x1" };

export interface Parsed {
  /** The last <whiteboard> tag outside code, if any. */
  whiteboard?: WhiteboardTag;
  body: string;
  choices: Choice[] | null;
  requests: BotRequest[];
  reactions: ReactionAction[];
  displays: Display[];
  completionSignals: CompletionSignal[];
  decisionReference: string | null;
  tasks: TaskTag[];
}

const decisionReferenceTag = () => /^ {0,3}<decision-ref\s+id="([0-9A-Fa-f-]{36})"\s*\/>[ \t]*$/gm;
const quotedHTMLRegion = () => /<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;
const choicesBlock = () => /<choices>\s*([\s\S]*?)\s*<\/choices>/g;
const requestTag = () => /<(component|new-bot)\s+name\s*=\s*"([^"]+)"\s*>\s*([\s\S]*?)\s*<\/\1>/g;
const subBotTag = () => /<sub-bot((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*(?:\/>|>\s*([\s\S]*?)\s*<\/sub-bot>)/g;
const pluginTag = () => /<plugin>\s*([\s\S]*?)\s*<\/plugin>/g;
const folderTag = () => /<need-folder>\s*([\s\S]*?)\s*<\/need-folder>/g;
const installTag = () => /<install>\s*([\s\S]*?)\s*<\/install>/g;
const buildTag = () => /<install-build\s+path\s*=\s*"([^"]+)"\s*(?:\/>|>\s*([\s\S]*?)\s*<\/install-build>)/g;
const listTag = () => /<(give|take)-component\s+bot\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>\s*([\s\S]*?)\s*<\/\1-component>/g;
const suggestTag = () => /<suggest-component\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:\/>|>\s*([\s\S]*?)\s*<\/suggest-component>)/g;
const specTag = () => /<component-spec\s+id\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>\s*([\s\S]*?)\s*<\/component-spec>/g;
const declinedTag = () => /<component-declined\s+id\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:\/>|>\s*([\s\S]*?)\s*<\/component-declined>)/g;
const screenshotTag = () => /<app-screenshot\s*\/?>(?:\s*<\/app-screenshot>)?/g;
const taskTag = () => /<task((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*\/?>(?:[ \t]*<\/task>)?/g;
const noReplyTag = () => /<no-reply\s*\/>|<no-reply>\s*<\/no-reply>/g;
const openQuestionTag = () => /<open-question\s+from\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:\/>|>\s*<\/open-question>)/g;
const projectTag = () => /<new-project\s+folder\s*=\s*"([^"]+)"\s*(?:\/>|>\s*([\s\S]*?)\s*<\/new-project>)/g;
const showTag = () => /<show((?:\s+[A-Za-z-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*(?:\/>|>\s*([\s\S]*?)\s*<\/show>)/g;
const whiteboardTag = () => /<whiteboard((?:\s+[A-Za-z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(?:\/>|>\s*([\s\S]*?)\s*<\/whiteboard>)/g;
const attributeTag = () => /([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const codeRegion = () => /(`{3,}|~{3,})[\s\S]*?(?:\1|$(?![\s\S]))|`[^`\n]+`/g;
const reactionTag = () => /^ {0,3}<reaction message="([0-9A-Fa-f-]{36})" emoji="([^"]+)" present="(true|false)"\/>[ \t]*$/gm;
const terminalTag = () => /<(end|block)>([\s\S]*?)<\/\1>/g;

const MARKER = "";
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const trimWS = (s: string) => s.replace(/^[ \t  -​　]+|[ \t  -​　]+$/g, "");
const trimAll = (s: string) => s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");

/** A tag's attributes, names lowercased, with &quot; &#39; &lt; &gt; &amp; read back. */
export function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(attributeTag())) {
    const value = (match[2] ?? match[3] ?? "")
      .replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    found[match[1]!.toLowerCase()] = value;
  }
  return found;
}

/** The text with every code character replaced by a space (same length). */
export function masked(text: string): string {
  return text.replace(codeRegion(), (match) => " ".repeat(match.length));
}

interface Hit { index: number; length: number; spans: ([number, number] | undefined)[] }

/** Matches of a pattern in `mask`, with where each group is (positions valid in the text too: same length). */
function hits(pattern: RegExp, mask: string): Hit[] {
  const withIndices = new RegExp(pattern.source, pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`);
  return [...mask.matchAll(withIndices)].map((match) => ({
    index: match.index!, length: match[0].length,
    spans: (match.indices ?? []).slice(1).map((span) => (span ? [span[0], span[1]] as [number, number] : undefined)),
  }));
}

/** Group `i` of a hit, read from `text` (an optional group that took no part reads as ""). */
const group = (text: string, hit: Hit, i: number) => { const span = hit.spans[i]; return span ? text.slice(span[0], span[1]) : ""; };

/** `ReplyParser.saysNoReply`: the reply carries <no-reply/> outside code. */
export function saysNoReply(reply: string): boolean {
  return noReplyTag().test(masked(reply));
}

/** `TaskTag(attributes:)`. */
function taskTagFrom(found: Record<string, string>): TaskTag {
  const value = (key: string) => (found[key] === undefined ? undefined : trimAll(found[key]!));
  const tag: TaskTag = {};
  const id = value("id");
  if (id !== undefined) tag.id = id;
  const expected = value("expected-updated-at");
  // Swift-date seconds from the saved snapshot. Keep invalid supplied tokens as NaN so
  // the book rejects them instead of silently dropping the compare-and-swap condition.
  if (expected !== undefined) tag.expectedUpdatedAt = expected ? Number(expected) : NaN;
  const name = value("name");
  if (name) tag.name = name;
  const continues = value("continues");
  if (continues) tag.continues = continues;
  for (const key of ["now", "next", "blocked"] as const) {
    const v = value(key);
    if (v !== undefined) tag[key] = v;
  }
  const state = value("state")?.toLowerCase();
  if (state === "running" || state === "waiting" || state === "done" || state === "stopped") tag.state = state;
  const stage = value("stage")?.toLowerCase();
  if (stage === "" || TASK_STAGES.includes(stage as TaskStage)) tag.stage = stage as TaskStage | "";
  return tag;
}

function choiceFrom(line: string): Choice | null {
  let text = trimWS(line);
  let recommended = false;
  if (text.startsWith("*") || text.startsWith("★")) {
    recommended = true;
    text = text.slice(1);
  } else if (text.startsWith("-") || text.startsWith("•")) {
    text = text.slice(1);
  }
  const bar = text.indexOf("|");
  const parts = (bar >= 0 ? [text.slice(0, bar), text.slice(bar + 1)] : [text]).map(trimWS);
  const label = parts[0];
  if (!label) return null;
  const choice: Choice = { label, recommended };
  if (parts.length > 1 && parts[1]) choice.detail = parts[1];
  return choice;
}

/** `ReplyParser.parseAll`. */
export function parseReply(reply: string): Parsed {
  let text = reply;
  let mask = masked(reply);
  const replace = (index: number, length: number, inText: string, inMask = inText) => {
    text = text.slice(0, index) + inText + text.slice(index + length);
    mask = mask.slice(0, index) + inMask + mask.slice(index + length);
  };
  const requests: BotRequest[] = [];
  /** Matches outside code, last first; each is taken out of the reply. */
  const take = (pattern: () => RegExp, found: (groups: string[]) => void, firstOnly = false) => {
    let matches = hits(pattern(), mask);
    if (firstOnly) matches = matches.slice(0, 1);
    for (const hit of matches.reverse()) {
      found(hit.spans.map((_, i) => group(text, hit, i)));
      replace(hit.index, hit.length, "");
    }
  };

  // Every <show> with good JSON is kept, its place marked until the rest is taken out.
  const displays: Display[] = [];
  for (const hit of hits(showTag(), mask).reverse()) {
    const found = attributes(group(text, hit, 0));
    const body = group(text, hit, 1);
    const name = found.name ?? "";
    const command = found.command?.trim() || undefined;
    const data = body ? body : "null";
    let marker = "";
    let good = !body;
    if (!good) { try { JSON.parse(data); good = true; } catch { good = false; } }
    if (name && good) {
      const display: Display = { name, data };
      if (command) display.command = command;
      const id = found.id?.trim();
      if (id) display.id = id;
      // refresh="2s" reruns its command while the card is on screen (`ComponentRefresh.seconds`).
      const refresh = found.refresh !== undefined ? refreshSeconds(found.refresh) : null;
      if (refresh !== null) display.refresh = refresh;
      displays.unshift(display);
      marker = MARKER;
    }
    replace(hit.index, hit.length, marker);
  }

  // <whiteboard>: the last good one counts; every one leaves the text.
  let whiteboard: WhiteboardTag | undefined;
  for (const hit of hits(whiteboardTag(), mask).reverse()) {
    const attrs = group(text, hit, 0);
    const body = group(text, hit, 1);
    replace(hit.index, hit.length, "");
    if (whiteboard) continue;
    const found = attributes(attrs);
    if (/(?:^|\s)clear(?:\s|$|=)/i.test(attrs) && !found.name) { whiteboard = { clear: true }; continue; }
    const name = trimAll(found.name ?? "");
    const data = body ? body : "null";
    if (!name) continue;
    if (body) { try { JSON.parse(body); } catch { continue; } }
    const command = found.command?.trim();
    whiteboard = { name, data, ...(command ? { command } : {}), size: found.size?.trim() === "2x1" ? "2x1" : "1x1" };
  }

  const reactions: ReactionAction[] = [];
  const quoted = hits(quotedHTMLRegion(), mask);
  const overlapsQuoted = (hit: Hit) => quoted.some((q) => q.index < hit.index + hit.length && hit.index < q.index + q.length);
  for (const hit of hits(reactionTag(), mask).reverse()) {
    if (overlapsQuoted(hit)) continue;
    const [id, emoji, present] = [group(text, hit, 0), group(text, hit, 1), group(text, hit, 2)];
    if (!UUID_RE.test(id) || !REACTION_PALETTE.includes(emoji)) continue;
    reactions.unshift({ messageId: id.toUpperCase(), emoji, present: present === "true" });
    replace(hit.index, hit.length, "");
  }

  const tagged: BotRequest[] = [];
  take(requestTag, ([kind, name, content]) => {
    const n = trimWS(name!);
    tagged.unshift(kind === "new-bot" ? { kind: "newBot", name: n, job: content! } : { kind: "component", name: n, request: content! });
  });
  requests.push(...tagged);
  const subBots: BotRequest[] = [];
  take(subBotTag, ([attrs, note]) => {
    const found = attributes(attrs!);
    // A name is needed, and either a subagent to move or a task (the words inside the tag) for a new sub bot; neither is never guessed.
    const name = trimWS(found.name ?? ""), subagent = trimWS(found.subagent ?? ""), engine = trimWS(found.engine ?? "").toLowerCase();
    if (name && (subagent || trimWS(note ?? ""))) subBots.unshift({ kind: "subBot", name, subagent, note: note ?? "", ...(!subagent && engine ? { engine } : {}) });
  });
  requests.push(...subBots);
  take(pluginTag, ([request]) => requests.push({ kind: "plugin", request: request! }));
  take(installTag, ([source]) => requests.push({ kind: "install", source: source! }));
  const projects: BotRequest[] = [];
  take(projectTag, ([folder, task]) => projects.unshift({ kind: "newProject", folder: trimWS(folder!), task: task! }));
  requests.push(...projects);
  take(buildTag, ([path, note]) => requests.push({ kind: "installBuild", path: trimWS(path!), note: note! }), true);
  take(noReplyTag, () => {});
  const tasks: TaskTag[] = [];
  take(taskTag, ([attrs]) => tasks.unshift(taskTagFrom(attributes(attrs!))));
  let screenshot = false;
  take(screenshotTag, () => { screenshot = true; });
  if (screenshot) requests.push({ kind: "appScreenshot" });
  take(folderTag, ([path]) => requests.push({ kind: "folder", path: path! }));
  const openQuestions: BotRequest[] = [];
  take(openQuestionTag, ([a, b]) => { const from = trimWS(a || b!); if (from) openQuestions.unshift({ kind: "openQuestion", from }); });
  requests.push(...openQuestions);
  const lists: BotRequest[] = [];
  take(listTag, ([kind, a, b, rawName]) => {
    const bot = trimWS(a || b!);
    const name = trimAll(rawName!);
    if (!bot || !name) return;
    lists.unshift(kind === "give" ? { kind: "giveComponent", bot, name } : { kind: "takeComponent", bot, name });
  });
  requests.push(...lists);
  const suggestions: BotRequest[] = [];
  take(suggestTag, ([a, b, draft]) => { const name = trimWS(a || b!); if (name) suggestions.unshift({ kind: "suggestComponent", name, draft: draft! }); });
  requests.push(...suggestions);
  const specs: BotRequest[] = [];
  take(specTag, ([a, b, json]) => { const id = trimWS(a || b!); if (id) specs.unshift({ kind: "componentSpec", id, json: json! }); });
  requests.push(...specs);
  const declined: BotRequest[] = [];
  take(declinedTag, ([a, b, reason]) => { const id = trimWS(a || b!); if (id) declined.unshift({ kind: "componentDeclined", id, reason: reason! }); });
  requests.push(...declined);

  // Decision references outside quoted HTML; one alone is the reference.
  let referenceMask = mask;
  for (const q of hits(quotedHTMLRegion(), mask).reverse()) referenceMask = referenceMask.slice(0, q.index) + " ".repeat(q.length) + referenceMask.slice(q.index + q.length);
  const references = hits(decisionReferenceTag(), referenceMask);
  let decisionReference: string | null = null;
  if (references.length === 1 && UUID_RE.test(group(text, references[0]!, 0))) decisionReference = group(text, references[0]!, 0).toUpperCase();
  for (const hit of references.reverse()) replace(hit.index, hit.length, "");

  // Several blocks: the last one (taken first, from the end) is the question.
  let choices: Choice[] | null = null;
  take(choicesBlock, ([inner]) => {
    if (choices) return;
    const parsed = inner!.split("\n").map(choiceFrom).filter((choice): choice is Choice => !!choice);
    choices = parsed.length ? parsed : null;
  });

  const completionSignals: CompletionSignal[] = [];
  for (const hit of hits(terminalTag(), mask).reverse()) {
    const evidence = trimAll(group(text, hit, 1));
    completionSignals.unshift({ kind: group(text, hit, 0) === "end" ? "end" : "block", evidence });
    replace(hit.index, hit.length, evidence, masked(evidence));
  }

  const { body, places } = placing(text, displays.length);
  displays.forEach((display, i) => { if (places[i] != null) display.at = places[i]!; });
  return { body, choices, requests, reactions, displays, completionSignals, decisionReference, tasks, ...(whiteboard ? { whiteboard } : {}) };
}

/** The text without its markers, trimmed, and where each marker was (UTF-16 offsets). */
function placing(text: string, count: number): { body: string; places: (number | null)[] } {
  let untrimmed = "";
  const places: number[] = [];
  for (const unit of text) {
    if (unit === MARKER) places.push(untrimmed.length);
    else untrimmed += unit;
  }
  const body = trimAll(untrimmed);
  const lead = untrimmed.length - untrimmed.replace(/^[\s\u0085]+/, "").length;
  const found = places.map((place) => Math.min(Math.max(place - lead, 0), body.length));
  return { body, places: found.length === count ? found : Array<null>(count).fill(null) };
}

/** `Bot.saysNothing`: only <no-reply/> and tags that draw nothing; no words, buttons, displays or requests. */
export function saysNothing(reply: string): boolean {
  const parsed = parseReply(reply);
  return !trimAll(parsed.body) && !parsed.choices?.length && !parsed.displays.length && !parsed.requests.length;
}

/** What the chat says about a request 2.0 cannot act on yet. */
export function unsupportedRequest(request: BotRequest): string {
  switch (request.kind) {
    case "component": return `a component change ("${request.name}")`;
    case "plugin": return "a change to Botling (a plugin)";
    case "folder": return "access to another folder";
    case "install": return "installing a plugin";
    case "newBot": return `a new bot ("${request.name}")`;
    case "subBot": return `a sub bot ("${request.name}"): this bot cannot make one here, so nothing was moved`;
    case "newProject": return `a new project (${request.folder})`;
    case "installBuild": return "installing a build";
    case "appScreenshot": return "a screenshot of the app";
    case "openQuestion": return `showing ${request.from}'s open question`;
    case "giveComponent": case "takeComponent": return `changing ${request.bot}'s components`;
    case "suggestComponent": return `making a component ("${request.name}")`;
    case "componentDeclined": case "componentSpec": return "a component spec update";
  }
}
