// Replays head streams (test/fixtures/head-streams/<engine>/<scenario>.jsonl) through an engine's REAL head class
// (ClaudeHead, CodexHead, AgyAcpHead) on a fake transport, for the head contract suite (test/unit/head-contract.test.ts;
// provider-layer plan §9 step 7, the safety net for the HeadSession interface of step 8). It is the head-side twin of
// test/worker-streams/replay.ts and reads the same line format.
//
// ── A fixture ────────────────────────────────────────────────────────────────────────────────────────────────────────
// A header line, then one line per event on one clock:
//   {"t": <ms>, "d": "act" | "in" | "out" | "err" | "exit", "l": <raw line, or the same as a JSON object>}
// "out": CLI → head (fed to the head as its process's stdout); "in": what the head wrote when it was recorded (not fed:
// compared with what the head writes now); "exit": the process closed ({"code","signal"}); "act": what the Bot asks the
// head to do at that point ({"op": "start" | "send" | "steer" | "interrupt" | "answer" | "finish", …}, see `Act`).
//
// The header says where the stream comes from (`source`):
// - "recorded": the CLI's own output. Most are worker recordings (test/fixtures/worker-streams, recorded from the real
//   CLIs by test/record/record-worker-streams.test.ts): a worker IS a head process speaking the same protocol (Claude:
//   ClaudeHead itself; Antigravity: AgyAcpProtocol; Codex: the coordinator thread of the same app-server). Such a
//   fixture is only a header: `from` names the recording, and `acts` put the Bot's calls in, each before the recorded
//   line it caused (`before`: a regular expression on the recorded "in" lines; none: at the start). A `send` without
//   `text` sends the words of the recorded write `textFrom` matches, so a re-recording carries its own prompt; it goes
//   at the start, as the Bot sends right after starting a head (each head holds it until its handshake is done).
// - "recorded" with a body: recorded CLI lines cut to one scenario (Codex: test/fixtures/codex-recordings.json), the acts
//   and the head's expected writes put in by hand.
// - "synthetic": written from the protocol code (agent/stream.ts, agent/codex.ts, agent/agy-acp.ts) where no recording
//   has the case (an interrupt of a Claude turn, a steer, a failed turn, …), on a recorded handshake. `notes` says which
//   lines are recorded. Both kinds with a body are written by test/head-streams/write-fixtures.mjs.
// <scenario>.expect.json beside it holds what the Bot must see (`HeadExpectation`, hand-checked).
//
// ── Writing an engine's registration (test/head-streams/adapter-<engine>.ts) ──────────────────────────────────────────
// `create` builds the engine's real head with only its process replaced (`HeadTransport`): lines the CLI wrote go to
// the head as its stdout, what the head writes is kept (`writes`), and a response to a request is held until the head
// has asked that request, then carries the head's own request id (`deliver`). Everything else, protocol parsing and
// the StreamItems the Bot gets, is the head's own code.
//
// Time is collapsed: lines are fed in order, a few macrotasks apart (heads await their own handshakes in between).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexItem } from "../../src/core/agent/codex";
import type { HeadExit } from "../../src/core/agent/head";
import type { StreamItem } from "../../src/core/agent/stream";
import { headTurnContent, headTurnEnd } from "../../src/core/head-turn";
import { parseHeadTags, type Engine } from "../../src/core/heads";
import { parseReply } from "../../src/core/reply";
import { hasVisibleContent, ReplyText } from "../../src/core/worker-core";

export const FIXTURES = join(__dirname, "..", "fixtures", "head-streams");
const WORKER_FIXTURES = join(__dirname, "..", "fixtures", "worker-streams");

// ------------------------------------------------------------------------------------------------
// Fixtures

export type Act =
  | { op: "start" }
  /** The user's message (a turn of its own). `text` absent: the words of the recorded line the act is anchored on. */
  | { op: "send"; text?: string; uuid?: string }
  /** The user's message while a turn runs: what the Bot does for this engine (Claude: send with its uuid; Codex: steer; Antigravity: send, which queues). */
  | { op: "steer"; text: string; uuid?: string }
  | { op: "interrupt" }
  /** The user's answer to the latest open permission request of the head's own. */
  | { op: "answer"; allow: boolean; message?: string }
  | { op: "finish" };
/** `before`: put in before the nth recorded write it matches (none: at the start); `textFrom`: a send's words are those of the first recorded write it matches. */
export type AnchoredAct = Act & { before?: string; nth?: number; textFrom?: string };

