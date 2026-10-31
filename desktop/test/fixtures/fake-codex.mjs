#!/usr/bin/env node
// A stand-in for `codex app-server` (codex-cli 0.163.0's JSON-RPC on stdio, one object a line),
// for tests and `npm run dev:fake`. It speaks the part of the protocol Botling uses: initialize,
// thread/start|resume|inject_items, turn/start|steer|interrupt, item notifications, approval
// requests (item/commandExecution/requestApproval) and the app's dynamic tools (item/tool/call:
// app_handoff, app_task_checkpoint). The first thread started with dynamic tools is the
// coordinator; threads started without them are app-managed workers.
//
// What a coordinator turn does, from a directive at the start of its last paragraph that is not an
// app note ("(App: …"):
//   (none)          — final answer "Codex says: <words>"
//   /say <text>     — final answer exactly <text> (a hand-off tag, a choices block, …)
//   /slow           — commentary until interrupted
//   /tool <command> — asks to run <command>; says whether it was allowed
//   /component-editor <task> — hands <task> to Maintainer's Claude component editor
//   /worker <task>  — hands <task> to an app-managed worker (app_handoff) and ends its turn
//   /choices        — asks with a <choices> block
//   /monitor <cmd>  — asks the app to run <cmd> as a monitored command (app_monitor_start) and ends its turn;
//                     the app's app_monitor_result wakes it: "Monitor <status>, exit <code>: <stdout>"
//   /routine <json> — calls app_routines with <json> as its arguments; says the result
//   /ratelimit <text> — the API answers 429: as codex 0.163.0 does, it logs its retry to
//                     $CODEX_HOME/logs_2.sqlite (if that file is there; "1/5 in 40s") and sends an
//                     `error` with willRetry, then waits for FAKE_CODEX_RETRY_GATE=<file> (or
//                     FAKE_CODEX_TURN_MS), says "Retried." as commentary, waits for <file>.done
//                     and answers exactly <text>
// command/exec runs the command for real (in its cwd, through the shell it names); command/exec/terminate ends it.
// A report turn (an app_task_result tool output) records a checkpoint and says what the worker
// reported ("…/nocheckpoint" in the report: it records none). The tidy note hands the memory file
// to a worker, which writes it; its report turn says OK.
// Work the other head (Claude) hands over is answered "Did it: <task>" ("/say …": exactly that;
// "/handoff:claude <task>": it hands <task> on), a
// hand-back "Done: <its reply>" ("/slow …" as the task: commentary until interrupted or steered, then
// "Answered you: <the steered words>"; the app's "(App: Now carry on…" note: "Carried on: finished the
// handed work."); "/solo <words>": with two heads, the head that hears the other's
// words first says only <no-reply/>.
// A worker's task: "/slowworker" runs until interrupted; "/failworker" fails; else it reports
// "Worker did: <first line>" after FAKE_CODEX_WORKER_MS (default 300), or — FAKE_CODEX_WORKER_GATE=<file>
// — once that file exists (a test opens the gate when it has seen the worker at work).
// FAKE_CODEX_INPUT: a file it appends {thread, kind, text} to for every turn input and steer.
// FAKE_CODEX_LOG: a file it appends {pid, args, cwd} to per start.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { safeWritePath } from "./safe-write.mjs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

// `codex exec` as Catch-up runs it: reads the selected messages from the prompt and writes 1–3
// bullets citing them to --output-last-message, with --json events on stdout. FAKE_CODEX_EXEC_LOG:
// a file it appends its arguments to; FAKE_CODEX_EXEC_FAIL=1: exits 1; FAKE_CODEX_EXEC_MS: takes that long.
if (process.argv[2] === "exec") {
  const args = process.argv.slice(3);
  const flag = (name) => args[args.indexOf(name) + 1];
  if (process.env.FAKE_CODEX_EXEC_LOG) appendFileSync(process.env.FAKE_CODEX_EXEC_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CODEX_EXEC_MS ?? 20)));
  if (process.env.FAKE_CODEX_EXEC_FAIL === "1") { process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "fake failure" } }) + "\n"); process.exit(1); }
  const prompt = args.at(-1) ?? "";
  const sources = [...prompt.matchAll(/^\[source:([0-9A-F-]{36})\] ([^:\n]+): (.*)$/gm)].slice(-3);
  const bullets = sources.length ? sources.map((m) => `${m[2]}: ${m[3].slice(0, 60)} [[source:${m[1]}]]`) : ["Nothing to say."];
  writeFileSync(flag("--output-last-message"), JSON.stringify({ bullets }));
  for (const event of [{ type: "thread.started", thread_id: "fake" }, { type: "turn.started" }, { type: "item.completed", item: { id: "i0", type: "agent_message", text: JSON.stringify({ bullets }) } }, { type: "turn.completed", usage: {} }]) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  process.exit(0);
}

