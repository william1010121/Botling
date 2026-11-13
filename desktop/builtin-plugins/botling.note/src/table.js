// botling.note, Markdown (GFM pipe) tables. The file keeps plain pipe-table text:
//
//   | 名稱 | 數量 |
//   | :--- | ---: |
//   | 蘋果 | 3    |
//
// A table is a header row (a line with a `|`), a delimiter row of the same number of cells (`---`, `:---`, `---:`,
// `:---:`), then body rows until a line without `|`, a blank line, or a comment line (`<!-- cell / branch / route -->`).
// Everything here is pure; a table is only rewritten (tidy, padded columns) when the user edits it.

// Finding a table (tableAt and its row tests) is the app's one copy of the rules, desktop/src/core/note-cells.ts; editing one is here.
import { splitRow, isRowLine, isDelimLine, tableAt } from "../../../src/core/note-cells.ts";
export { splitRow, isRowLine, isDelimLine, tableAt };

const alignOf = (c) => (/^:-+:$/.test(c) ? "center" : /^:-+$/.test(c) ? "left" : /^-+:$/.test(c) ? "right" : "");

// { indent, header: [cell], aligns: ["" | left | center | right], rows: [[cell]] }; every row has the same number of
// cells (the widest row decides, so no text is ever dropped).
export function parseTable(lines, start, end) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map(alignOf);
  const rows = [];
  for (let i = start + 2; i <= end; i++) rows.push(splitRow(lines[i]));
  const n = Math.max(header.length, ...rows.map((r) => r.length));
  const fit = (r, fill) => (r.length < n ? [...r, ...new Array(n - r.length).fill(fill)] : r);
  return { indent: /^\s*/.exec(lines[start])[0], header: fit(header, ""), aligns: fit(aligns, ""), rows: rows.map((r) => fit(r, "")) };
}

// Display width: East Asian wide characters count 2, so the pipes line up in a monospace editor.
const wide = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);
export const textWidth = (s) => [...String(s)].reduce((a, ch) => a + (wide(ch.codePointAt(0)) ? 2 : 1), 0);

export function serializeTable(t) {
  const n = t.header.length;
  const w = [];
  for (let c = 0; c < n; c++) w.push(Math.max(3, textWidth(t.header[c]), ...t.rows.map((r) => textWidth(r[c] ?? ""))));
  const pad = (s, c) => s + " ".repeat(Math.max(0, w[c] - textWidth(s)));
  const row = (cells) => `${t.indent}| ${cells.map((s, c) => pad(s ?? "", c)).join(" | ")} |`;
  const delim = t.aligns.map((a, c) =>
    a === "center" ? `:${"-".repeat(w[c] - 2)}:` : a === "left" ? `:${"-".repeat(w[c] - 1)}` : a === "right" ? `${"-".repeat(w[c] - 1)}:` : "-".repeat(w[c]));
  return [row(t.header), `${t.indent}| ${delim.join(" | ")} |`, ...t.rows.map(row)];
}

// A cell's text as the user edits it (`\|` shown as `|`), and back.
export const cellText = (raw) => String(raw ?? "").replace(/\\\|/g, "|");
export const cellRaw = (text) => String(text ?? "").replace(/[\r\n]+/g, " ").replace(/\\\|/g, "|").replace(/\|/g, "\\|").trim();

// r = -1 is the header row.
export const getCell = (t, r, c) => (r < 0 ? t.header[c] : t.rows[r]?.[c]) ?? "";
export function setCell(t, r, c, raw) {
  if (r < 0) t.header[c] = raw;
  else if (t.rows[r]) t.rows[r][c] = raw;
}
export const insertRow = (t, at) => t.rows.splice(Math.max(0, Math.min(at, t.rows.length)), 0, new Array(t.header.length).fill(""));
export const deleteRow = (t, r) => r >= 0 && t.rows.splice(r, 1);
export function insertCol(t, at) {
  at = Math.max(0, Math.min(at, t.header.length));
  t.header.splice(at, 0, "");
  t.aligns.splice(at, 0, "");
  for (const r of t.rows) r.splice(at, 0, "");
}
export function deleteCol(t, c) {
  t.header.splice(c, 1);
  t.aligns.splice(c, 1);
  for (const r of t.rows) r.splice(c, 1);
}

// A new table: `cols` columns, a header row and `rows` empty body rows.
export function newTable(cols, rows) {
  const t = { indent: "", header: Array.from({ length: cols }, (_, k) => `欄 ${k + 1}`), aligns: new Array(cols).fill(""), rows: [] };
  for (let k = 0; k < rows; k++) insertRow(t, k);
  return serializeTable(t);
}
