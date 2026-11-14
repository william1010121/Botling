// A text PDF written at test time (M2 step 15): `pages` pages of Helvetica text lines plus a figure per page (a 128×128
// noise image that does not compress, so the file has the size of a real report: ≈ 52 KB a page, 100 pages ≈ 5.2 MB),
// a two-level outline, and words the tests look for. Written the way Chromium's print (Skia) and pdfTeX write: a
// balanced page tree (at most 8 kids a node, the tree's nodes next to the catalog), each page's objects next to its
// content, the cross-reference table and trailer at the end, not linearized. (pdf.js reads every kid of a flat
// top-level page tree before page 1, so a flat tree with 100 pages would be read whole: see the step 15 evidence.)
import { writeFileSync } from "node:fs";

export interface MadePdf { bytes: number; pages: number; outline: Array<{ title: string; page: number; items?: Array<{ title: string; page: number }> }> }

/** The word only page `FIND_PAGE` holds (once), for find tests. */
export const FIND_WORD = "quokka";
export const FIND_PAGE = 77;
/** Words each page's first line holds. */
export const pageTitle = (n: number) => `Botling report page ${n}`;

const esc = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

export function makeTextPdf(file: string, pages = 100, options: { figure?: number; lines?: number } = {}): MadePdf {
  const lines = options.lines ?? 40;
  const side = options.figure ?? 128;
  const FAN = 8;
  // The tree's levels, leaves first: each node holds up to FAN kids (pages, then nodes); the root is object 2.
  const levels: number[][] = [];
  let count = pages;
  while (count > FAN || levels.length === 0) { count = Math.ceil(count / FAN); levels.push(Array.from({ length: count }, () => 0)); if (count === 1) break; }
  if (levels[levels.length - 1].length > 1) levels.push([0]);
  let next = 7;
  levels.forEach((level, depth) => level.forEach((_, n) => { level[n] = depth === levels.length - 1 ? 2 : next++; }));
  const firstPage = next;
  const pageObj = (i: number) => firstPage + i * 3;
  let seed = 0x2545f491;
  const noise = () => {
    const bytes = Buffer.alloc(side * side * 3);
    for (let i = 0; i < bytes.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; bytes[i] = (seed >>> 0) & 0xff; }
    return bytes.toString("latin1");
  };
  const objects: string[] = [];
  const pageNode = (i: number) => levels[0][Math.floor(i / FAN)];
  const nodeDicts = new Map<number, string>();
  levels.forEach((level, depth) => level.forEach((obj, n) => {
    const below = depth === 0 ? Array.from({ length: pages }, (_, i) => pageObj(i)) : levels[depth - 1];
    const kids = below.slice(n * FAN, n * FAN + FAN);
    const span = FAN ** (depth + 1);
    const total = Math.min(pages, (n + 1) * span) - n * span;
    const parent = depth === levels.length - 1 ? "" : ` /Parent ${levels[depth + 1][Math.floor(n / FAN)]} 0 R`;
    nodeDicts.set(obj, `<< /Type /Pages${parent} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${total} >>`);
  }));
  objects.push("<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>"); // 1
  objects.push(nodeDicts.get(2)!); // 2
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 3
  const half = Math.max(1, Math.floor(pages / 2));
  objects.push("<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 2 >>"); // 4
  objects.push(`<< /Title (Part one) /Parent 4 0 R /Dest [${pageObj(0)} 0 R /Fit] /First 6 0 R /Last 6 0 R /Count 1 >>`); // 5
  objects.push(`<< /Title (Chapter ${half}) /Parent 5 0 R /Dest [${pageObj(half - 1)} 0 R /XYZ 0 792 0] >>`); // 6
  for (let obj = 7; obj < firstPage; obj++) objects.push(nodeDicts.get(obj)!);
  for (let i = 0; i < pages; i++) {
    let text = `BT /F1 20 Tf 72 740 Td (${esc(pageTitle(i + 1))}) Tj ET BT /F1 10 Tf 72 712 Td 13 TL`;
    for (let l = 0; l < lines; l++) {
      const extra = i + 1 === FIND_PAGE && l === 17 ? ` the ${FIND_WORD} sat here` : "";
      text += ` (Line ${l + 1} of page ${i + 1}: steady text for selection and search${extra}.) '`;
    }
    text += side ? " ET q 120 0 0 120 432 40 cm /Im1 Do Q" : " ET";
    objects.push(`<< /Type /Page /Parent ${pageNode(i)} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${side ? ` /XObject << /Im1 ${pageObj(i) + 2} 0 R >>` : ""} >> /Contents ${pageObj(i) + 1} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    if (side) objects.push(`<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${side * side * 3} >>\nstream\n${noise()}\nendstream`);
    else objects.push("null");
  }
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const buffer = Buffer.from(out, "latin1");
  writeFileSync(file, buffer);
  return { bytes: buffer.length, pages, outline: [{ title: "Part one", page: 1, items: [{ title: `Chapter ${half}`, page: half }] }] };
}