const inputLog = process.env.FAKE_CODEX_INPUT;
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd() }) + "\n");
const workerMs = Number(process.env.FAKE_CODEX_WORKER_MS ?? 300);
const workerGate = process.env.FAKE_CODEX_WORKER_GATE;

const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (thread, kind, text) => { if (inputLog) appendFileSync(inputLog, JSON.stringify({ thread, kind, text }) + "\n"); };

const threads = new Map(); // id → { coordinator, instructions, turn: {id, interrupted, steers} | null }
let coordinatorSeen = false;
let nextServerId = 0;
const waiting = new Map(); // server request id → resolve
let closed = false;
const execs = new Map(); // processId → child

const notify = (method, params) => out({ method, params });
const item = (thread, turn, phase, value) => notify(`item/${phase}`, { threadId: thread, turnId: turn, item: value });
function say(thread, turn, text, phase = "final_answer") {
  const id = `msg_${randomUUID().slice(0, 8)}`;
  item(thread, turn, "started", { type: "agentMessage", id, text: "", phase });
  item(thread, turn, "completed", { type: "agentMessage", id, text, phase });
}
function ask(method, params) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    out({ method, id, params });
  });
}
// FAKE_CODEX_USAGE=1 (Phase 5c): each turn's thread reports its running token total, and the account its limits.
const tokenTotals = new Map();
function complete(thread, turn, status = "completed", error = null) {
  const state = threads.get(thread);
  if (state?.turn?.id === turn) state.turn = null;
  if (process.env.FAKE_CODEX_USAGE === "1") {
    const total = tokenTotals.get(thread) ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    total.inputTokens += 2000; total.cachedInputTokens += 1500; total.outputTokens += 250;
    tokenTotals.set(thread, total);
    notify("thread/tokenUsage/updated", { threadId: thread, turnId: turn, tokenUsage: { total: { ...total, totalTokens: total.inputTokens + total.outputTokens }, last: total } });
    const now = Math.floor(Date.now() / 1000);
    notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: now + 4 * 3600 }, secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: now + 5 * 86400 } } });
  }
  notify("turn/completed", { threadId: thread, turn: { id: turn, status, error, items: [] } });
}

/** The user's words in a message the app wrote around them, and the paragraph a directive is read from. */
function words(text) {
  const mine = text.split("\n\n").filter((part) => !part.startsWith("(App: ") && !part.startsWith("(I sent this in parts") && !part.startsWith("(Replying to "));
  return { all: mine.join("\n\n"), last: mine.at(-1) ?? "" };
}

/** Handed-over work ("/slow …" as the task) that works until it is interrupted or the user steers in. */
const SLOW_HANDED = "\u0000slow";
/** Handed-over work ("/worker <task>" as the task) that an app-managed worker does. */
const WORKER_HANDED = "\u0000worker ";

