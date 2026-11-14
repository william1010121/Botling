// The PDF viewer's pure parts (M2 step 15): reading a range answer, finding words in the owner's prepared page text,
// and marking a hit in pdf.js's text layer (spans in reading order). No DOM beyond what `markHit` is handed.

/** `bytes a-b/total` → its parts, or null. */
export function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((value ?? "").trim());
  if (!match) return null;
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return Number.isSafeInteger(total) && start <= end && end < total ? { start, end, total } : null;
}

/** Folds case and runs of white space, keeping a map from each folded character back to its source index. */
export function fold(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (space || out.length === 0) continue;
      space = true;
      out += " ";
      map.push(i);
      continue;
    }
    space = false;
    const lower = ch.toLocaleLowerCase();
    // A character whose lower case is longer (rare) maps each piece to the same source.
    for (const piece of lower) { out += piece; map.push(i); }
  }
  return { text: out, map };
}

export interface FindHit { page: number; nth: number }

/** Every hit of `query` in the pages' text, page by page (page numbers 1-based; `nth` counts hits on that page). */
export function findInPages(pages: readonly string[], query: string, limit = 10_000): FindHit[] {
  const q = fold(query).text.trim();
  if (!q) return [];
  const hits: FindHit[] = [];
  pages.forEach((text, i) => {
    const hay = fold(text).text;
    let at = hay.indexOf(q);
    let nth = 0;
    while (at >= 0 && hits.length < limit) {
      hits.push({ page: i + 1, nth: nth++ });
      at = hay.indexOf(q, at + q.length);
    }
  });
  return hits;
}

/** Where the `nth` hit of `query` lies in `pieces` (the spans' texts in order): [piece, offset] start and end (exclusive). */
export function locateInPieces(pieces: readonly string[], query: string, nth: number): { from: [number, number]; to: [number, number] } | null {
  const joined = pieces.join("");
  const starts: number[] = [];
  let sum = 0;
  for (const piece of pieces) { starts.push(sum); sum += piece.length; }
  const { text, map } = fold(joined);
  // Spans have no line breaks between them: fold the query the same way, and also try it without its spaces (two
  // spans of one line may meet with no space where the text variant had a line end).
  const q = fold(query).text.trim();
  if (!q) return null;
  const tryFind = (hay: string, needle: string, back: number[]) => {
    let at = hay.indexOf(needle);
    for (let k = 0; at >= 0 && k < nth; k++) at = hay.indexOf(needle, at + needle.length);
    return at < 0 ? null : { start: back[at]!, end: back[at + needle.length - 1]! + 1 };
  };
  let found = tryFind(text, q, map);
  if (!found && q.includes(" ")) {
    const bare: number[] = [];
    let hay = "";
    for (let i = 0; i < text.length; i++) if (text[i] !== " ") { hay += text[i]; bare.push(map[i]!); }
    found = tryFind(hay, q.replaceAll(" ", ""), bare);
  }
  if (!found) return null;
  const where = (index: number, end: boolean): [number, number] => {
    for (let p = pieces.length - 1; p >= 0; p--) {
      if (starts[p]! < index || (!end && starts[p] === index)) return [p, index - starts[p]!];
    }
    return [0, 0];
  };
  return { from: where(found.start, false), to: where(found.end, true) };
}

/**
 * Wraps the located hit in `<mark class="hit">` inside the spans (their single text node is split, as pdf.js's own find
 * does), and returns the marks. `spans` are the text layer's spans in order.
 */
export function markHit(spans: readonly HTMLElement[], hit: { from: [number, number]; to: [number, number] }): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (let p = hit.from[0]; p <= hit.to[0]; p++) {
    const span = spans[p];
    if (!span) continue;
    const text = span.textContent ?? "";
    const a = p === hit.from[0] ? hit.from[1] : 0;
    const b = p === hit.to[0] ? hit.to[1] : text.length;
    if (b <= a) continue;
    const doc = span.ownerDocument;
    const mark = doc.createElement("mark");
    mark.className = "hit";
    mark.textContent = text.slice(a, b);
    span.replaceChildren(doc.createTextNode(text.slice(0, a)), mark, doc.createTextNode(text.slice(b)));
    marks.push(mark);
  }
  return marks;
}

/** Undoes `markHit` on these spans (their text back to one node). */
export function unmark(spans: Iterable<HTMLElement>): void {
  for (const span of spans) if (span.querySelector("mark.hit")) span.replaceChildren(span.ownerDocument.createTextNode(span.textContent ?? ""));
}
