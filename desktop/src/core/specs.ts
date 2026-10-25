// Component specs (1.x's ComponentSpec.swift, the pure half): a component being made from a bot's reply
// ("Make into component", or a bot's own <suggest-component>) — what it shows (its data fields), where the
// data comes from (a command run in the bot's folder), how it refreshes, which bots get it, whether a
// library component already does it — and every request Maintainer gets about it. Saved per chat in
// specs.json beside chat.json, in 1.x's format. The strings are checked character for character against
// the Swift app's (test/unit/phase5.test.ts, test/fixtures/phase5-golden.json).
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { characterCount, characterPrefix, type Clock } from "./briefing";
import { BUILT_INS, safeName, type ComponentLibrary } from "./components/library";
import { clampMinutes, DEFAULT_MINUTES, type PinRefresh } from "./components/pins";
import { parseReply, type Display } from "./reply";
import { newId, type ChatRecord } from "./store/records";

export type SpecOrigin = "user" | "maintainer" | "app";
export type SpecStatus = "draft" | "building" | "done";
export type SampleKind = "testRun" | "reply" | "page";

export interface SpecField { name: string; type: string; by: SpecOrigin }
/** A sample to preview it with; `kind` null: one of Maintainer's (1.x writes the key even then). */
export interface SpecSample { label: string; kind: SampleKind | null; data: string }
export interface SpecQuestion { id: string; key?: string; text: string; options: { label: string; value?: string }[]; suggested?: number }
export interface SpecLine { kind: "user" | "maintainer" | "event"; text: string }
export interface SpecTestRun { command: string; folder: string; output?: string; error?: string; ranAt?: number; matches?: boolean }
export interface SpecChange {
  state: "working" | "asking" | "updated" | "failed";
  version: number;
  said: string[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  waitTurn: boolean;
  request?: string;
}

/** `ComponentSpec`, as specs.json holds it (dates in Swift seconds, nil fields left out). */
export interface ComponentSpec {
  id: string;
  messageID?: string;
  page?: string;
  name: string;
  about: string;
  fields: SpecField[];
  command?: string;
  folder: string;
  refresh: PinRefresh;
  minutes: number;
  bots: string[];
  similar?: string;
  reuse: boolean;
  samples: SpecSample[];
  questions: SpecQuestion[];
  conversation: SpecLine[];
  origins: Record<string, SpecOrigin>;
  status: SpecStatus;
  draft: number;
  suggestedBy?: string;
  opened: boolean;
  asked: boolean;
  existing?: string;
  shownAs?: string;
  built?: string;
  testRun?: SpecTestRun;
  pendingEdits: string[];
  purpose?: string;
  filledBy?: string;
  filled?: string;
  fillError?: string;
  brief?: string;
  version?: number;
  change?: SpecChange;
  queued?: string[];
  createdAt: number;
  [key: string]: unknown;
}

const LABEL: Record<SampleKind, string> = { testRun: "Test run", reply: "This reply", page: "This page" };
export const sample = (kind: SampleKind, data: string): SpecSample => ({ label: LABEL[kind], kind, data });

/** A new spec (`ComponentSpec.init`). */
export function newSpec(o: { messageID?: string; name: string; folder: string; bots: string[]; createdAt: number }): ComponentSpec {
  return {
    id: newId(), ...(o.messageID ? { messageID: o.messageID } : {}), name: o.name, about: "", fields: [], folder: o.folder, refresh: "manual",
    minutes: DEFAULT_MINUTES, bots: o.bots, reuse: false, samples: [], questions: [], conversation: [], origins: {}, status: "draft", draft: 1,
    opened: false, asked: false, pendingEdits: [], createdAt: o.createdAt,
  };
}

/** Its test runs' card key (`card`), apart from chat cards and pins. */
export const specCard = (spec: ComponentSpec) => `spec/${spec.id}`;
/** The version a change now makes (`nextVersion`). */
export const nextVersion = (spec: ComponentSpec) => (spec.version ?? 1) + 1;
/** The bot that wrote the reply is drawing it now (`filling`). */
export const isFilling = (spec: ComponentSpec) => !!spec.filledBy && spec.filled === undefined && spec.fillError === undefined;

/** The sample shown until you pick one (`preferredSample`): with live data the real run; else the reply's, the page's, the first. */
export function preferredSample(samples: SpecSample[], live: boolean): number | null {
  const at = (kind: SampleKind) => { const index = samples.findIndex((entry) => entry.kind === kind); return index >= 0 ? index : null; };
  return (live ? at("testRun") : null) ?? at("reply") ?? at("page") ?? (samples.length ? 0 : null);
}

/** Two values the same, as Swift's `==` on the struct sees them. */
export function sameSpec(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** `clip`: at most `limit` characters, the last one "…". */
export const clip = (text: string, limit: number) => (characterCount(text) > limit ? `${characterPrefix(text, limit - 1)}…` : text);

/** JSON with sorted keys and slashes unescaped (`jsonString`). */
export function jsonString(object: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]])));
}