export type Direction = "act" | "in" | "out" | "err" | "exit";
export interface HeadLine { t: number; d: Direction; l: string }
export interface HeadHeader {
  engine: Engine; scenario: string; source: "recorded" | "synthetic";
  /** The recording this fixture replays: "<engine>/<scenario>" under test/fixtures/worker-streams. */
  from?: string;
  acts?: AnchoredAct[];
  cli?: string;
  notes?: string;
}

/**
 * What the Bot sees of a scenario, in one format for every engine. Every field is optional; a per-turn field is a value
 * (every finished turn) or an array (each in order). A string that starts with "^" is a regular expression, ">=N" /
 * "<=N" a bound, anything else must be equal.
 */
export interface HeadExpectation {
  /** The head reported its session (`init`). */
  init?: boolean;
  /** Turns that ended (a result the Bot took), and how: done | failed (headTurnEnd), the error it shows, its reply. */
  turns?: number;
  status?: string | string[];
  error?: string | string[];
  reply?: string | string[];
  /** Whether the ended turn gets a bubble (headTurnContent → hasVisibleContent). */
  bubble?: boolean | boolean[];
  /** Steps the turn showed (tools and Codex commentary), and the failed ones. */
  steps?: number | string | (number | string)[];
  failedSteps?: number | number[];
  /** Turns the head started itself (a background turn: Codex's report turn, …). */
  background?: number;
  /** A turn still open when the stream ended (the head went away mid-turn). */
  openTurn?: boolean;
  /** The head's own permission requests, and those it took back. */
  permissions?: number;
  permissionsCancelled?: number;
  /** usage items; the output tokens they add up to. */
  usage?: number | string;
  outputTokens?: number | string;
  /** Finished model requests (token speed). */
  requests?: number | string;
  /** The steer act's answer (Claude: no answer, true; Codex: steer()'s; Antigravity: queued, true). */
  steered?: boolean;
  /** Write kinds (the registration's `writeKind`) the head must have written, in this order among its writes. */
  writes?: string[];
  /** How the process ended for the Bot: "expected" | "unexpected" | "none" (still running). */
  exit?: string;
  /** Items the head handed to the worker sink (Codex: its workers' threads). */
  workerItems?: number | string;
  notes?: string;
}

export interface HeadFixture { engine: Engine; scenario: string; header: HeadHeader; lines: HeadLine[]; expect: HeadExpectation }

const raw = (l: unknown): string => (typeof l === "string" ? l : JSON.stringify(l));

function parseFile(file: string): { header: HeadHeader; lines: HeadLine[] } {
  const [first, ...rest] = readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
  if (!first) throw new Error(`Empty fixture ${file}.`);
  return { header: JSON.parse(first), lines: rest.map((line) => { const x = JSON.parse(line); return { t: x.t, d: x.d, l: raw(x.l) }; }) };
}

/** A recording's lines with the header's acts put in before the lines they caused. */
function withActs(lines: HeadLine[], acts: AnchoredAct[], file: string): HeadLine[] {
  const out = [...lines];
  const placed: { at: number; act: AnchoredAct }[] = acts.map((act) => {
    if (!act.before) return { at: 0, act };
    const pattern = new RegExp(act.before);
    let seen = 0;
    const at = out.findIndex((line) => line.d === "in" && pattern.test(line.l) && ++seen === (act.nth ?? 1));
    if (at < 0) throw new Error(`${file}: no recorded write matches ${act.before} (nth ${act.nth ?? 1}).`);
    return { at, act };
  });
  // From the last place back, so earlier indexes stay put; acts at one place keep their order.
  for (let i = placed.length - 1; i >= 0; i--) {
    const { at, act } = placed[i]!;
    const { before, nth, textFrom, ...bare } = act;
    const anchor = before ? out[at]! : null;
    const source = textFrom ? out.find((line) => line.d === "in" && new RegExp(textFrom).test(line.l)) : anchor;
    if (textFrom && !source) throw new Error(`${file}: no recorded write matches ${textFrom}.`);
    if (bare.op === "send" && bare.text === undefined && source) (bare as { anchor?: string }).anchor = source.l;
    out.splice(at, 0, { t: anchor?.t ?? 0, d: "act", l: JSON.stringify(bare) });
  }
  return out;
}

export function headScenarios(engine: string): string[] {
  const folder = join(FIXTURES, engine);
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/\.jsonl$/, "")).sort() : [];
}

