// A bot's note (.bot/note.md) as the Note tab and the bots both read it. It stays plain Markdown;
// two things in it mean more than their text (format: .bot/artifacts/note-branch-format.md):
//
// - Branches: whole-line HTML comments split the note into alternative routes, as many as you like
//   and nested.
//       <!-- branch: Learning rate -->     a fork; its routes follow
//       <!-- route: lr=3e-4 cosine -->     a route: the lines up to the next route / end branch
//       <!-- route: lr=1e-3 warmup -->
//       <!-- end branch -->                back to what every route shares (none: to the end)
//   A route belongs to the innermost fork still open, so a fork inside a route is closed with its own
//   end branch before the outer fork's next route. Lines between a branch and its first route are
//   shared. Which route the user is looking at is never written into the file.
// - Cards: `<show name="component" …>JSON</show>`, the chat's own syntax (reply.ts), drawn live by
//   the Note tab; `command="…"` (or none and no JSON: the component's Command) fills it from a command.
// - PDF quotes: `> 〔PDF · <name> · p. <page>〕` blocks, optionally followed by a `<!-- source: ... -->` comment
//   so "go to source" can open the same content bytes at that page on any device (§9A.8, D74 Q-C8).
//
// Markers and cards inside code (fences, `inline`) are text. Nothing here reads or writes a file.
//
// How the Note tab cuts a note into cells (and the `<!-- cell: <id> -->` lines note.db exports) is note-cells.ts, one
// copy for the app and the plugin, re-exported here.
import { createHash } from "node:crypto";
import { EntryRef } from "../protocol/content-url";
import { ContentId, ServerId } from "../protocol/ids";
import { refreshSeconds } from "./components/library";
import { attributes, masked, showTag } from "./reply";

export * from "./note-cells";

export interface NoteRoute {
  /** "<fork key>/<name>" (a second route of one name in the same fork: "…/<name>#2"). */
  key: string;
  name: string;
  /** The line of its `<!-- route: … -->` (0-based). */
  line: number;
  /** The line its text stops before (the next route, the fork's end branch, an outer route's end or the end of the file). */
  end: number;
  forks: NoteFork[];
}

export interface NoteFork {
  /** Its name, after the key of the route it is in ("<route key>/<name>"; a second fork of one name there: "…#2"). */
  key: string;
  name: string;
  /** The line of its `<!-- branch: … -->`. */
  line: number;
  /** The line of its `<!-- end branch -->`; null: it has none and runs to the end of the route around it or the file. */
  end: number | null;
  routes: NoteRoute[];
}

export interface NoteProblem { line: number; message: string }

/** One way through the forks: each fork's key to the name of the route taken. */
export type RoutePicks = Record<string, string>;

/** The text with code blanked (`masked`) but its line breaks kept, so lines still line up. */
function codeless(text: string): string {
  const mask = masked(text);
  let out = "";
  for (let at = 0; at < mask.length; at++) out += text[at] === "\n" ? "\n" : mask[at];
  return out;
}

const MARKER = /^\s{0,3}<!--\s*(?:(branch|route)\s*:([\s\S]*?)|(end\s+branch)\s*)-->\s*$/i;
const NAME_MAX = 200;

type Marker = { kind: "branch" | "route"; name: string } | { kind: "end" };

function marker(line: string): Marker | null {
  const match = MARKER.exec(line);
  if (!match) return null;
  if (match[3]) return { kind: "end" };
  return { kind: match[1]!.toLowerCase() as "branch" | "route", name: match[2]!.trim() };
}

/** A key not yet taken among `taken`: `base`, else `base#2`, `base#3`… */
function fresh(base: string, taken: Set<string>): string {
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}#${n}`;
  taken.add(key);
  return key;
}

interface Parsed { forks: NoteFork[]; problems: NoteProblem[]; markers: Set<number> }

function parse(text: string): Parsed {
  const lines = codeless(text).split("\n");
  const forks: NoteFork[] = [];
  const problems: NoteProblem[] = [];
  const markers = new Set<number>();
  const keys = new Set<string>();
  const open: NoteFork[] = [];
  const lastRoute = (fork: NoteFork) => fork.routes[fork.routes.length - 1];
  lines.forEach((line, index) => {
    const found = marker(line);
    if (!found) return;
    if (found.kind !== "end" && (!found.name || found.name.length > NAME_MAX)) {
      problems.push({ line: index, message: found.name ? `A ${found.kind} name is longer than ${NAME_MAX} characters.` : "A branch or route needs a name." });
      return;
    }
    const inner = open[open.length - 1];
    if (found.kind === "branch") {
      if (inner && !lastRoute(inner)) { problems.push({ line: index, message: "A branch inside a branch that has no route yet." }); return; }
      const route = inner ? lastRoute(inner)! : null;
      const fork: NoteFork = { key: fresh(route ? `${route.key}/${found.name}` : found.name, keys), name: found.name, line: index, end: null, routes: [] };
      (route ? route.forks : forks).push(fork);
      open.push(fork);
    } else if (found.kind === "route") {
      if (!inner) { problems.push({ line: index, message: "A route outside any branch." }); return; }
      const before = lastRoute(inner);
      if (before) before.end = index;
      inner.routes.push({ key: fresh(`${inner.key}/${found.name}`, keys), name: found.name, line: index, end: lines.length, forks: [] });
    } else {
      if (!inner) { problems.push({ line: index, message: "An end branch with no branch open." }); return; }
      const before = lastRoute(inner);
      if (before) before.end = index;
      inner.end = index;
      open.pop();
    }
    markers.add(index);
  });
  // Forks still open run on: each one's last route to the end of the route around it, or of the file.
  for (let at = open.length - 1; at >= 0; at--) {
    const fork = open[at]!;
    const outer = at > 0 ? open[at - 1]!.routes[open[at - 1]!.routes.length - 1] : null;
    const last = fork.routes[fork.routes.length - 1];
    if (last) last.end = outer ? outer.end : lines.length;
  }
  return { forks, problems, markers };
}