// ---------------------------------------------------------------------------------------------
// The first draft

/** A number as JSONSerialization reads it: whether the text had a fraction or an exponent. */
interface Num { n: number; float: boolean }
const isNum = (value: unknown): value is Num => !!value && typeof value === "object" && (value as { __num?: true }).__num === true;
/** JSON read keeping whether each number was written as a float (Swift's NSNumber). Null when it is not JSON. */
function readJSON(text: string): unknown {
  try {
    return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
      if (typeof value === "number") return { __num: true, n: value, float: /[.eE]/.test(context?.source ?? "") };
      return value;
    });
  } catch {
    return undefined;
  }
}

/** Keys of a JSON object in the order its text has them (`JSONKeyOrder.sorted`). */
function keyOrder(keys: string[], json: string): string[] {
  const places = new Map(keys.map((key) => { const at = json.indexOf(`"${key}"`); return [key, at < 0 ? Number.MAX_SAFE_INTEGER : at]; }));
  return [...keys].sort((a, b) => (places.get(a)! - places.get(b)!) || (a < b ? -1 : a > b ? 1 : 0));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && !isNum(value);

function typeOf(value: unknown, json: string): string {
  if (typeof value === "boolean") return "bool";
  if (isNum(value)) return value.float ? "num" : "int";
  if (typeof value === "string") return ISO_DATE.test(value) ? "time" : "text";
  if (Array.isArray(value)) {
    const first = value[0];
    return isObject(first) ? `[${keyOrder(Object.keys(first), json).join(", ")}]` : "[…]";
  }
  if (isObject(value)) return "{…}";
  return "text";
}

/** The fields of a JSON object (or of a list's first object), each with a short type (`fields(fromJSON:)`). */
export function fieldsFromJSON(json: string): SpecField[] {
  const value = readJSON(json);
  const object = isObject(value) ? value : Array.isArray(value) && isObject(value[0]) ? value[0] : null;
  if (!object) return [];
  return keyOrder(Object.keys(object), json).map((name) => ({ name, type: typeOf(object[name], json), by: "app" as const }));
}

/** A short lower-case English name: the first few ASCII words, joined with "-" (`slug`). */
export function slug(text: string, limit = 2): string {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !/^[0-9]/.test(word)).slice(0, limit).join("-");
}

/** The last shell command a reply's work ran that did not fail (`lastCommand(in:)`). */
export function lastCommand(record: ChatRecord): string | null {
  const steps = (record.steps ?? []) as { tool?: string; failed?: boolean; detail?: string }[];
  const step = steps.findLast((candidate) => candidate.tool === "Bash" && !candidate.failed && !!candidate.detail);
  return step?.detail?.trim() ?? null;
}

const shownOf = (record: ChatRecord): Display[] => ((record.displays ?? []) as Display[]);
const isBuiltIn = (name: string) => BUILT_INS.includes(name);
export const PAGE_COMPONENT = "網頁預覽卡片";

/**
 * What the app can tell from a reply alone (`draft(from:…)`): the data a component in it was drawn with
 * (its fields and a sample), the command that gave that card its data, a name and the bot's folder.
 */
export function draftSpec(record: ChatRecord, bot: string, folder: string, library: ComponentLibrary | null, createdAt: number): ComponentSpec {
  const names = new Set(library?.names ?? []);
  const shown = shownOf(record).filter((display) => !isBuiltIn(display.name));
  const existing = shown.find((display) => names.has(display.name))?.name;
  const first = shown[0];
  const command = first?.command;
  const ran = command ?? lastCommand(record) ?? undefined;
  const name = existing ?? (first ? slug(first.name) : ran ? slug(ran) : slug(record.text));
  const spec = newSpec({ messageID: record.id, name: name || "component", folder, bots: [bot], createdAt });
  if (existing) spec.existing = existing;
  if (command) spec.command = command;
  if (first && first.data !== "null") {
    spec.fields = fieldsFromJSON(first.data);
    spec.samples = [sample("reply", first.data)];
    if (names.has(first.name)) spec.shownAs = first.name;
  } else {
    spec.samples = [sample("reply", jsonString({ text: record.text.trim() }))];
  }
  return spec;
}

// ---------------------------------------------------------------------------------------------
// Changing it