/** What it answers to work the other head handed over, or to its hand-back (null: neither). */
function conductedReply(prompt) {
  const handed = /\(App: (?:Claude|Codex), this bot's other head, (?:hands you this|asks you to review this|wants your view on this) \(hand-off \d+ of \d+ for the user's latest message\):\n([\s\S]*?)\n\nDo it, then reply/.exec(prompt);
  if (handed) {
    const on = /^\/handoff:(claude|codex) ([\s\S]*)$/.exec(handed[1]);
    if (on) return `Over to you. <handoff to="${on[1]}">${on[2]}</handoff>`;
    if (handed[1].startsWith("/slow")) return SLOW_HANDED;
    if (handed[1].startsWith("/worker ")) return WORKER_HANDED + handed[1].slice(8);
    return handed[1].startsWith("/say ") ? handed[1].slice(5) : `Did it: ${handed[1]}`;
  }
  const back = /\(App: (?:Claude|Codex) finished what you handed over\. Its reply:\n([\s\S]*?)\n\nCarry on from there/.exec(prompt);
  if (back) return back[1].startsWith("/say ") ? back[1].slice(5) : `Done: ${back[1]}`;
  if (/finished what you handed over without a user-facing reply|The user went with your version/.test(prompt)) return "<no-reply/>";
  return null;
}

async function coordinatorTurn(thread, turn, text) {
  const state = threads.get(thread);
  if (text.startsWith("(App: You have been idle")) {
    const file = /update (\S+) with/.exec(text)?.[1] ?? ".bot/memory.md";
    const receipt = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: `call_${randomUUID().slice(0, 8)}`, tool: "app_handoff", arguments: { instructions: `FAKE-TIDY ${file}`, name: "Tidy memory" } });
    say(thread, turn, receipt?.success ? "Handed the memory update to a worker." : "Could not hand it over.");
    return complete(thread, turn);
  }
  // A switch of engine (Phase 5c): a worker writes the handoff; the head that takes over reads the
  // memory snapshot it is given and says what it carries on with (OK: nothing).
  if (text.startsWith("(App: The model is about to change")) {
    const file = /section of (\S+?);/.exec(text)?.[1] ?? ".bot/memory.md";
    const receipt = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: `call_${randomUUID().slice(0, 8)}`, tool: "app_handoff", arguments: { instructions: `FAKE-HANDOFF ${file}`, name: "Write handoff" } });
    say(thread, turn, receipt?.success ? "Handed the handoff to a worker." : "Could not hand it over.");
    return complete(thread, turn);
  }
  if (text.startsWith("(App: You just took over with a new model")) {
    const work = /## In progress\n([^#\n][^\n]*)/.exec(text)?.[1];
    say(thread, turn, work ? `Took over: ${work}` : "OK");
    return complete(thread, turn);
  }
  if (text.includes("(App: Now carry on with what you were doing")) {
    await sleep(Number(process.env.FAKE_CODEX_TURN_MS ?? 30));
    say(thread, turn, "Carried on: finished the handed work.");
    return complete(thread, turn);
  }
  const conducted = conductedReply(text);
  if (conducted === SLOW_HANDED) {
    for (let i = 0; !state.turn?.interrupted && !state.turn?.steers.length; i++) {
      say(thread, turn, `working on it ${i}`, "commentary");
      await sleep(40);
    }
    if (state.turn?.interrupted) return complete(thread, turn, "interrupted");
    say(thread, turn, `Answered you: ${state.turn.steers.map((steer) => words(steer).all || steer).join(" | ")}`);
    return complete(thread, turn);
  }
  if (conducted !== null && !conducted.startsWith(WORKER_HANDED)) {
    await sleep(Number(process.env.FAKE_CODEX_TURN_MS ?? 30));
    say(thread, turn, conducted);
    return complete(thread, turn);
  }
  const handedWorker = conducted?.startsWith(WORKER_HANDED) ? conducted.slice(WORKER_HANDED.length) : null;
  const said = words(handedWorker !== null ? `/worker ${handedWorker}` : text);
  const solo = /^\/solo\b\s*/.exec(said.last);
  if (solo) {
    await sleep(Number(process.env.FAKE_CODEX_TURN_MS ?? 30));
    const peer = /this bot's other head, replied in this chat|working on this too, says:/.test(text);
    say(thread, turn, peer ? "<no-reply/>" : `I take it: ${said.last.slice(solo[0].length)}`);
    return complete(thread, turn);
  }
  const match = /^\/(say|slow|tool|worker|component-editor|editor-message|choices|monitor|routine|ratelimit)\b\s*/.exec(said.last);
  const directive = match?.[1] ?? null;
  const rest = match ? said.last.slice(match[0].length) : said.all;
  if (directive === "slow") {
    for (let i = 0; !state.turn?.interrupted; i++) {
      say(thread, turn, `still working ${i}`, "commentary");
      await sleep(40);
    }
    return complete(thread, turn, "interrupted");
  }
  if (directive === "ratelimit") {
    const db = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "logs_2.sqlite") : null;
    const now = Date.now();
    const body = `session_loop{thread_id=${thread}}:run_sampling_request{turn_id=${turn}}: stream disconnected - retrying sampling request (1/5 in 40.000123s)... turn_id=${turn} retries=1 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests`;
    if (db && existsSync(db)) {
      spawnSync("sqlite3", [db, `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) VALUES (${Math.floor(now / 1000)}, ${(now % 1000) * 1_000_000}, 'WARN', 'codex_core::responses_retry', '${body}', '${thread}');`]);
    }
    notify("error", { error: { message: "Reconnecting... 1/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } }, additionalDetails: "exceeded retry limit, last status: 429 Too Many Requests", misalignment: null }, willRetry: true, threadId: thread, turnId: turn });
    const gate = process.env.FAKE_CODEX_RETRY_GATE;
    if (gate) while (!existsSync(gate) && !state.turn?.interrupted) await sleep(25);
    else await sleep(Number(process.env.FAKE_CODEX_TURN_MS ?? 30));
    // The retry went through: a step, then (with a gate) the answer once <gate>.done exists.
    say(thread, turn, "Retried.", "commentary");
    if (gate) while (!existsSync(`${gate}.done`) && !state.turn?.interrupted) await sleep(25);
    if (state.turn?.interrupted) return complete(thread, turn, "interrupted");
    say(thread, turn, rest);
    return complete(thread, turn);
  }
  if (directive === "tool") {
    const command = rest || "echo hi";
    say(thread, turn, "Let me run that.", "commentary");
    const id = `exec-${randomUUID().slice(0, 8)}`;
    item(thread, turn, "started", { type: "commandExecution", id, command: `/bin/zsh -lc '${command}'`, commandActions: [{ type: "unknown", command }], status: "inProgress" });
    const answer = await ask("item/commandExecution/requestApproval", { threadId: thread, turnId: turn, itemId: id, command: `/bin/zsh -lc '${command}'`, reason: "Run it?" });
    if (state.turn?.interrupted) return complete(thread, turn, "interrupted");
    const allowed = answer?.decision === "accept";
    item(thread, turn, "completed", { type: "commandExecution", id, command: `/bin/zsh -lc '${command}'`, commandActions: [{ type: "unknown", command }], status: allowed ? "completed" : "declined", exitCode: allowed ? 0 : null, aggregatedOutput: allowed ? `ran: ${command}` : null });
    say(thread, turn, allowed ? `Allowed: ran ${command}` : "Denied: not run.");
    return complete(thread, turn);
  }
  if (directive === "monitor") {
    const receipt = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: `call_${randomUUID().slice(0, 8)}`, tool: "app_monitor_start", arguments: { command: rest || "echo hi" } });
    const payload = JSON.parse(receipt?.contentItems?.[0]?.text ?? "{}");
    say(thread, turn, receipt?.success ? `Watching it (${payload.status}).` : `Could not: ${payload.error}`);
    return complete(thread, turn);
  }
  if (directive === "routine") {
    let args = {};
    try { args = JSON.parse(rest); } catch { /* none */ }
    const receipt = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: `call_${randomUUID().slice(0, 8)}`, tool: "app_routines", arguments: args });
    say(thread, turn, `${receipt?.success ? "Routines" : "Routines failed"}: ${receipt?.contentItems?.[0]?.text ?? ""}`);
    return complete(thread, turn);
  }
  if (directive === "editor-message") {
    const [task, ...parts] = rest.split(" ");
    await ask("item/tool/call", { threadId: thread, turnId: turn, tool: "app_send_message", arguments: { task_id: task, message: parts.join(" ") } });
    say(thread, turn, "Sent to the same editor.");
    return complete(thread, turn);
  }
  if (directive === "worker" || directive === "component-editor") {
    const receipt = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: `call_${randomUUID().slice(0, 8)}`, tool: "app_handoff", arguments: { ...(directive === "component-editor" ? { role: "component-editor" } : {}), instructions: rest || "Do the work", name: (rest || "Do the work").split("\n")[0].slice(0, 30) } });
    const task = JSON.parse(receipt?.contentItems?.[0]?.text ?? "{}").task_id;
    say(thread, turn, task ? "A worker has it." : `The hand-off failed: ${receipt?.contentItems?.[0]?.text ?? ""}`);
    return complete(thread, turn);
  }
  const reply = directive === "say" ? rest
    : directive === "choices" ? "Which way?\n<choices>\n* Fast | done today\n- Slow | costs a week\n</choices>"
    : `Codex says: ${rest}`;
  // A steer that came while it "thought" joins the answer, as Codex's would.
  await sleep(Number(process.env.FAKE_CODEX_TURN_MS ?? 30));
  const steers = state.turn?.steers ?? [];
  say(thread, turn, steers.length ? `${reply} (also heard: ${steers.map((s) => words(s).all || s).join(" | ")})` : reply);
  return complete(thread, turn);
}