export function loadHeadFixture(engine: Engine, scenario: string): HeadFixture {
  const file = join(FIXTURES, engine, `${scenario}.jsonl`);
  const { header, lines } = parseFile(file);
  let body = lines;
  if (header.from) {
    const recorded = parseFile(join(WORKER_FIXTURES, `${header.from}.jsonl`));
    body = withActs(recorded.lines, header.acts ?? [], file);
    header.cli ??= (recorded.header as unknown as { cli?: string }).cli;
  }
  const expectFile = join(FIXTURES, engine, `${scenario}.expect.json`);
  const expect = existsSync(expectFile) ? JSON.parse(readFileSync(expectFile, "utf8")) as HeadExpectation : {};
  return { engine, scenario, header, lines: body, expect };
}

// ------------------------------------------------------------------------------------------------
// The registration

export interface HeadSink {
  item(item: CodexItem): void;
  /** Items for the Bot's worker entry, not the chat (Codex's workerSink). */
  worker(item: CodexItem): void;
  exit(exit: HeadExit): void;
}

/** The real head on a fake process. */
export interface HeadTransport {
  start(): void;
  send(text: string, uuid: string): void;
  /** What the Bot does with a message while this engine's turn runs; the head's answer where it gives one. */
  steer(text: string, uuid: string): boolean | void;
  interrupt(): void;
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): void;
  finish(): void;
  /** One line from the CLI. A response waits until the head has asked its request; false: it never did. */
  deliver(line: string): Promise<boolean>;
  /** The process ended. */
  exit(code: number | null, signal: string | null): void;
  /** Everything the head wrote to the CLI, parsed. */
  readonly writes: unknown[];
  /** Ends whatever is left (timers, the process) after the replay. */
  dispose(): Promise<void>;
}

export interface HeadRegistration {
  engine: Engine;
  label: string;
  create(fixture: HeadFixture, sink: HeadSink): HeadTransport;
  /** The words of a recorded message the app sent (a `send` act anchored on it). */
  sentText(line: string): string;
  /** Whether a message while a turn runs joins that turn (Claude, Codex: the Bot steers) or waits for a turn of its own (Antigravity: caps.steerHeadTurn off). */
  steersTurn: boolean;
  /** What kind of write a message is ("user", "turn/steer", "response", …), to compare the head's writes with the recording's; null: not compared. */
  writeKind(message: any): string | null;
}

// ------------------------------------------------------------------------------------------------
// The JSON-RPC answering both Codex and Antigravity need

/**
 * Answers a recorded JSON-RPC response to the head's own request: the recorded id's method and its place among the
 * recording's requests of that method name the head's request it answers (heads number their own requests).
 */
export class RpcAnswers {
  private recorded = new Map<unknown, { method: string; index: number }>();
  constructor(fixture: HeadFixture, private writes: () => unknown[]) {
    const perMethod = new Map<string, number>();
    for (const line of fixture.lines) {
      if (line.d !== "in") continue;
      const m = JSON.parse(line.l);
      if (typeof m.method !== "string" || m.id === undefined) continue;
      const index = perMethod.get(m.method) ?? 0;
      this.recorded.set(m.id, { method: m.method, index });
      perMethod.set(m.method, index + 1);
    }
  }

  /** Whether a line is a response to a request of the app's (not a server request, not a notification). */
  static isResponse(m: any): boolean { return m && typeof m === "object" && !m.method && m.id !== undefined && ("result" in m || "error" in m); }

  /** The response with the head's own id, once the head has asked it (null: it never asked within `rounds`). */
  async answer(m: any, rounds = 60): Promise<any | null> {
    const asked = this.recorded.get(m.id);
    if (!asked) return null;
    for (let round = 0; round < rounds; round++) {
      const ours = (this.writes() as any[]).filter((w) => w?.method === asked.method && w.id !== undefined)[asked.index];
      if (ours) return { ...m, id: ours.id };
      await macrotask();
    }
    return null;
  }
}

export const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
export async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) await macrotask(); }

// ------------------------------------------------------------------------------------------------
// What the Bot sees: its turn bookkeeping (bot.ts onItem / finishTurn) for one head, through the shared pieces it uses

interface Step { id: string; failed: boolean }
interface ViewTurn { origin: "user" | "background"; reply: ReplyText; steps: Step[]; ended?: { status: string; error: string; reply: string; bubble: boolean } }

export class BotView {
  readonly items: CodexItem[] = [];
  readonly workerItems: CodexItem[] = [];
  readonly turns: ViewTurn[] = [];
  private open: ViewTurn | null = null;
  private waiting: ViewTurn[] = [];
  exit: HeadExit | null = null;
  steered: boolean | undefined;

  constructor(private engine: Engine, private drop: (item: CodexItem) => boolean = () => false) {}