const LABELS: Record<string, string> = { name: "Name", about: "About", fields: "Data fields", command: "Command", refresh: "Refresh", bots: "Bots", reuse: "Similar", similar: "Similar" };
const capitalized = (key: string) => key.replace(/(^|\s)(\S)/g, (_, space: string, c: string) => space + c.toUpperCase());

/** "total: int, failures: [suite, test]" as fields; a name alone is text (`parseFields`). */
export function parseFields(text: string): SpecField[] {
  const fields: SpecField[] = [];
  let current = "";
  let depth = 0;
  for (const character of [...text, ","]) {
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (character === "," && depth <= 0) {
      const part = current.trim();
      current = "";
      if (!part) continue;
      const colon = part.indexOf(":");
      const pieces = colon < 0 ? [part] : [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
      const name = pieces[0];
      if (!name) continue;
      fields.push({ name, type: pieces.length > 1 && pieces[1] ? pieces[1] : "text", by: "app" });
    } else {
      current += character;
    }
  }
  return fields;
}

/** Sets one value from text, as the panel's fields send it (`set(_:to:by:in:)`). Returns whether it changed. */
export function setValue(key: string, text: string, origin: SpecOrigin, spec: ComponentSpec): boolean {
  const value = text.trim();
  const before = structuredClone(spec);
  switch (key) {
    case "name": { const name = safeName(value); if (name && spec.existing === undefined) spec.name = name; break; }
    case "about": spec.about = value; break;
    case "command": if (value) spec.command = value; else delete spec.command; break;
    case "refresh": if (value === "shown" || value === "interval" || value === "manual") spec.refresh = value; break;
    case "minutes": if (/^[+-]?\d+$/.test(value)) spec.minutes = clampMinutes(Number(value)); break;
    case "bots": {
      const seen = new Set<string>();
      spec.bots = value.split(",").map((part) => part.trim()).filter((part) => part && !seen.has(part.toLowerCase()) && !!seen.add(part.toLowerCase()));
      break;
    }
    case "similar": if (value) spec.similar = value; else delete spec.similar; break;
    case "reuse": spec.reuse = ["true", "yes", "1"].includes(value.toLowerCase()); break;
    case "fields":
      spec.fields = parseFields(value).map((field) => ({ ...field, by: spec.fields.find((old) => old.name === field.name && old.type === field.type)?.by ?? origin }));
      break;
    default:
      return false;
  }
  if (sameSpec(spec, before)) return false;
  spec.origins[key === "minutes" ? "refresh" : key] = origin;
  if (key === "command") delete spec.testRun;
  return true;
}

/** The user changed a value in the panel (`edit`): theirs, said in the side conversation, kept for Maintainer. */
export function editSpecValue(key: string, value: string, spec: ComponentSpec): boolean {
  if (!setValue(key, value, "user", spec)) return false;
  const label = LABELS[key] ?? capitalized(key);
  const shown = key === "reuse" ? (spec.reuse ? `use ${spec.similar ?? "the similar one"}` : "make a new one") : value;
  spec.conversation.push({ kind: "event", text: `You edited ${label} · ${clip(shown, 60)}` });
  spec.pendingEdits = spec.pendingEdits.filter((edit) => !edit.startsWith(`${label}: `));
  spec.pendingEdits.push(`${label}: ${shown}`);
  return true;
}

/** Picks an answer to one of Maintainer's questions (`answer`): it sets the value it decides and goes to the conversation. */
export function answerQuestion(questionId: string, index: number, spec: ComponentSpec, origin: SpecOrigin = "user"): boolean {
  const at = spec.questions.findIndex((question) => question.id === questionId);
  if (at < 0) return false;
  const question = spec.questions[at]!;
  const option = question.options[index];
  if (!option) return false;
  spec.questions.splice(at, 1);
  if (question.key !== undefined && option.value !== undefined) setValue(question.key, option.value, origin, spec);
  if (origin === "user") spec.conversation.push({ kind: "user", text: option.label });
  spec.pendingEdits.push(`${question.text} → ${option.label}`);
  return true;
}

/** Open questions take their suggested answer (`answerOpenQuestions`). */
export function answerOpenQuestions(spec: ComponentSpec) {
  for (const question of [...spec.questions]) answerQuestion(question.id, question.suggested ?? 0, spec, "maintainer");
  spec.questions = [];
}

/** A value as Swift's `"\(value)"` writes it. */
function described(value: unknown): string {
  if (isNum(value)) return Number.isInteger(value.n) && !value.float ? String(value.n) : String(value.n);
  if (value === null) return "<null>";
  if (typeof value === "string") return value;
  return JSON.stringify(plain(value));
}

/** A value read with `readJSON`, numbers back as numbers. */
function plain(value: unknown): unknown {
  if (isNum(value)) return value.n;
  if (Array.isArray(value)) return value.map(plain);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  return value;
}

/** Maintainer's `<component-spec>` JSON (`update(_:with:)`): only what it names; its questions replace the old ones. */
export function updateSpec(spec: ComponentSpec, json: string): boolean {
  const object = readJSON(json);
  if (!isObject(object)) return false;
  const before = structuredClone(spec);
  for (const key of ["name", "about", "command", "refresh", "similar"]) {
    const value = object[key];
    if (typeof value === "string") setValue(key, value, "maintainer", spec);
  }
  const minutes = object.minutes;
  if (isNum(minutes) && Number.isInteger(minutes.n) && !minutes.float) setValue("minutes", String(minutes.n), "maintainer", spec);
  if (typeof object.reuse === "boolean") setValue("reuse", object.reuse ? "true" : "false", "maintainer", spec);
  if (Array.isArray(object.fields)) {
    const parsed = object.fields.flatMap((item): SpecField[] => {
      if (isObject(item) && typeof item.name === "string" && item.name) {
        return [{ name: item.name, type: typeof item.type === "string" && item.type ? item.type : "text", by: "app" }];
      }
      if (typeof item === "string") { const first = parseFields(item)[0]; return first ? [first] : []; }
      return [];
    });
    const merged = parsed.map((field) => ({ ...field, by: spec.fields.find((old) => old.name === field.name && old.type === field.type)?.by ?? "maintainer" as SpecOrigin }));
    if (!sameSpec(merged, spec.fields)) {
      spec.fields = merged;
      spec.origins.fields = "maintainer";
    }
  }
  if (Array.isArray(object.samples)) {
    for (const item of object.samples) {
      if (!isObject(item) || typeof item.label !== "string" || !item.label) continue;
      let data: string;
      if (typeof item.data === "string") data = item.data;
      else if ("data" in item) data = JSON.stringify(plain(item.data));
      else continue;
      const at = spec.samples.findIndex((entry) => entry.label === item.label);
      if (at >= 0) spec.samples[at]!.data = data;
      else spec.samples.push({ label: item.label, kind: null, data });
    }
  }
  if (Array.isArray(object.questions)) {
    spec.questions = object.questions.flatMap((item, index): SpecQuestion[] => {
      if (!isObject(item) || typeof item.text !== "string" || !item.text) return [];
      const options = (Array.isArray(item.options) ? item.options : []).flatMap((option): SpecQuestion["options"] => {
        if (typeof option === "string") return [{ label: option }];
        if (!isObject(option) || typeof option.label !== "string") return [];
        if (!("value" in option)) return [{ label: option.label }];
        const value = option.value;
        return [{ label: option.label, value: typeof value === "boolean" ? (value ? "true" : "false") : described(value) }];
      });
      if (!options.length) return [];
      const suggested = isNum(item.suggested) && Number.isInteger(item.suggested.n) && item.suggested.n >= 0 && item.suggested.n < options.length ? item.suggested.n : undefined;
      return [{ id: typeof item.id === "string" ? item.id : `q${index + 1}`, ...(typeof item.key === "string" ? { key: item.key } : {}), text: item.text, options, ...(suggested !== undefined ? { suggested } : {}) }];
    });
  }
  if (sameSpec(spec, before)) return false;
  spec.draft += 1;
  return true;
}

/** Whether a command's output has every field (`outputMatches`): an object with each, or a list whose first object has them. */
export function outputMatches(output: string, fields: SpecField[]): boolean {
  if (!fields.length) return true;
  const value = readJSON(output);
  const object = isObject(value) ? value : Array.isArray(value) && isObject(value[0]) ? value[0] : null;
  return !!object && fields.every((field) => field.name in object);
}

// ---------------------------------------------------------------------------------------------
// What Maintainer is told

export const FIELD_GROUP = { fromCommand: "From command", botOnly: "Optional (bot only)" };
export type ComponentAction = "build-first" | "shape" | "build" | "change" | "live-on-board";
export const COMPONENT_ACTIONS: ComponentAction[] = ["build-first", "shape", "build", "change", "live-on-board"];
/** The header that starts Maintainer's message (`ComponentAction.header`). */
export const actionHeader = (action: ComponentAction, subject: string) =>
  action === "live-on-board" ? `(Component ${subject}; action: ${action})` : `(Component spec ${subject}; action: ${action})`;

/** The spec as Maintainer reads it (`summary(of:)`). */
export function specSummary(spec: ComponentSpec): string {
  const lines = [`- name: ${spec.name}`];
  if (spec.about) lines.push(`- about: ${spec.about}`);
  lines.push("- data fields: " + (spec.fields.length ? spec.fields.map((field) => `${field.name}: ${field.type}`).join(", ") : "(none yet)"));
  lines.push("- command: " + (spec.command ?? "(none: a bot writes the data)"));
  lines.push(`- folder: ${spec.folder}`);
  lines.push(`- refresh: ${spec.refresh === "interval" ? `every ${spec.minutes} min` : spec.refresh}`);
  lines.push("- bots: " + spec.bots.join(", "));
  if (spec.similar !== undefined) lines.push(`- similar in the library: ${spec.similar}` + (spec.reuse ? " (the user wants to reuse it)" : ""));
  if (spec.testRun?.output !== undefined) lines.push(`- test run output: ${clip(spec.testRun.output, 600)}` + (spec.testRun.matches === false ? " (it does not have every field)" : ""));
  return lines.join("\n");
}

export const tagNote = (spec: ComponentSpec) =>
  `Answer in one or two sentences, then <component-spec id="${spec.id}">JSON</component-spec> with only what you set or change (name, about, fields [{name, type}], command, refresh: shown|interval|manual, minutes, similar, reuse, samples [{label, data}], questions [{id, key, text, options [{label, value}], suggested}]). Build nothing yet: it is a draft, built when the user presses Build it. Never run the command yourself: the user test-runs it from the panel.`;

export const REPLY_LIMIT = 12_000;
const PAGE_LIMIT = 12_000;
const PER_MESSAGE = 3;

export interface ReplyPage { path: string; text: string }

/** A path from what a bot wrote: `/abs/path`, `~/path` or a `file://` URL (`PagePreview.fileURL(from:)`). */
function filePath(text: string): string | null {
  const value = text.trim();
  if (value.toLowerCase().startsWith("file:")) { try { return resolve(fileURLToPath(value)); } catch { return null; } }
  if (value.startsWith("~/")) return resolve(process.env.HOME ?? "/", value.slice(2));
  return value.startsWith("/") ? resolve(value) : null;
}

/** A result page: an .html file in an `artifacts` folder (`PagePreview.isArtifactPage`). */
export function isArtifactPage(path: string): boolean {
  if (!/\.html?$/i.test(path)) return false;
  for (let folder = dirname(path); folder !== "/" && folder; folder = dirname(folder)) if (basename(folder) === "artifacts") return true;
  return false;
}

/** The page a preview card's data names (`PagePreview.page(inCard:)`). */
function pageInCard(data: string): string | null {
  try {
    const object = JSON.parse(data) as Record<string, unknown>;
    const given = typeof object.path === "string" ? object.path : typeof object.url === "string" ? object.url : null;
    return given ? filePath(given) : null;
  } catch {
    return null;
  }
}

/** The result pages a message links to, `[name](file://…/artifacts/x.html)`, that are there (`PagePreview.linkedCards`, as paths). */
function linkedPages(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[([^\]\n]*)\]\(<?([^)\s>]+)>?\)/g)) {
    if (out.length >= PER_MESSAGE) break;
    if (!match[2]!.toLowerCase().startsWith("file:")) continue;
    const path = filePath(match[2]!);
    if (!path || !isArtifactPage(path) || out.includes(path)) continue;
    try { if (!statSync(path).isFile()) continue; } catch { continue; }
    out.push(path);
  }
  return out;
}