async function reportTurn(thread, turn, output) {
  let result = {};
  try { result = JSON.parse(output); } catch { /* not JSON */ }
  log(thread, "report", output);
  if (!String(result.report ?? "").includes("/nocheckpoint")) {
    await ask("item/tool/call", { threadId: thread, turnId: turn, callId: `call_${randomUUID().slice(0, 8)}`, tool: "app_task_checkpoint", arguments: { task_id: result.task_id, outcome: result.status === "completed" ? "complete" : "blocked", evidence: result.report || "no report" } });
  }
  say(thread, turn, String(result.name) === "Tidy memory" || String(result.name) === "Write handoff" ? "OK" : `The worker ${result.status === "completed" ? "finished" : "stopped"}: ${result.report}`);
  complete(thread, turn);
}

async function workerTurn(thread, turn, text) {
  const state = threads.get(thread);
  if (text.startsWith("FAKE-HANDOFF ")) {
    const file = text.slice("FAKE-HANDOFF ".length).trim();
    const path = safeWritePath(file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `## Current status\nHanded over by the fake Codex worker.\n## In progress\n${process.env.FAKE_HANDOFF_WORK ?? "Finish the parser."}\n## Waiting on you\n## Decided\n`);
    say(thread, turn, `Wrote ${file}.`);
    return complete(thread, turn);
  }
  if (text.startsWith("FAKE-TIDY ")) {
    const file = text.slice("FAKE-TIDY ".length).trim();
    const path = safeWritePath(file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "## Current status\nTidied by the fake Codex worker.\n## In progress\n## Waiting on you\n## Decided\n");
    say(thread, turn, `Wrote ${file}.`);
    return complete(thread, turn);
  }
  const id = `exec-${randomUUID().slice(0, 8)}`;
  item(thread, turn, "started", { type: "commandExecution", id, command: "/bin/zsh -lc 'ls'", commandActions: [{ type: "listFiles", command: "ls" }], status: "inProgress" });
  item(thread, turn, "completed", { type: "commandExecution", id, command: "/bin/zsh -lc 'ls'", commandActions: [{ type: "listFiles", command: "ls" }], status: "completed", exitCode: 0, aggregatedOutput: "a.txt\n" });
  say(thread, turn, "Looking into it.", "commentary");
  if (text.includes("/slowworker")) {
    while (!state.turn?.interrupted) await sleep(40);
    return complete(thread, turn, "interrupted");
  }
  if (workerGate) while (!existsSync(workerGate) && !state.turn?.interrupted) await sleep(20);
  else await sleep(workerMs);
  if (state.turn?.interrupted) return complete(thread, turn, "interrupted");
  if (text.includes("/failworker")) return complete(thread, turn, "failed", { message: "The worker hit an error." });
  const steers = state.turn?.steers ?? [];
  say(thread, turn, `Worker did: ${text.split("\n")[0]}${steers.length ? ` (and: ${steers.join(" | ")})` : ""}`);
  complete(thread, turn);
}

