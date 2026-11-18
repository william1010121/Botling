// TEMPORARY (L-010 batch mutation check for the review of bot/card-fix; removed in the next commit).
// Copies the worktree, then for each mutant patches one src file in the copy, rebuilds out/ (L-017) and runs vitest on that mutant's related files there.
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const T = (name: string) => `test/unit/${name}.test.ts`;
const VAL = [T("card-validate")];
const WC = [T("worker-cards")];
const BWC = [T("bot-worker-cards")];
const MT = [T("maintainer")];
const IB = [T("inline-blocks")];
const CC = [T("component-cards")];
const ALL = [...new Set([...VAL, ...WC, ...BWC, ...MT, ...IB, ...CC])];

const V = "src/core/card-validate.ts";
const W = "src/core/worker-cards.ts";
const WK = "src/core/bot/workers.ts";
const CARDS = "src/core/bot/cards.ts";
const MAINT = "src/core/maintainer.ts";
const PROMPTS = "src/core/prompts.ts";

// [name, file, find, replace, related files]
const M: [string, string, string, string, string[]][] = [
  ["V1 a negative value is fine", V, "  if (value < 0) return `${path} must not be negative (${value})`;\n", "", VAL],
  ["V2 any kind string is known", V, "typeof kind !== \"string\" || !kinds.includes(kind)", "typeof kind !== \"string\"", VAL],
  ["V3 `items` is no alias", V, "if (chart[own] != null || own === \"items\" || !Array.isArray(chart.items) || (fits && !chart.items.every(fits))) return [chart[own], own];", "return [chart[own], own];", VAL],
  ["V4 a line takes any items as series", V, "(fits && !chart.items.every(fits))", "false", VAL],
  ["V5 items win over the kind's own field", V, "if (chart[own] != null || own === \"items\"", "if (own === \"items\"", VAL],
  ["V6 log may be any value", V, "if (chart.log != null && typeof chart.log !== \"boolean\") return", "if (false) return", VAL],
  ["V7 p90 may be below median", V, "return (row.p90 as number) < (row.median as number) ?", "return false ?", VAL],
  ["V8 a log scale draws a 0 median", V, "const zero = shown.findIndex((row) => !(row.median! > 0));", "const zero = -1;", VAL],
  ["V9 a log scale draws a target of 0", V, "if (!((chart.target as number) > 0)) return `a log scale", "if (false) return `a log scale", VAL],
  ["V10 all rows count for the log check", V, ".slice(0, 12);\n  // Chosen by", ".slice(0, 99);\n  // Chosen by", VAL],
  ["V11 targets has no `rows` alias", V, "const at = chart.items != null || chart.rows == null ? \"items\" : \"rows\";", "const at = \"items\";", VAL],
  ["V12 a missing target passes", V, "  if (wrongTarget) return wrongTarget;\n", "", VAL],
  ["V13 the live KINDS are ignored", V, "liveList(template, \"KINDS\") ?? CHART_KINDS", "CHART_KINDS", VAL],
  ["V14 the live TYPES are ignored", V, "liveList(template, \"TYPES\") ?? REPORT_BLOCK_TYPES", "REPORT_BLOCK_TYPES", VAL],
  ["V15 a progress value equal to max is wrong", V, "if ((item.value as number) > max) return", "if ((item.value as number) >= max) return", VAL],
  ["V16 a progress block may hold 9 bars", V, "if (items.length > 8) return", "if (items.length > 9) return", VAL],
  ["V17 without max the value is not a percent", V, "const max = typeof item.max === \"number\" ? item.max : 100;", "const max = typeof item.max === \"number\" ? item.max : 1e9;", VAL],
  ["V18 a max of 0 passes", V, "if (item.max != null && (typeof item.max !== \"number\" || !(item.max > 0))) return", "if (false) return", VAL],
  ["V19 progress is not checked", V, "if (type === \"progress\") return checkProgress(block);", "", VAL],
  ["V20 flow is not flowchart's old name", V, "const type = block.type === \"flow\" ? \"flowchart\" : block.type;", "const type = block.type;", VAL],
  ["V21 a line may hold 4 series", V, "if (series.length > 3) return", "if (series.length > 4) return", VAL],
  ["V22 a line's values may differ in length from x", V, "if (values.length !== xs.length) return", "if (false) return", VAL],
  ["V23 an unknown report type passes", V, "if (typeof type !== \"string\" || !types.includes(type)) return", "if (false) return", VAL],
  ["W1 a failed run is held at work", W, "if (invalid && status === \"done\" && card.invalidRun !== -1", "if (invalid && card.invalidRun !== -1", [...WC, ...BWC]],
  ["W2 a worker that could not be told is held", W, "if (invalid && status === \"done\" && card.invalidRun !== -1 && (", "if (invalid && status === \"done\" && (", [...WC, ...BWC]],
  ["W3 a corrected run that is still wrong is held again (no end to the correction)", W, "(card.invalidRun === undefined || worker.run <= card.invalidRun)) {", "true) {", [...WC, ...BWC]],
  ["W4 takeInvalid tells again", W, "if (!card.invalid || card.invalidTold || card.invalidRun === undefined || card.invalidRun < 0) return null;", "if (!card.invalid || card.invalidRun === undefined || card.invalidRun < 0) return null;", [...WC, ...BWC]],
  ["W5 takeInvalid tells a worker that could not be told", W, "card.invalidRun === undefined || card.invalidRun < 0) return null;", "card.invalidRun === undefined) return null;", [...WC, ...BWC]],
  ["W6 rebindCard keeps the old streak", W, "  delete card.invalid; delete card.invalidRun; delete card.invalidTold;\n}", "}", WC],
  ["W7 readCards keeps an invalidRun below -1", W, "each.invalidRun >= -1", "each.invalidRun >= -9", WC],
  ["W8 cardContent never lists invalid JSON", W, "    if (wrong) invalid.push(", "    if (false) invalid.push(", [...WC, ...BWC]],
  ["W9 the ordinal has no teens", W, "n % 100 >= 11 && n % 100 <= 13 ?", "false ?", WC],
  ["W10 a clean report keeps the old errors", W, "if (invalid) card.invalid = invalid; else { delete card.invalid; delete card.invalidRun; delete card.invalidTold; }", "if (invalid) card.invalid = invalid;", WC],
  ["W11 the still-wrong warning is not on the card", W, "const warnings = [...content.rejected, ...(invalid ? [", "const warnings = [...content.rejected, ...(false ? [", [...WC, ...BWC]],
  ["K1 a report read at the app's start is validated", WK, "projectCard(this.records, record, atStart ? { ...rules, validate: undefined } : rules)", "projectCard(this.records, record, rules)", BWC],
  ["K2 a held card's worker is never told", WK, "this.passOnCardRequests(drawn); this.tellCardRejections(drawn); this.tellCardInvalid(drawn);", "this.passOnCardRequests(drawn); this.tellCardRejections(drawn);", BWC],
  ["K3 a stale send failure still marks the card", WK, "if (card.taskId !== taskId || !card.invalid) return;", "if (false) return;", BWC],
  ["K4 a failed send leaves the card held", WK, "        card.invalidRun = -1;\n", "", BWC],
  ["K5 a card whose worker started late is not told", WK, "if (worker) { followWorker(card, worker, this.host.cards.cardRules()); this.tellCardInvalid(record); }\n    } catch (error) {\n      card.status = \"failed\";", "if (worker) { followWorker(card, worker, this.host.cards.cardRules()); }\n    } catch (error) {\n      card.status = \"failed\";", BWC],
  ["C1 the card rules check nothing", CARDS, "validate: (name, data) => validateCardShow(name, data, library?.template?.(name)) };", "};", [...CC, ...BWC]],
  ["C2 the card rules ignore the live template", CARDS, "validateCardShow(name, data, library?.template?.(name))", "validateCardShow(name, data)", CC],
  ["MA1 a worker's own name for a new component builds under that name", MAINT, "if (card && bot && !isUnnamedCardAsk(name) && !this.deps.library.names.includes(name)) {", "if (false) {", MT],
  ["MA2 a library component is renamed (not looked up)", MAINT, "!isUnnamedCardAsk(name) && !this.deps.library.names.includes(name)) {", "!isUnnamedCardAsk(name)) {", MT],
  ["MA3 the worker's word is not kept as a hint", MAINT, "      request = `${request}\\n(The worker called it", "      request = `${request}\\n(The worker did not call it", MT],
  ["MA4 the worker's own name stays the ask's name", MAINT, "      name = unnamedCardAsk(request);\n", "", MT],
  ["MA5 a card ask also gets one with no bot (a name from a non-card asker is renamed)", MAINT, "if (card && bot && !isUnnamedCardAsk(name)", "if (card && !isUnnamedCardAsk(name)", MT],
  ["MA6 declined: matplotlib is offered again", MAINT, "Do not draw it yourself, do not force a component to fit, and do not ask again.)", "Draw it with matplotlib if you must.)", MT],
  ["MA7 pin-only: the worker may draw it itself", MAINT, "Do not draw it yourself.)`", "Draw it yourself.)`", MT],
  ["P1 the card head keeps the by-size rule", PROMPTS, "    system = system.replace(REPORT_RULE_BY_SIZE, () => REPORT_RULE_BY_CARD);\n", "", IB],
];

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))) as NodeJS.ProcessEnv;