/** The result pages a reply is made from, shows or links to, each as its words (`pages(of:page:)`). */
export function replyPages(record: ChatRecord, page: string | null = null): ReplyPage[] {
  const paths = [...(page ? [page] : []), ...shownOf(record).filter((display) => display.name === PAGE_COMPONENT).flatMap((display) => pageInCard(display.data) ?? []), ...linkedPages(record.text)];
  const seen = new Set<string>();
  const pages: ReplyPage[] = [];
  for (const raw of paths) {
    if (pages.length >= PER_MESSAGE) break;
    const path = resolve(raw);
    if (!isArtifactPage(path) || seen.has(path)) continue;
    seen.add(path);
    let html: string;
    try { html = readFileSync(path, "utf8"); } catch { continue; }
    const text = pageText(characterPrefix(html, 2_000_000));
    if (text) pages.push({ path, text: clip(text, PAGE_LIMIT) });
  }
  return pages;
}

/** A page's words: no scripts, styles or tags; list items as "- ", table cells split by " | " (`pageText`). */
export function pageText(html: string): string {
  let text = html.replace(/<(script|style|head|template|svg)\b.*?<\/\1\s*>|<!--.*?-->/gis, "");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<\/t[dh]\s*>/gi, " | ");
  text = text.replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/ul|\/ol|\/table|\/section|\/article|\/header|\/footer|\/summary|\/details|\/pre|\/blockquote)\b[^>]*>/gi, "\n");
  text = text.replace(/<h([1-6])\b[^>]*>/gi, "\n\n");
  text = text.replace(/<[^>]+>/gs, "");
  for (const [entity, character] of [["&nbsp;", " "], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", "\""], ["&#39;", "'"], ["&apos;", "'"], ["&amp;", "&"]] as const) text = text.replaceAll(entity, character);
  text = text.replace(/&#(x?)([0-9a-fA-F]+);/g, (whole, hex: string, digits: string) => {
    if (!hex && !/^\d+$/.test(digits)) return whole;
    const code = parseInt(digits, hex ? 16 : 10);
    try { return String.fromCodePoint(code); } catch { return whole; }
  });
  const lines = text.split("\n").map((line) => line.split(/[ \t]+/).filter(Boolean).join(" "));
  const kept: string[] = [];
  for (const line of lines) if (!(line === "" && (kept.length === 0 || kept.at(-1) === ""))) kept.push(line);
  return kept.join("\n").replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
}