function startTurn(rpcId, params) {
  const thread = params.threadId;
  const state = threads.get(thread);
  if (!state) return out({ id: rpcId, error: { code: -32600, message: `no thread ${thread}` } });
  if (state.turn) return out({ id: rpcId, error: { code: -32600, message: "a turn is already running" } });
  const turn = randomUUID();
  state.turn = { id: turn, interrupted: false, steers: [] };
  out({ id: rpcId, result: { turn: { id: turn, status: "inProgress", items: [] } } });
  notify("turn/started", { threadId: thread, turn: { id: turn, status: "inProgress", items: [] } });
  const text = (params.input ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  if (params.toolOutput?.name === "app_monitor_result") {
    log(thread, "monitor-result", params.toolOutput.output);
    void (async () => {
      let result = {};
      try { result = JSON.parse(params.toolOutput.output); } catch { /* not JSON */ }
      await sleep(20);
      say(thread, turn, `Monitor ${result.status}, exit ${result.exit_code}: ${String(result.stdout ?? "").trim()}`);
      complete(thread, turn);
    })();
    return;
  }
  if (params.toolOutput) {
    void reportTurn(thread, turn, params.toolOutput.output);
    return;
  }
  log(thread, state.coordinator ? "turn" : "worker", text);
  const images = (params.input ?? []).filter((part) => part?.type === "localImage").map((part) => part.path);
  if (images.length) log(thread, "images", images.join("\n"));
  void (state.coordinator ? coordinatorTurn(thread, turn, text) : workerTurn(thread, turn, text));
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  if (method === undefined && id !== undefined) {
    const resolve = waiting.get(id);
    waiting.delete(id);
    resolve?.(message.result ?? null);
    return;
  }
  switch (method) {
    case "initialize":
      return out({ id, result: { userAgent: "claudecodebot/0.163.0-fake", platformFamily: "unix", platformOs: "macos" } });
    case "initialized":
      return;
    case "model/list":
      return out({ id, result: { data: [
        { id: "gpt-6-luna", displayName: "GPT-6 Luna", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
        { id: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: false, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }] },
        { id: "secret", displayName: "Hidden", isDefault: false, hidden: true },
      ] } });
    case "thread/start": {
      const thread = randomUUID();
      const coordinator = !coordinatorSeen && Array.isArray(params.dynamicTools);
      if (coordinator) coordinatorSeen = true;
      threads.set(thread, { coordinator: coordinator || (!coordinatorSeen && !params.dynamicTools && threads.size === 0), instructions: params.developerInstructions ?? "", turn: null });
      log(thread, coordinator ? "coordinator-start" : "worker-start", JSON.stringify({ sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, config: params.config ?? null, tools: (params.dynamicTools ?? []).map((t) => t.name) }));
      return out({ id, result: { thread: { id: thread, cwd: params.cwd, status: { type: "idle" } }, model: params.model ?? "fake-codex" } });
    }
    case "thread/resume": {
      if (process.env.FAKE_CODEX_FORGET === "1") return out({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
      const known = threads.get(params.threadId);
      if (!known) threads.set(params.threadId, { coordinator: !coordinatorSeen, instructions: params.developerInstructions ?? "", turn: null });
      if (!coordinatorSeen) coordinatorSeen = true;
      log(params.threadId, "resume", "");
      return out({ id, result: { thread: { id: params.threadId, status: { type: "idle" } } } });
    }
    case "thread/inject_items":
      return out({ id, result: {} });
    case "turn/start":
      return startTurn(id, params);
    case "turn/steer": {
      const state = threads.get(params.threadId);
      if (!state?.turn || state.turn.id !== params.expectedTurnId) return out({ id, error: { code: -32600, message: "no such active turn" } });
      const text = (params.input ?? []).map((part) => part.text).join("\n");
      state.turn.steers.push(text);
      log(params.threadId, "steer", text);
      return out({ id, result: { turnId: state.turn.id } });
    }
    case "command/exec": {
      // Runs it for real, as app-server does (without its sandbox: tests run harmless commands).
      log("", "exec", JSON.stringify({ command: params.command, cwd: params.cwd, sandboxPolicy: params.sandboxPolicy, processId: params.processId, outputBytesCap: params.outputBytesCap }));
      const [file, ...rest] = params.command ?? [];
      const child = spawn(file, rest, { cwd: params.cwd, stdio: ["ignore", "pipe", "pipe"] });
      execs.set(params.processId, child);
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { execs.delete(params.processId); out({ id, error: { code: -32000, message: error.message } }); });
      child.on("close", (code, signal) => {
        execs.delete(params.processId);
        out({ id, result: { exitCode: code ?? (signal ? 137 : null), stdout: stdout.slice(0, params.outputBytesCap ?? 8192), stderr: stderr.slice(0, params.outputBytesCap ?? 8192) } });
      });
      return;
    }
    case "command/exec/terminate": {
      execs.get(params.processId)?.kill("SIGTERM");
      return out({ id, result: {} });
    }
    case "turn/interrupt": {
      const state = threads.get(params.threadId);
      if (state?.turn?.id === params.turnId) {
        state.turn.interrupted = true;
        for (const [key, resolve] of waiting) { waiting.delete(key); resolve(null); }
      }
      return out({ id, result: {} });
    }
    default:
      return out({ id, error: { code: -32601, message: `fake codex does not know ${method}` } });
  }
});
lines.on("close", () => { closed = true; for (const child of execs.values()) child.kill("SIGKILL"); setTimeout(() => process.exit(0), 50); });
void closed;
