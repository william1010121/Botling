// TEMPORARY review harness (L-010 batch), removed in the next commit. Not a product test.
import { it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = join(__dirname, "..");
const desktop = join(root, "..", "..");
const V = join(root, "src", "viewer.ts"), C = join(root, "catchup.css");
type M = [string, string, string, string];
const mutants: M[] = [
  ["M1 fallback card clipped", V, 'this.cardStatus(fallback,message);column.append(fallback);', 'this.cardStatus(fallback,message);column.append(fallback);fallback.classList.add("source-clipped");'],
  ["M2 snapshot-unavailable card clipped", V, 'holder.append(data);this.cardStatus(holder,message);return;}', 'holder.append(data);this.cardStatus(holder,message);holder.classList.add("source-clipped");return;}'],
  ["M3 snapshot picture clipped", V, 'holder.append(image);\n', 'holder.append(image);holder.classList.add("source-clipped");\n'],
  ["M4 choices card clipped", V, '    column.append(card);\n  }', '    column.append(card);card.classList.add("source-clipped");\n  }'],
  ["M5 snapshot iframe height not set", V, 'image.style.height=`${snapshot.height}px`;', ''],
  ["M6 source-body not scrolling", C, '.source-body { flex:1;min-height:0;overflow:auto;', '.source-body { flex:1;min-height:0;overflow:hidden;'],
  ["M7 width back to 960", C, 'width:min(1280px,calc(100vw - 24px))', 'width:min(960px,calc(100vw - 24px))'],
  ["M8 width overflows window", C, 'width:min(1280px,calc(100vw - 24px))', 'width:min(1280px,calc(100vw + 24px))'],
  ["M9 height not capped by window", C, 'height:min(860px,calc(100dvh - 32px))', 'height:860px'],
  ["M10 source-body min-height removed", C, '.source-body { flex:1;min-height:0;', '.source-body { flex:1;'],
  ["M11 dialog overflow visible", C, 'box-shadow:0 24px 64px rgb(0 0 0 / calc(.6 * var(--shade)));overflow:hidden;', 'box-shadow:0 24px 64px rgb(0 0 0 / calc(.6 * var(--shade)));'],
];
const run = () => spawnSync("npx", ["vitest", "run", "builtin-plugins/botling.catchup/test/full-components.test.ts", "--reporter=dot"], { cwd: desktop, encoding: "utf8", env: { ...process.env, CI: "1" } });
it("batch", () => {
  const base = run(); console.log(`BASELINE exit=${base.status}`); if (base.status !== 0) { console.log(base.stdout.slice(-3000)); return; }
  for (const [name, file, from, to] of mutants) {
    const original = readFileSync(file, "utf8");
    if (!original.includes(from)) { console.log(`MUTANT ${name}: PATCH FAILED (pattern not found)`); continue; }
    try { writeFileSync(file, original.replace(from, to)); const r = run(); console.log(`MUTANT ${name}: ${r.status === 0 ? "SURVIVED" : "killed"}`); }
    finally { writeFileSync(file, original); }
  }
}, 900_000);