  private turn(origin: ViewTurn["origin"]): ViewTurn {
    const turn: ViewTurn = { origin, reply: new ReplyText(), steps: [] };
    this.turns.push(turn);
    return turn;
  }

  /** The user's message: a turn now, or once the one under way ends (the Bot's queue). */
  sent() {
    const turn: ViewTurn = { origin: "user", reply: new ReplyText(), steps: [] };
    if (this.open) this.waiting.push(turn);
    else { this.turns.push(turn); this.open = turn; }
  }

  item(item: CodexItem) {
    if (this.drop(item)) return;
    this.items.push(item);
    const kind = item.kind;
    if (["workerReport", "measurementDispatch", "request", "measurement", "init", "controlResponse", "usage", "rateLimits", "command",
      "permission", "permissionCancelled", "permissionDenied", "managedPending", "monitorState", "connectionTrouble", "apiRetry", "routinesChanged"].includes(kind)) return;
    if ((item as { parent?: string | null }).parent) return; // a subagent's line
    if (kind === "backgroundTurn") { if (!this.open) this.open = this.turn("background"); return; }
    let turn = this.open;
    if (!turn) {
      // Nothing of ours under way: the head started a turn itself (bot.ts backgroundTurn).
      if (kind === "result" && !(item as { text?: string }).text) return;
      if (kind === "textBlock") return;
      turn = this.open = this.turn("background");
    }
    switch (kind) {
      case "stepText": turn.steps.push({ id: `text:${turn.steps.length}`, failed: false }); return;
      case "toolUse": turn.steps.push({ id: (item as { id: string }).id, failed: false }); return;
      case "toolResult": {
        const step = turn.steps.find((s) => s.id === (item as { id: string }).id);
        if (step) step.failed = (item as { failed: boolean }).failed;
        return;
      }
      case "result": {
        const result = item as Extract<StreamItem, { kind: "result" }>;
        if (result.ok) turn.reply.add(result);
        const end = headTurnEnd(result, turn.reply.text, this.engine);
        const raw = turn.reply.text;
        const parsed = parseReply(raw);
        const tags = end.status === "done" ? parseHeadTags(parsed.body) : { body: parsed.body, handoff: null };
        const content = headTurnContent({ status: end.status, origin: turn.origin, sharesChat: false, raw, parsed, body: tags.body, handoff: !!tags.handoff, steps: turn.steps.length, error: end.error ?? null });
        turn.ended = { status: end.status, error: end.error ?? "", reply: tags.body, bubble: hasVisibleContent(content) };
        this.open = null;
        const next = this.waiting.shift();
        if (next) { this.turns.push(next); this.open = next; }
        return;
      }
      default: turn.reply.add(item as StreamItem);
    }
  }

  /** The scenario in the shared format (HeadExpectation's fields). */
  observed(writes: string[]): Record<string, unknown> {
    const ended = this.turns.filter((turn) => turn.ended);
    const of = (kind: string) => this.items.filter((item) => item.kind === kind) as any[];
    const usage = of("usage");
    return {
      init: of("init").length > 0,
      turns: ended.length,
      status: ended.map((turn) => turn.ended!.status),
      error: ended.map((turn) => turn.ended!.error),
      reply: ended.map((turn) => turn.ended!.reply),
      bubble: ended.map((turn) => turn.ended!.bubble),
      steps: ended.map((turn) => turn.steps.length),
      failedSteps: ended.map((turn) => turn.steps.filter((step) => step.failed).length),
      background: this.turns.filter((turn) => turn.origin === "background").length,
      openTurn: this.turns.some((turn) => !turn.ended),
      permissions: of("permission").filter((item) => !item.workerId).length,
      permissionsCancelled: of("permissionCancelled").length,
      usage: usage.length,
      outputTokens: usage.reduce((sum, item) => sum + (item.tokens?.output ?? 0), 0),
      requests: of("request").length,
      steered: this.steered,
      writes,
      exit: this.exit ? (this.exit.expected ? "expected" : "unexpected") : "none",
      workerItems: this.workerItems.length,
    };
  }
}

// ------------------------------------------------------------------------------------------------
// Replay

export interface HeadReplay {
  view: BotView;
  transport: HeadTransport;
  /** Response lines the head never asked for (the recording and the head disagree). */
  unanswered: string[];
  /** Write kinds the recording shows the head wrote and the head did not write now, in order. */
  missingWrites: string[];
  /** The head's writes as kinds, in order. */
  writes: string[];
  observed: Record<string, unknown>;
}