/** The reply as Maintainer reads it: its words, then the words of each result page it links (`replyBlock`). */
export function replyBlock(reply: string, pages: ReplyPage[]): string {
  let text = "The reply:\n" + clip(reply, REPLY_LIMIT);
  for (const page of pages) text += `\nThe result page it links, ${page.path}, says:\n` + page.text;
  return text;
}

/** What the component is for, said first (`purposeLine`). */
export function purposeLine(spec: ComponentSpec, bot: string): string {
  const words = (spec.purpose ?? "").trim();
  if (!words) return `What it is for: ${bot}'s reply below, shown as a component instead of text (the user pressed "Make into component" and said nothing more).`;
  return `What it is for, in ${spec.suggestedBy !== undefined ? `${spec.suggestedBy}'s` : "the user's"} words: ${words}`;
}

/** Where its data comes from (`dataNote`). */
export function dataNote(spec: ComponentSpec, ran: string | null, bot: string): string {
  let text = `Its data is the reply's own content: what ${bot} wrote and organised above (and on the result page it links), in its words and language, drawn as a component instead of text or a web page.`;
  if (spec.command !== undefined) {
    text += ` The component in the reply got its data by running \`${spec.command}\` in the bot's folder, so it is live data: keep that as its Command (about.md gets the line "Command: ${spec.command}" so the app fills it by running that in the bot's folder, only once the user allows it on the card).`;
  } else {
    text += ` ${bot} draws it under the reply with that data once it is built, so about.md says exactly what JSON a bot gives it with <show name="…">JSON</show> (every field, lists of any length).`;
    text += ` Give it a Command only when the user clearly wants live data that changes (test results, git status, a queue) rather than what ${bot} wrote; a summary, table or write-up needs none, and then the command stays empty.`;
    if (ran) text += ` (${bot} ran \`${ran}\` while writing the reply: that is how it read its sources, not the component's data, unless the data is clearly live.)`;
  }
  return text;
}