function build(cwd: string) {
  const r = spawnSync(process.execPath, ["build.mjs"], { cwd, env: env(), encoding: "utf8", timeout: 300_000 });
  return r.status === 0 ? "" : `BUILD FAILED ${r.status}: ${`${r.stdout}\n${r.stderr}`.slice(-800)}`;
}

function runVitest(cwd: string, filters: string[]) {
  const out = join(cwd, "mutant-report.json");
  rmSync(out, { force: true });
  const r = spawnSync(process.execPath, [join(desktop, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--outputFile=${out}`, "--maxWorkers=2", ...filters], { cwd, env: env(), encoding: "utf8", timeout: 900_000 });
  let json: any = null;
  try { json = JSON.parse(readFileSync(out, "utf8")); } catch { /* no report */ }
  const failed: string[] = json ? json.testResults.flatMap((f: any) => f.assertionResults.filter((a: any) => a.status === "failed").map((a: any) => a.title)) : [];
  return { code: r.status, total: json?.numTotalTests ?? 0, failed, files: json?.testResults?.length ?? 0, tail: json ? "" : `${r.stdout}\n${r.stderr}`.slice(-1500) };
}

it("batch mutation check", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-"));
  try {
    cpSync(root, tmp, { recursive: true, filter: (src) => ![".git", "node_modules", "out", "dist", ".bot", "release"].includes(basename(src)) });
    for (const dir of ["desktop", "Web", ""]) if (existsSync(join(root, dir, "node_modules"))) symlinkSync(join(root, dir, "node_modules"), join(tmp, dir, "node_modules"));
    const cwd = join(tmp, "desktop");
    // A patch that does not apply is found first, before any test runs.
    const missing = M.filter(([, file, find]) => readFileSync(join(cwd, file), "utf8").split(find).length - 1 !== 1).map(([name]) => name);
    console.log(`MUTANT patch check: ${missing.length ? `PATCH FAILED for ${missing.join(" | ")}` : "all patches apply once"}`);
    const built = build(cwd);
    const base = runVitest(cwd, ALL);
    console.log(`MUTANT baseline(copy): ${built || "built"}, exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")}${base.tail}`);
    if (base.code !== 0 || base.failed.length || base.files < ALL.length) throw new Error("baseline in the copy does not pass: mutation results void");
    const originals = new Map<string, string>();
    for (const [name, file, find, replace, filters] of M) {
      const target = join(cwd, file);
      if (!originals.has(file)) originals.set(file, readFileSync(target, "utf8"));
      const original = originals.get(file)!;
      const n = original.split(find).length - 1;
      if (n !== 1) { console.log(`MUTANT ${name}: PATCH FAILED (found ${n}x)`); continue; }
      writeFileSync(target, original.replace(find, () => replace));
      const failedBuild = build(cwd);
      const r = failedBuild ? { code: -1, total: 0, failed: [] as string[], files: 0, tail: failedBuild } : runVitest(cwd, filters);
      writeFileSync(target, original);
      const verdict = r.total === 0 ? "NOT EVALUATED" : r.failed.length ? "KILLED" : r.code === 0 ? "SURVIVED" : "KILLED(exit only)";
      console.log(`MUTANT ${name}: ${verdict} (${r.total} tests, failed ${r.failed.length}: ${r.failed.slice(0, 3).join(" | ")})${r.tail}`);
    }
    build(cwd);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 3_300_000);