export interface HeadReplayOptions {
  /** Items dropped before the Bot sees them (HEAD_CONTRACT_BUG). */
  drop?: (item: CodexItem) => boolean;
}

/** Plays a fixture through a registration: acts become head calls, "out" lines its stdout, "exit" its process's end. */
export async function replayHead(registration: HeadRegistration, fixture: HeadFixture, options: HeadReplayOptions = {}): Promise<HeadReplay> {
  const view = new BotView(fixture.engine, options.drop);
  // What the head says while the replay ends it (dispose) is not the scenario's.
  let disposing = false;
  const transport = registration.create(fixture, {
    item: (item) => { if (!disposing) view.item(item); },
    worker: (item) => { if (!disposing) view.workerItems.push(item); },
    exit: (exit) => { if (!disposing) view.exit = exit; },
  });
  const unanswered: string[] = [];
  let uuids = 0;
  const uuid = (given?: string) => given ?? `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;
  try {
    for (const line of fixture.lines) {
      if (line.d === "act") {
        const act = JSON.parse(line.l) as Act & { anchor?: string };
        switch (act.op) {
          case "start": transport.start(); break;
          case "send": view.sent(); transport.send(act.text ?? registration.sentText(act.anchor ?? ""), uuid(act.uuid)); break;
          case "steer": {
            if (!registration.steersTurn) view.sent();
            const answer = transport.steer(act.text, uuid(act.uuid));
            view.steered = answer === undefined ? true : answer;
            break;
          }
          case "interrupt": transport.interrupt(); break;
          case "answer": {
            const open = view.items.filter((item): item is Extract<StreamItem, { kind: "permission" }> => item.kind === "permission" && !item.workerId).at(-1);
            if (!open) throw new Error(`${fixture.engine}/${fixture.scenario}: an answer act with no permission request open.`);
            transport.answer(open.requestId, act.allow, open.input, act.message);
            break;
          }
          case "finish": transport.finish(); break;
        }
        await settle();
      } else if (line.d === "out") {
        if (!await transport.deliver(line.l)) unanswered.push(line.l);
        await settle(2);
      } else if (line.d === "exit") {
        const exit = JSON.parse(line.l) as { code: number | null; signal: string | null };
        transport.exit(exit.code, exit.signal);
        await settle();
      }
    }
    await settle(8);
  } finally {
    disposing = true;
    await transport.dispose();
  }
  const kinds = (messages: unknown[]) => messages.map((m) => registration.writeKind(m)).filter((kind): kind is string => !!kind);
  const writes = kinds(transport.writes);
  const recorded = kinds(fixture.lines.filter((line) => line.d === "in").map((line) => JSON.parse(line.l)));
  const missingWrites: string[] = [];
  let at = 0;
  for (const kind of recorded) {
    const found = writes.indexOf(kind, at);
    if (found < 0) missingWrites.push(kind); else at = found + 1;
  }
  return { view, transport, unanswered, missingWrites, writes, observed: view.observed(writes) };
}

// ------------------------------------------------------------------------------------------------
// Expectations

function meets(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "number") {
    const bound = /^(>=|<=)\s*(\d+)$/.exec(expected);
    if (bound) return bound[1] === ">=" ? actual >= Number(bound[2]) : actual <= Number(bound[2]);
  }
  if (typeof expected === "string" && expected.startsWith("^") && typeof actual === "string") return new RegExp(expected, "s").test(actual);
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** `writes`: the expected kinds appear among the head's writes in this order (other writes may come between). */
function inOrder(expected: string[], actual: string[]): boolean {
  let at = 0;
  for (const kind of expected) { const found = actual.indexOf(kind, at); if (found < 0) return false; at = found + 1; }
  return true;
}

/** The expectation's fields the observed scenario does not meet (`notes` never counts). */
export function unmetHead(expect: HeadExpectation, observed: Record<string, unknown>): string[] {
  const failures: string[] = [];
  for (const [key, expected] of Object.entries(expect)) {
    if (key === "notes" || !(key in observed)) continue;
    const actual = observed[key];
    let ok: boolean;
    if (key === "writes") ok = inOrder(expected as string[], actual as string[]);
    else if (Array.isArray(actual) && !["writes"].includes(key)) {
      // A per-turn field: one value for every ended turn, or one per turn.
      ok = Array.isArray(expected)
        ? expected.length === actual.length && expected.every((value, i) => meets(value, actual[i]))
        : actual.length > 0 && actual.every((value) => meets(expected, value));
    } else ok = meets(expected, actual);
    if (!ok) failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return failures;
}
