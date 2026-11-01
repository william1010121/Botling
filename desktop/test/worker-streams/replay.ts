// Replays recorded worker streams (test/fixtures/worker-streams/<engine>/<scenario>.jsonl) into an engine adapter for
// the shared worker core's contract suite (shared-core spec §5.2). The fixtures come from the real CLIs
// (test/record/record-worker-streams.test.ts, scrubbed by scripts/scrub-worker-streams.mjs).
//
// A fixture file is a header line, then one line per stream line of one process:
//   {"t": <ms since the scenario started>, "d": "in" | "out" | "err" | "exit", "l": "<raw line>"}
// "in": app → CLI, "out": CLI → app, "err": stderr (none for Antigravity: it can hold OAuth URLs), "exit": the process
// closed ({"code","signal"} as JSON). A scenario with several processes (multiple-workers) has one file per process,
// <scenario>-1.jsonl, <scenario>-2.jsonl, …, on one clock. <scenario>.expect.json beside it was checked by hand.
//
// This file only loads fixtures and checks expectations; feeding them into an adapter and the core (ReplayResult) comes
// with the core's types (S0). Each engine's registration, test/worker-streams/adapter-<engine>.ts, is its slice's.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexItem } from "../../src/core/agent/codex";

export const FIXTURES = join(__dirname, "..", "fixtures", "worker-streams");

export type Direction = "in" | "out" | "err" | "exit";
export interface StreamLine { t: number; d: Direction; l: string }
export interface FixtureHeader { engine: string; cli: string; recordedAt: string; scenario: string; process: number; command: string; args: string[] }

/**
 * What a scenario's recording is known to show (hand-checked). Every field is optional; a string field that starts with
 * "^" is a regular expression, ">=N" / "<=N" a bound, anything else must be equal.
 */
export interface Expectation {
  /** The run's status under the core's rules (classifyRun): done | failed | stopped | interrupted. */
  status?: string;
  /** Where its report is afterwards: none | pending | … (status.ts ReportState). */
  reportState?: string;
  /** The report text (regex with "^"). */
  report?: string;
  /** Text blocks the worker wrote (whole messages, never chunks). */
  textBlocks?: number | string;
  /** Tool calls, and those whose result failed. */
  tools?: number | string;
  failedTools?: number | string;
  /** Finished model requests (tok/s samples). */
  requests?: number | string;
  /** The output counter, with <conv> for the worker's conversation id. */
  counter?: string;
  /** Workers in the scenario (multiple-workers: one per process for Claude, Antigravity and the editor). */
  workers?: number;
  /** How the process ended, as recorded: "exit 0", "signal SIGKILL", "exit 143", "running" (still alive at the end). */
  process?: string;
  /** What else is worth knowing about this recording (not checked). */
  notes?: string;
  [key: string]: unknown;
}

export interface Fixture { engine: string; scenario: string; header: FixtureHeader; lines: StreamLine[]; expect: Expectation }

function parse(file: string): { header: FixtureHeader; lines: StreamLine[] } {
  const [first, ...rest] = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (!first) throw new Error(`Empty fixture ${file}.`);
  return { header: JSON.parse(first) as FixtureHeader, lines: rest.map((line) => JSON.parse(line) as StreamLine) };
}

function expectation(engine: string, scenario: string): Expectation {
  const file = join(FIXTURES, engine, `${scenario}.expect.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Expectation : {};
}

/** The scenarios recorded for an engine (several-process scenarios once). */
export function fixtureScenarios(engine: string): string[] {
  const folder = join(FIXTURES, engine);
  if (!existsSync(folder)) return [];
  return [...new Set(readdirSync(folder).filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/(-\d+)?\.jsonl$/, "")))].sort();
}

/** A scenario's processes, in order (one for most scenarios). */
export function loadFixtures(engine: string, scenario: string): Fixture[] {
  const folder = join(FIXTURES, engine);
  const single = join(folder, `${scenario}.jsonl`);
  const files = existsSync(single) ? [single]
    : readdirSync(folder).filter((name) => new RegExp(`^${scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.jsonl$`).test(name))
      .sort((a, b) => Number(/-(\d+)\.jsonl$/.exec(a)![1]) - Number(/-(\d+)\.jsonl$/.exec(b)![1])).map((name) => join(folder, name));
  if (!files.length) throw new Error(`No fixture ${engine}/${scenario}.`);
  const expect = expectation(engine, scenario);
  return files.map((file) => ({ engine, scenario, ...parse(file), expect }));
}

/** A single-process scenario. */
export function loadFixture(engine: string, scenario: string): Fixture {
  const fixtures = loadFixtures(engine, scenario);
  if (fixtures.length !== 1) throw new Error(`${engine}/${scenario} has ${fixtures.length} processes: use loadFixtures.`);
  return fixtures[0]!;
}

/** The lines the CLI wrote, in order. */
export const outLines = (fixture: Fixture): string[] => fixture.lines.filter((line) => line.d === "out").map((line) => line.l);

/** How the process ended (null: the recording ends with it still running). */
export function exitOf(fixture: Fixture): { code: number | null; signal: string | null } | null {
  const exit = fixture.lines.find((line) => line.d === "exit");
  return exit ? JSON.parse(exit.l) : null;
}

/** The stderr the process wrote (what an adapter would hand on for "exited"). */
export const stderrOf = (fixture: Fixture): string => fixture.lines.filter((line) => line.d === "err").map((line) => line.l).join("\n");

/** Several processes' lines on their one clock (multiple-workers), each tagged with its process's index. */
export function interleave(fixtures: Fixture[]): (StreamLine & { process: number })[] {
  return fixtures.flatMap((fixture, process) => fixture.lines.map((line) => ({ ...line, process })))
    .sort((a, b) => a.t - b.t || a.process - b.process);
}

/** The CLI version a fixture was recorded with differs from the one installed: the suite only warns (spec §5.1). */
export function versionWarning(fixture: Fixture, installed: string | null): string | null {
  return installed && installed !== fixture.header.cli ? `${fixture.engine}/${fixture.scenario} was recorded with ${fixture.header.cli}; installed: ${installed}.` : null;
}

/** Whether one observed value meets one expectation value (see Expectation). */
export function meets(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "number") {
    const bound = /^(>=|<=)\s*(\d+)$/.exec(expected);
    if (bound) return bound[1] === ">=" ? actual >= Number(bound[2]) : actual <= Number(bound[2]);
  }
  if (typeof expected === "string" && expected.startsWith("^") && typeof actual === "string") return new RegExp(expected, "s").test(actual);
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** The expectation's fields that the observed values do not meet (fields not observed are skipped; `notes` never counts). */
export function unmet(expect: Expectation, observed: Record<string, unknown>): string[] {
  return Object.entries(expect).filter(([key, value]) => key !== "notes" && key in observed && !meets(value, observed[key]))
    .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(observed[key])}`);
}

/** What replaying a scenario through an adapter and the core gives (spec §5.2). `ledger` is WorkerLedgerRecord[] once S0 lands. */
export interface ReplayResult { items: CodexItem[]; ledger: unknown[]; delivered: { id: string; text: string }[] }
