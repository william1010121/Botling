// TEMPORARY L-010 mutation batch (removed in the next commit).
import { it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..");
const src = join(__dirname, "..", "src", "prune.ts");
const original = readFileSync(src, "utf8");
const mutants: [string, string, string][] = [
  ["M1 only Botling-2", "Botling-[23]-", "Botling-2-"],
  ["M2 accepts Botling-4", "Botling-[23]-", "Botling-[234]-"],
  ["M3 drop symlink check", "stat.isSymbolicLink() || ", ""],
  ["M4 drop foldersOnly", "(foldersOnly && !stat.isDirectory())", "false"],
  ["M5 drop protectedBy", "index < keep || protectedBy(path, protect)", "index < keep"],
  ["M6 keep off by one", "index < keep ||", "index <= keep ||"],
  ["M7 sort oldest first", "b.epoch - a.epoch ||", "a.epoch - b.epoch ||"],
  ["M8 KEEP 1", "KEEP_BACKUPS = 2", "KEEP_BACKUPS = 1"],
  ["M9 drop ^ anchor", "/^Botling-[23]-", "/Botling-[23]-"],
  ["M10 drop $ anchor", "\\.app$/;\n/** Leftovers", "\\.app/;\n/** Leftovers"],
  ["M11 drop date part", "\\d{4}-\\d{2}-\\d{2}-(\\d+)", "(\\d+)"],
  ["M12 protect: only equal", "other === here || other.startsWith(here + sep) || here.startsWith(other + sep)", "other === here"],
  ["M13 protect: drop contains-direction", "other.startsWith(here + sep) || ", ""],
  ["M14 allow other chars in version", "[0-9A-Za-z._-]+-\\d{4}", ".+-\\d{4}"],
  ["M15 keep Math.max", "Math.max(0, options.keep ?? KEEP_BACKUPS)", "options.keep ?? 0"],
];
const run = () => spawnSync("npx", ["vitest", "run", "builtin-plugins/botling.dev/test/prune.test.ts"], { cwd: root, encoding: "utf8" }).status;

it("batch", () => {
  const out: string[] = [];
  const base = run();
  out.push(`baseline status ${base}`);
  expect(base).toBe(0);
  try {
    for (const [name, from, to] of mutants) {
      if (!original.includes(from)) { out.push(`${name}: NOT APPLIED`); continue; }
      writeFileSync(src, original.replace(from, to));
      out.push(`${name}: ${run() === 0 ? "SURVIVED" : "killed"}`);
    }
  } finally { writeFileSync(src, original); }
  console.log("MUTATION RESULTS\n" + out.join("\n"));
}, 900_000);