/** The two groups of data fields about.md lists, and the suggested Board command (`fieldGroups(live:)`). */
export function fieldGroups(live: boolean): string {
  let text = `In about.md list the data fields in two groups: "${FIELD_GROUP.fromCommand}" (fields a CLI command can get, run in the bot's folder) and "${FIELD_GROUP.botOnly}" (what only a bot can write: explanations, advice, a next step; there only when a bot fills it). The template must draw well when every optional field is missing.`;
  if (!live) text += ` When there are From command fields, add a line "Board command: <command>" to about.md suggesting how to get them (not a "Command:" line): it is only a suggestion, used when the user pins the component to the Board, and the component is still filled by a bot in the chat with <show>.`;
  return text;
}

/** The user's own message that led to the reply (`askedBlock`). */
function askedBlock(asked: string | null): string | null {
  const words = asked?.trim();
  return words ? "The user's own message that led to the reply (verbatim):\n" + clip(words, 4_000) : null;
}

/** The first ask: fill in what can be inferred, ask only what cannot (`draftRequest`). */
export function draftRequest(spec: ComponentSpec, reply: string, pages: ReplyPage[], ran: string | null, bot: string): string {
  return `${actionHeader("shape", spec.id)} ${purposeLine(spec, bot)}
The user wants to make ${bot}'s reply into a component and is shaping it in a side panel; the reply is the context. ${replyBlock(reply, pages)}
The app's first draft:
${specSummary(spec)}
${dataNote(spec, ran, bot)}
Fill in what you can infer (from the reply and the library), and ask only what you cannot, at most 3 questions, each with 2 or 3 short answers and the one you suggest. If a component in the library already does this, say so in "similar". Add a sample or two (say "Failing run", "Empty") so the preview shows other cases.
${tagNote(spec)}`;
}

