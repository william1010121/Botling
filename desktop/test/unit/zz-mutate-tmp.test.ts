// TEMPORARY mutation batch for bot/card-unknown-name (removed in the next commit): each mutant patches src, runs the related files in a child vitest, restores.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

const FILES = ["test/unit/card-validate.test.ts", "test/unit/component-cards.test.ts"];
const V = "src/core/card-validate.ts", C = "src/core/bot/cards.ts";
const MUTANTS: Array<[string, string, string, string]> = [
  ["V5 hint without inline-report-block in known", V, ' && known.includes("inline-report-block") ?', " ?"],
  ["V6 hint without inline-chart in known", V, ' && known.includes("inline-chart") ? `for', " ? `for"],
  ["V7a no 40 cut", V, "names.slice(0, 40).join", "names.join"],
  ["V7b more note off by one", V, "names.length > 40 ?", "names.length >= 40 ?"],
  ["V7c more note dropped", V, "(names.length > 40 ?", "(false ?"],
  ["D4 pin-only listed", C, "library.names.filter((each) => !library.pinOnly(each))", "library.names"],
];
const run = () => spawnSync("npx", ["vitest", "run", ...FILES], { cwd: process.cwd(), encoding: "utf8" }).status;

it("every mutant is killed (exit-code based), after a passing baseline", () => {
  expect(run(), "baseline").toBe(0);
  const survived: string[] = [];
  for (const [label, file, from, to] of MUTANTS) {
    const original = readFileSync(file, "utf8");
    if (!original.includes(from)) { survived.push(`${label}: pattern not found`); continue; }
    try {
      writeFileSync(file, original.replace(from, to));
      const status = run();
      console.log(`MUTANT ${label}: ${status === 0 ? "SURVIVED" : "killed"} (exit ${status})`);
      if (status === 0) survived.push(label);
    } finally { writeFileSync(file, original); }
  }
  expect(survived).toEqual([]);
}, 300_000);