/** The note's forks and routes, and the marker lines it could not place (kept as text). */
export function noteBranches(text: string): { forks: NoteFork[]; problems: NoteProblem[] } {
  const { forks, problems } = parse(text);
  return { forks, problems };
}

/** Every way through the note: one set of picks per innermost route reached, first routes first. */
export function noteRoutes(text: string): RoutePicks[] {
  const ways = (forks: NoteFork[]): RoutePicks[] => {
    let out: RoutePicks[] = [{}];
    for (const fork of forks) {
      const next: RoutePicks[] = [];
      for (const route of fork.routes) {
        for (const inner of ways(route.forks)) for (const picks of out) next.push({ ...picks, [fork.key]: route.name, ...inner });
      }
      if (next.length) out = next;
    }
    return out;
  };
  return ways(parse(text).forks);
}

/** The route a fork shows for `picks`: the one picked by name, else its first. */
function picked(fork: NoteFork, picks: RoutePicks): NoteRoute | undefined {
  return fork.routes.find((route) => route.name === picks[fork.key]) ?? fork.routes[0];
}

/** The note as one way through it reads: shared lines and the picked routes' lines, without the markers. `lines`: where each came from. */
export function noteView(text: string, picks: RoutePicks): { text: string; lines: number[] } {
  const all = text.split("\n");
  const { forks, markers } = parse(text);
  const hidden = new Set<number>(markers);
  const hide = (list: NoteFork[]) => {
    for (const fork of list) {
      const shown = picked(fork, picks);
      for (const route of fork.routes) {
        if (route === shown) { hide(route.forks); continue; }
        for (let line = route.line; line < route.end; line++) hidden.add(line);
      }
    }
  };
  hide(forks);
  const lines = all.map((_, index) => index).filter((index) => !hidden.has(index));
  return { text: lines.map((index) => all[index]).join("\n"), lines };
}

export interface NoteCard {
  /** `note/<16 hex>-<n>`: from its name and command, the nth such card in the note; the same card keeps it while the note changes around it. */
  key: string;
  /** Its first and last line (0-based). */
  line: number;
  endLine: number;
  name: string;
  /** Its own `command="…"`; null without (an empty one still runs its component's Command: `notes.cards` says which). */
  command: string | null;
  /** refresh="10m" in seconds (1 s to 1 h); null without one or past an hour. */
  refresh: number | null;
  /** The JSON inside it ("null" when empty). */
  data: string;
  /** Every attribute, names lowercased (width="full", id, …). */
  attributes: Record<string, string>;
  /** Its text exactly as the note has it. */
  source: string;
  /** The key of the innermost route it is in; null: shared. */
  route: string | null;
}

const lineOf = (text: string, index: number) => {
  let line = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line++;
  return line;
};

/** The innermost route holding `line`, or null. */
function routeAt(forks: NoteFork[], line: number): string | null {
  for (const fork of forks) {
    for (const route of fork.routes) {
      if (line > route.line && line < route.end) return routeAt(route.forks, line) ?? route.key;
    }
  }
  return null;
}

/** The note's cards, in order, and the ones it could not read (their data not JSON, or no name). */
export function noteCards(text: string): { cards: NoteCard[]; problems: NoteProblem[] } {
  const mask = codeless(text);
  const { forks } = parse(text);
  const cards: NoteCard[] = [];
  const problems: NoteProblem[] = [];
  const seen = new Map<string, number>();
  for (const match of mask.matchAll(showTag())) {
    const index = match.index!;
    const source = text.slice(index, index + match[0].length);
    // The same groups, read from the text itself (masking only blanks code, never this tag).
    const again = showTag().exec(source)!;
    const found = attributes(again[1] ?? "");
    const body = again[2] ?? "";
    const line = lineOf(text, index);
    const name = found.name?.trim() ?? "";
    if (!name) { problems.push({ line, message: "A <show> needs a name." }); continue; }
    if (body) {
      try { JSON.parse(body); } catch { problems.push({ line, message: `The data of <show name="${name}"> is not JSON.` }); continue; }
    }
    const command = found.command?.trim() || null;
    const hash = createHash("sha256").update(`${name}\n${command ?? ""}`).digest("hex").slice(0, 16);
    const n = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, n);
    cards.push({
      key: `note/${hash}-${n}`, line, endLine: line + (source.match(/\n/g)?.length ?? 0), name, command,
      refresh: found.refresh !== undefined ? refreshSeconds(found.refresh) : null, data: body || "null", attributes: found, source, route: routeAt(forks, line),
    });
  }
  return { cards, problems };
}