/** "Make into component" pressed: Maintainer infers the whole spec and builds the first version now (`firstBuildRequest`). */
export function firstBuildRequest(spec: ComponentSpec, o: { reply: string; pages?: ReplyPage[]; ran?: string | null; asked?: string | null; brief?: string | null; bot: string }): string {
  const live = spec.command !== undefined;
  const bot = o.bot;
  let context = "";
  const asked = askedBlock(o.asked ?? null);
  if (asked) context += asked + "\n";
  const brief = o.brief?.trim();
  if (brief) context += `${bot}'s brief for you (written by a copy of the session that wrote the reply, so it knows what it did and which commands it ran):\n` + brief + "\n";
  let text = `${actionHeader("build-first", spec.id)} Build the first version now. ${purposeLine(spec, bot)}
The user wants it built right away from ${bot}'s reply, given here as context. ${replyBlock(o.reply, o.pages ?? [])}
${context}The app's first draft:
${specSummary(spec)}
${dataNote(spec, o.ran ?? null, bot)}
Infer the rest from the reply, the brief and the library, and ask nothing: wherever you are unsure, use your best guess (the answer you would have suggested). If a component in the library already does this, reuse it: build nothing and set "similar" to it and "reuse" to true. Otherwise have the component editor write template.html and about.md under a name not already in the library. ${fieldGroups(live)}`;
  text += " Never run the command yourself. Once it is in the library the app adds it to " + spec.bots.join(", ");
  text += live ? " and shows it under the reply; do not add it to lists yourself." : `, then asks ${bot}, who wrote the reply, to draw it under the reply with all of that reply's data, following about.md; do not add it to lists yourself.`;
  text += `\nAnswer in one or two sentences, then <component-spec id="${spec.id}">JSON</component-spec> with what you used: name (the component's name as built), about, fields [{name, type}], command (only for live data), refresh: shown|interval|manual, minutes, similar, reuse. Build only the component and send no samples: the data under the reply comes from ${live ? "its command" : bot}. No questions.`;
  return text;
}

/** What the user said in the side panel, with their edits since (`sayRequest`). */
export function sayRequest(spec: ComponentSpec, text: string): string {
  let said = actionHeader("shape", spec.id) + " ";
  said += text ? `The user says: ${text}` : "The user changed the spec.";
  if (spec.pendingEdits.length) said += "\nTheir edits: " + spec.pendingEdits.join("; ");
  said += `\nThe spec now:\n${specSummary(spec)}\n${tagNote(spec)}`;
  return said;
}

/** What the user typed in a built component's panel: a change request, built as the next version (`changeRequest`). */
export function changeRequest(spec: ComponentSpec, said: string[], version: number): string {
  const id = spec.id;
  const name = spec.built ?? spec.name;
  let text = `${actionHeader("change", id)} Change it now: build v${version} of the component "${name}" with this change, right away.`;
  const words = said.map((entry) => entry.trim()).filter(Boolean);
  if (words.length === 1) text += `\nThe user asks: ${words[0]}`;
  else if (words.length > 1) text += "\nThe user asks (in order, all for this version):\n" + words.map((entry, index) => `${index + 1}. ${entry}`).join("\n");
  else text += "\nThe user asks for a new version as the spec now says.";
  if (spec.pendingEdits.length) text += "\nTheir edits in the panel: " + spec.pendingEdits.join("; ");
  text += `\nThe spec now:\n${specSummary(spec)}`;
  text += `\nThis is a change request, not a discussion. Do not wait for a Build press and do not ask the user to press anything: have the component editor change template.html and about.md of ${name} now (the same component and name), keeping its data format unless the change needs other fields. `;
  text += fieldGroups(spec.command !== undefined);
  text += " Only if the request is genuinely ambiguous (two readings that would build different things), do not build; ask exactly one question in \"questions\" with 2 or 3 short answers and the one you suggest; the user's answer comes back as the next change request.";
  text += " Never run the command yourself. The app sees the new version land in the library and updates it under the reply and on " + spec.bots.join(", ") + "; do not add it to lists yourself.";
  text += `\nAnswer in one or two sentences, then <component-spec id="${id}">JSON</component-spec> with only what you changed (name, about, fields [{name, type}], command, refresh: shown|interval|manual, minutes), or with the one question.`;
  return text;
}

