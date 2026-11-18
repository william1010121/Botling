// TEMPORARY (L-010 batch at review of bot/card-redo-opus): one remote-test connection runs the related tests, then each mutant in turn
// (patch, run the related tests, record, restore). Removed in the next commit.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";

const desktop = process.cwd();
const repo = resolve(desktop, "..");
const DESKTOP_TESTS = ["test/unit/worker-cards.test.ts", "test/unit/bot-worker-cards.test.ts", "test/unit/core-split-characterization.test.ts", "test/unit/plugin-commands-rescope.test.ts", "test/unit/payload.test.ts"];
const WEB_TESTS = ["test/chat.test.ts"];

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
function run(): { ok: boolean; tail: string } {
  let tail = "", ok = true;
  for (const [cwd, files] of [[desktop, DESKTOP_TESTS], [resolve(repo, "Web"), WEB_TESTS]] as const) {
    try { execFileSync("npx", ["vitest", "run", "--reporter=dot", "--bail=1", ...files], { cwd, env, stdio: "pipe", maxBuffer: 64 << 20, timeout: 600_000 }); }
    catch (error) { ok = false; const e = error as { stdout?: Buffer; stderr?: Buffer }; tail += `${String(e.stdout ?? "").slice(-1_500)}${String(e.stderr ?? "").slice(-500)}`; }
  }
  return { ok, tail };
}

interface Mutant { id: string; file: string; from: string; to: string }
const W = "desktop/src/core/bot/workers.ts", C = "desktop/src/core/worker-cards.ts", B = "Web/src/message-body.ts";
const mutants: Mutant[] = [
  { id: "W1 no still-at-work refusal", file: W, from: 'if (card.status === "starting" || card.status === "running") throw new ContractError("conflict", "The card\'s worker is still', to: 'if (false) throw new ContractError("conflict", "The card\'s worker is still' },
  { id: "W2 no already-redone refusal", file: W, from: "if (card.model === CARD_REDO_MODEL) throw", to: "if (false) throw" },
  { id: "W3 no double-start guard", file: W, from: "if (this.redoingCards.has(card.id)) throw", to: "if (false) throw" },
  { id: "W4 model haiku", file: W, from: "model: CARD_REDO_MODEL, effort: CARD_REDO_EFFORT }) as", to: 'model: "haiku", effort: CARD_REDO_EFFORT }) as' },
  { id: "W5 effort low", file: W, from: "effort: CARD_REDO_EFFORT }) as { task_id", to: 'effort: "low" }) as { task_id' },
  { id: "W6 no recheck after await", file: W, from: "if (card.taskId !== taskId || this.shuttingDown) {", to: "if (this.shuttingDown) {" },
  { id: "W7 no engine refusal", file: W, from: 'if (this.engine !== "claude" || !this.claudeWorkersOn()) throw new ContractError("conflict", "A card needs', to: 'if (false) throw new ContractError("conflict", "A card needs' },
  { id: "W8 guard not released", file: W, from: "finally { this.redoingCards.delete(card.id); }", to: "finally { }" },
  { id: "W9 earlier worker wakes head", file: W, from: "cardHasWorker(card, id))) continue;", to: "card.taskId === id)) continue;" },
  { id: "W10 no shutdown refusal", file: W, from: 'if (this.shuttingDown) throw new ContractError("conflict", "The app is stopping; nothing was started.");', to: "" },
  { id: "C1 earlier not kept", file: C, from: "if (card.taskId && card.taskId !== taskId) card.earlier =", to: "if (false) card.earlier =" },
  { id: "C2 model not set", file: C, from: "  card.model = model;\n", to: "" },
  { id: "C3 wants/error kept on rebind", file: C, from: "  card.run = run;\n  delete card.error; delete card.wants; delete card.asked; delete card.askedAt;", to: "  card.run = run;" },
  { id: "C4 report not quoted", file: C, from: 'Its report: ${JSON.stringify(clip(card.text ?? "", REDO_TEXT_MAX))}', to: 'Its report: ${clip(card.text ?? "", REDO_TEXT_MAX)}' },
  { id: "C5 show JSON not quoted", file: C, from: "JSON ${JSON.stringify(clip(show.data, REDO_TEXT_MAX))}", to: "JSON ${clip(show.data, REDO_TEXT_MAX)}" },
  { id: "C6 no clip", file: C, from: "(text.length > max ? ", to: "(false ? " },
  { id: "C7 note not quoted", file: C, from: "${JSON.stringify(note.trim().slice(0, 4_000))}", to: "${note.trim().slice(0, 4_000)}" },
  { id: "C8 readCards drops model", file: C, from: '...(typeof each.model === "string" && each.model ? { model: each.model.slice(0, 40) } : {}),', to: "" },
  { id: "C9 failed redo clears drawing", file: C, from: "} else if (card.model) {", to: "} else if (false) {" },
  { id: "C10 command name not quoted", file: C, from: "component ${JSON.stringify(show.name)}", to: "component ${show.name}" },
  { id: "S1 scope read", file: "desktop/src/protocol/scopes.ts", from: '"card.redo": manage,', to: '"card.redo": read,' },
  { id: "P1 payload drops model", file: "desktop/src/renderer/payload.ts", from: "...(card.model ? { model: card.model } : {}), ", to: "" },
  { id: "V1 view drops model", file: "desktop/src/core/bot/cards.ts", from: "...(card.model ? { model: card.model.slice(0, 40) } : {}), ", to: "" },
  { id: "B1 button on running card", file: B, from: 'if (card.taskId && !card.model && card.status !== "starting" && card.status !== "running") head', to: "if (card.taskId && !card.model) head" },
  { id: "B2 button on redone card", file: B, from: 'if (card.taskId && !card.model && card.status !== "starting"', to: 'if (card.taskId && card.status !== "starting"' },
  { id: "B3 button without worker", file: B, from: 'if (card.taskId && !card.model && card.status !== "starting" && card.status !== "running") head.append(redoButton(card.id, card.taskId));', to: 'if (!card.model && card.status !== "starting" && card.status !== "running") head.append(redoButton(card.id, card.taskId!));' },
  { id: "B4 empty note sent", file: B, from: '...(note ? { note } : {}) });', to: "note });" },
  { id: "B5 no model tag", file: B, from: "if (card.model) head.append(modelTag(card.model));", to: "" },
];

it("mutation batch", () => {
  const base = run();
  console.log(`BATCH baseline ${base.ok ? "PASS" : "FAIL"}\n${base.ok ? "" : base.tail}`);
  const results: string[] = [];
  for (const mutant of mutants) {
    const path = resolve(repo, mutant.file);
    const original = readFileSync(path, "utf8");
    const count = original.split(mutant.from).length - 1;
    if (count !== 1) { results.push(`${mutant.id}: NOT APPLIED (matches ${count})`); continue; }
    try {
      writeFileSync(path, original.replace(mutant.from, () => mutant.to));
      const outcome = run();
      results.push(`${mutant.id}: ${outcome.ok ? "SURVIVED" : "killed"}`);
    } finally { writeFileSync(path, original); }
  }
  console.log(`BATCH RESULTS\n${results.join("\n")}`);
}, 7_000_000);
