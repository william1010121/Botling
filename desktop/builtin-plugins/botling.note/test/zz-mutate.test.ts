// TEMPORARY review harness (L-010 batch), removed in the next commit. Not a product test.
// One baseline run of the related tests, then each mutant: patch, run the tests that should catch it, restore. A mutant is killed when a
// test fails that passed in the baseline (or the run fails with a clean baseline); it survives when the failures are the baseline's.
import { it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const note = join(__dirname, "..");
const plugins = join(note, "..");
const desktop = join(plugins, "..");
const U = join(note, "src", "ui-cards.js");
const W = join(plugins, "botling.whiteboard", "src", "ui.tsx");
const B = join(plugins, "botling.whiteboard", "src", "board.ts");
const C = join(plugins, "botling.whiteboard", "src", "board.css");
const H = join(desktop, "src", "renderer", "plugin-frame-host.ts");

const NOTE = ["builtin-plugins/botling.note/test/ui-cards-flicker-run.test.ts"];
const WB = ["builtin-plugins/botling.whiteboard/test/picture-handoff.test.ts"];
const HOST = ["test/unit/note-cards-frame.test.ts", "test/unit/whiteboard-picture.test.ts"];
const ALL = [
  ...NOTE,
  "builtin-plugins/botling.note/test/ui-mount-run.test.ts",
  "builtin-plugins/botling.note/test/ui-margin-run.test.ts",
  ...WB,
  "builtin-plugins/botling.whiteboard/test/board.test.ts",
  "builtin-plugins/botling.whiteboard/test/polling.test.ts",
  "builtin-plugins/botling.whiteboard/test/bundle.test.ts",
  ...HOST,
];

type M = [string, string, string, string, string[]];
const mutants: M[] = [
  ["N01 empty-but-done kept as stale", U, 'cs.data === "null" && (cs.status === "approve" || cs.status === "idle" || cs.status === "running");', 'cs.data === "null";', NOTE],
  ["N02 no keep when nothing to show", U, "if (noData && v.frame) return;", "", NOTE],
  ["N03 same data: next not dropped", U, "if (same && v.data === cs.data) {\n      cancelNext(v);", "if (same && v.data === cs.data) {", NOTE],
  ["N04 live path: next not dropped", U, "      cancelNext(v);\n      v.data = cs.data;", "      v.data = cs.data;", NOTE],
  ["N05 no want===want guard", U, "if (v.next?.want === want) return;", "", NOTE],
  ["N06 handOff: older next not dropped", U, "function handOff(v, next) {\n    cancelNext(v);", "function handOff(v, next) {", NOTE],
  ["N07 no give-up timer", U, "next.timer = setTimeout(() => {", "next.timer = setTimeout(() => { return;", NOTE],
  ["N08 give-up does not ask again", U, "      drawView(v); // asks for the page again; the old one is still shown", "", NOTE],
  ["N09 ready from any frame hands over", U, "if (coming) takeOver(v, v.next, d.height);", "if (v.next) takeOver(v, v.next, d.height);", NOTE],
  ["N10 ready height always", U, "const h = next.height > 0 ? next.height : Math.max", "const h = false ? next.height : Math.max", NOTE],
  ["N11 measured height only", U, "const h = next.height > 0 ? next.height : Math.max(24, Math.min(6000, Math.ceil(Number(readyHeight) || 0)));", "const h = next.height;", NOTE],
  ["N12 next not laid over", U, "...(v.next ? [[v.next.frame, true]] : [])", "", NOTE],
  ["N13 next takes the pointer", U, 'fs.pointerEvents = hidden || pass ? "none" : "";', 'fs.pointerEvents = pass ? "none" : "";', NOTE],
  ["N14 live said by next marks shown", U, "const frame = shown ? v.frame : v.next.frame;", "const frame = v.frame;", NOTE],
  ["N15 next size writes nothing", U, "if (coming) v.next.height = h;", "if (coming) {}", NOTE],
  ["N16 next not hidden", U, 'next.frame.style.visibility = "hidden";', "", NOTE],
  ["N17 swapped frame stays hidden", U, 'next.frame.style.visibility = "";', "", NOTE],
  ["N18 old frame not removed", U, "old?.remove();", "", NOTE],
  ["N19 failure drops a shown frame's card", U, "if (!v.frame) v.msg = `畫不出這張卡片", "v.msg = `畫不出這張卡片", NOTE],
  ["N20 stale answer taken", U, "if (!v.state || wantOf(v.state) !== want) return;", "", NOTE],
  ["N21 no re-ask after a change meanwhile", U, "if (v.state && wantOf(v.state) !== want) drawView(v);", "", NOTE],
  ["N22 no drawing guard", U, "if (v.drawing) return;", "", NOTE],
  ["N23 reply: gone card not checked", U, "if (!cur || st.lines", "if (st.lines", NOTE],
  ["N24 reply: changed text not checked", U, ' || st.lines.slice(cur.start, cur.end + 1).join("\\n") !== body) continue;', ") continue;", NOTE],
  ["N25 reply: matched by today's line", U, "list?.find((c) => c.line === b.start", "list?.find((c) => c.line === cur.start", NOTE],
  ["N26 live data as object", U, 'postMessage({ ccbData: JSON.stringify(data) }, "*")', 'postMessage({ ccbData: data }, "*")', NOTE],
  ["N27 dropView leaves next", U, "    stopTimer(v);\n    cancelNext(v);\n    v.frame?.remove();", "    stopTimer(v);\n    v.frame?.remove();", NOTE],
  ["N28 ready not in the message filter", U, 'd.ccb !== "live" && d.ccb !== "ready")', 'd.ccb !== "live")', NOTE],
  ["P01 card page without ready", H, '"chat", false, false, true);', '"chat", false, false);', HOST],
  ["P02 tile page without ready", H, '"board", true, false, true);', '"board", true, false);', HOST],
  ["W01 back to shown: next kept", W, "{ asked.current++; setNext(null); return; }", "{ asked.current++; return; }", WB],
  ["W02 back to shown: request not dropped", W, "{ asked.current++; setNext(null); return; }", "{ setNext(null); return; }", WB],
  ["W03 data posted to a non-live frame", W, "target && live.current.has(target)", "target", WB],
  ["W04 live: shown data not updated", W, "      setShown({ ...have, data: picture.data });\n", "", WB],
  ["W05 live: next not dropped", W, "      setNext(null);\n      setShown({ ...have", "      setShown({ ...have", WB],
  ["W06 old answer taken", W, "if (mine !== asked.current || gone.current) return;", "if (gone.current) return;", WB],
  ["W07 always a next", W, "if (now.current.shown) setNext(page); else setShown(page);", "setNext(page);", WB],
  ["W08 ready from any window", W, "event.source === coming.current?.contentWindow", "true", WB],
  ["W09 no give-up retry", W, "setNext(null); setAgain((count) => count + 1); }, PICTURE_READY_WAIT", "setNext(null); }, PICTURE_READY_WAIT", WB],
  ["W10 no give-up", W, "const timer = setTimeout(() => { setNext(null);", "const timer = setTimeout(() => { return; setNext(null);", WB],
  ["W11 lane in lane order", W, "const running = pictured.size > 0 ? stableOrder(placed.current, lanes.running) : lanes.running;", "const running = lanes.running;", WB],
  ["W12 placed not kept", W, "    placed.current = pictured.size > 0 ? running.map((bot) => bot.id) : [];\n", "", WB],
  ["W13 drawn not kept", W, "    drawn.current = pictured;\n", "", WB],
  ["W14 no CSS order", W, "order={pictured.size > 0 ? rank.get(bot.id) : undefined}", "order={undefined}", WB],
  ["W15 cap does not keep drawn", W, "keepPictured(drawn.current,", "keepPictured(new Set(),", WB],
  ["B01 keep: no cap", B, "candidates.filter((id) => previous.has(id)).slice(0, max)", "candidates.filter((id) => previous.has(id))", WB],
  ["B02 keep: fill past the cap", B, "if (out.size >= max) break;", "", WB],
  ["B03 keep: none kept", B, "new Set(candidates.filter((id) => previous.has(id)).slice(0, max))", "new Set()", WB],
  ["C01 tile not an anchor", C, ".wb-picture { position: relative;", ".wb-picture {", WB],
  ["C02 next not laid over", C, ".wb-picture-next { position: absolute; inset: 0; }", ".wb-picture-next { }", WB],
];

const failures = (r: ReturnType<typeof run>) => {
  const out = new Set<string>();
  try {
    const json = JSON.parse(readFileSync(r.json, "utf8"));
    for (const file of json.testResults ?? []) {
      if (file.status === "failed" && !(file.assertionResults ?? []).some((a: any) => a.status === "failed")) out.add(`${file.name}::(file)`);
      for (const a of file.assertionResults ?? []) if (a.status === "failed") out.add(`${file.name}::${a.fullName}`);
    }
  } catch {
    out.add("(no json)");
  }
  return out;
};
let count = 0;
const dir = mkdtempSync(join(tmpdir(), "mut-"));
function run(tests: string[]) {
  const json = join(dir, `r${++count}.json`);
  const r = spawnSync("npx", ["vitest", "run", ...tests, "--reporter=json", `--outputFile=${json}`], { cwd: desktop, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { status: r.status, json, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => /Unhandled|Error:|FAIL/.test(l)).slice(0, 6).join(" | ") };
}
it("batch", () => {
  const base = run(ALL);
  const baseFails = failures(base);
  console.log(`BASELINE exit=${base.status} failures=${baseFails.size}`);
  for (const f of baseFails) console.log(`  BASELINE FAIL ${f}`);
  if (base.status !== 0) console.log(`  ${base.tail}`);
  for (const [name, file, from, to, tests] of mutants) {
    const original = readFileSync(file, "utf8");
    const at = original.indexOf(from);
    if (at < 0) { console.log(`MUTANT ${name}: PATCH FAILED (pattern not found)`); continue; }
    try {
      writeFileSync(file, original.slice(0, at) + to + original.slice(at + from.length));
      const r = run(tests);
      const now = failures(r);
      const fresh = [...now].filter((f) => !baseFails.has(f));
      const killed = fresh.length > 0 || (r.status !== 0 && base.status === 0);
      console.log(`MUTANT ${name}: ${killed ? "killed" : "SURVIVED"} (exit ${r.status}${fresh.length ? `, ${fresh.length} new failing: ${fresh[0].split("::").pop()}` : ""})`);
    } finally {
      writeFileSync(file, original);
    }
  }
  console.log("=== DONE");
}, 3_000_000);