// ---------------------------------------------------------------------------------------------
// PDF quotes (§9A.8, D74 Q-C8)

const PDF_QUOTE_NAME_MAX = 200;
const PDF_QUOTE_TEXT_MAX = 4_000;
const PDF_QUOTE_HEAD = /^> 〔PDF · ([^\r\n〕]*) · p\. ([1-9]\d*)〕$/;
const PDF_SOURCE_COMMENT = /^<!-- source: content=([^/\s]+)\/([^\s]+) entry=([^#\s]+)#([1-9][0-9]{0,15}) page=([1-9][0-9]{0,15}) -->$/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

export interface PdfQuote {
  name: string;
  page: number;
  text: string;
  source: { owner: string; id: string; entry: { stream: string; seq: number } } | null;
}

function sanitizePdfName(name: string): string {
  const trimmed = name.replace(/[/\\]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const lastPart = sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
  return lastPart.replace(/\r\n|[\r\n〕]/g, "_").slice(0, PDF_QUOTE_NAME_MAX);
}

function capPdfText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length <= PDF_QUOTE_TEXT_MAX) return normalized;
  let cut = PDF_QUOTE_TEXT_MAX - 1;
  const code = normalized.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${normalized.slice(0, cut)}…`;
}

/** Formats a quoted PDF passage for a Note; omits the source comment when `quote.source` is null. */
export function pdfQuoteMarkup(quote: PdfQuote): string {
  const name = sanitizePdfName(quote.name);
  const page = Number.isFinite(quote.page) ? Math.max(1, Math.floor(quote.page)) : 1;
  const lines = [
    `> 〔PDF · ${name} · p. ${page}〕`,
    ...capPdfText(quote.text).split("\n").map((line) => (line === "" ? ">" : `> ${line}`)),
  ];
  if (quote.source) {
    lines.push(`<!-- source: content=${quote.source.owner}/${quote.source.id} entry=${quote.source.entry.stream}#${quote.source.entry.seq} page=${page} -->`);
  }
  return lines.join("\n");
}

function parsePdfSourceComment(line: string, expectedPage: number): PdfQuote["source"] {
  const match = PDF_SOURCE_COMMENT.exec(line);
  if (!match) return null;
  const [, owner, id, stream, seqStr, pageStr] = match;
  const commentPage = Number(pageStr);
  if (!Number.isSafeInteger(commentPage) || commentPage !== expectedPage) return null;
  if (!ServerId.safeParse(owner).success || !ContentId.safeParse(id).success) return null;
  const entry = EntryRef.safeParse({ stream, seq: Number(seqStr) });
  if (!entry.success) return null;
  return { owner: owner!, id: id!, entry: entry.data };
}

function matchFenceOpen(line: string): { ch: string; len: number } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  const info = match[2] ?? "";
  if (marker[0] === "`" && info.includes("`")) return null;
  return { ch: marker[0]!, len: marker.length };
}

/** Reads every PDF quote block in a Note, each with the 0-based line of its first `>` line. */
export function pdfQuotes(text: string): Array<PdfQuote & { line: number }> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Array<PdfQuote & { line: number }> = [];
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence.ch}{${fence.len},}\\s*$`);
      if (close.test(line)) fence = null;
      i++;
      continue;
    }
    const opened = matchFenceOpen(line);
    if (opened) {
      fence = opened;
      i++;
      continue;
    }
    const head = PDF_QUOTE_HEAD.exec(line);
    if (!head) {
      i++;
      continue;
    }
    const page = Number(head[2]);
    if (!Number.isSafeInteger(page) || page < 1) {
      i++;
      continue;
    }
    const name = head[1]!;
    const textLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const cur = lines[j]!;
      if (PDF_QUOTE_HEAD.test(cur)) break;
      if (cur === ">") textLines.push("");
      else if (cur.startsWith("> ")) textLines.push(cur.slice(2));
      else if (cur.startsWith(">")) textLines.push(cur.slice(1));
      else break;
      j++;
    }
    const source = j < lines.length ? parsePdfSourceComment(lines[j]!, page) : null;
    out.push({ line: i, name, page, text: textLines.join("\n"), source });
    i = source ? j + 1 : j;
  }
  return out;
}