/** Build it (`buildRequest`). */
export function buildRequest(spec: ComponentSpec): string {
  let text = `${actionHeader("build", spec.id)} Build it: make the component "${spec.name}" now, as the spec says.\n${specSummary(spec)}`;
  if (spec.pendingEdits.length) text += "\nThe user's last edits: " + spec.pendingEdits.join("; ");
  text += "\nHave the component editor write template.html and about.md";
  if (spec.command !== undefined) text += `; about.md gets the line "Command: ${spec.command}" so the app fills it by running that in the bot's folder (only once the user allows it)`;
  else text += "; about.md says what JSON a bot gives it with <show>: once it is built the app asks the bot that wrote the reply to draw it there with that reply's data";
  text += ". The data fields above are what the template reads. " + fieldGroups(spec.command !== undefined);
  text += " Once it is in the library the app adds it to " + spec.bots.join(", ") + "; do not add it to lists yourself.";
  return text;
}

/** The user pinned a bot-filled component to the Board (`boardCommandRequest`). */
export function boardCommandRequest(name: string, suggested: string, folder: string, bot: string, brief: string | null = null): string {
  let text = `${actionHeader("live-on-board", name)} Make it live on the Board: the user pinned ${name} to ${bot}'s Board. A bot fills it today; its about.md suggests "Board command: ${suggested}" for its From command fields.`;
  text += ` Have the component editor add a "Command: …" line to about.md: a command (or a small script in the component's folder, run by its full path) that prints the same JSON the template reads, with the ${FIELD_GROUP.fromCommand} fields (the ${FIELD_GROUP.botOnly} ones left out: the template already draws without them). It runs in ${folder}.`;
  text += " Keep the Board command line and the data format as they are: bots still fill it in chats with <show>, and their data wins there. Add a \"Refresh: every …\" line only if the data changes within seconds. It stays the same component (no separate Board version).";
  text += " Never run the command yourself: the user allows it on the pinned card. Once the Command is in the library the app switches the pin to it.";
  if (brief) text += "\nThe brief it was built from:\n" + clip(brief, 4_000);
  return text;
}

/** `date.formatted(date: .omitted, time: .shortened)`: "6:13 am" in en-GB with a 12-hour clock. */
export function shortTime(swiftDate: number, clock: Clock = {}): string {
  const parts = new Intl.DateTimeFormat(clock.locale, { hour: "numeric", minute: "2-digit", timeZone: clock.timeZone, ...(clock.hour12 === undefined ? {} : { hour12: clock.hour12 }) })
    .formatToParts(new Date(Date.UTC(2001, 0, 1) + swiftDate * 1000));
  // Foundation puts a narrow no-break space before am/pm (Chromium's ICU went back to a plain one).
  return parts.map((part, index) => (part.type === "literal" && parts[index + 1]?.type === "dayPeriod" && part.value === " " ? "\u202f" : part.value)).join("");
}

/** The quiet app message to the bot that wrote the reply, once the component is built (`fillRequest`). */
export function fillRequest(spec: ComponentSpec, name: string, reply: { text: string; when: string; preview: string } | null, pages: string[], usage: string): string {
  const purpose = (spec.purpose ?? "").trim();
  let text = `(App: Draw the component "${name}" for your reply${reply ? ` from ${reply.when}` : ""}${reply ? ` ("${reply.preview}")` : ""}: the user made that reply into this component`;
  text += purpose ? `, for this: ${purpose}.` : ".";
  text += ` Answer with only <show name="${name}">JSON</show> holding that reply's content in full (every item it has, in your words and language), in the data format its usage below gives. No words before or after it: the app shows it under that reply, not as a new message. If the reply's content does not fit this component, answer in one sentence why, without the tag.`;
  if (reply) text += "\nYour reply was:\n" + clip(reply.text, REPLY_LIMIT);
  for (const page of pages) text += `\nIt links the result page ${page}; what is there is part of its content.`;
  if (usage) text += `\nUsage of ${name}:\n` + usage;
  return text + ")";
}

/** The bot's answer to `fillRequest`: the data of its `<show>` (`filledData`), else why not. */
export function filledData(answer: string, name: string): { data: string } | { problem: string } {
  const parsed = parseReply(answer);
  const shown = parsed.displays.find((display) => display.name === name) ?? parsed.displays[0];
  const data = shown?.data.trim();
  if (data && data !== "null") return { data };
  const said = parsed.body.split(/[\n\r\u2028\u2029\u0085\u000b\u000c]+/).find((line) => line.length > 0) ?? "";
  return { problem: said ? clip(said, 200) : "it answered without the component" };
}
